// The Renovate source (ADR 0003): the `renovate` the container image pins,
// run against the read-only checkout on the local platform at the `lookup`
// dry-run level, with its candidates read from the report file it writes.
// The flags, the global config and the parsing rules are the ones the spike
// settled (docs/research/renovate-extraction-spike.md).
//
// Renovate gets no GitHub credential. Its environment is built from an allow
// list rather than the engine's own, and the global config turns off the
// datasources that would call GitHub anyway, so every Action and every other
// GitHub-served dependency comes back skipped and is left to another source.
//
// Both the report and the local platform are experimental upstream, so the
// parser's test runs against a report recorded from the pinned version, and a
// pin bump re-records it (templates/container/Dockerfile).

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkKindRunCtx } from "../../../src/work-kinds/definition.ts";
import type { Candidate, DepType, UpdateType } from "../candidate.ts";
import type { SourceResult } from "./source.ts";

/** The name the detectors' `sources` option lists this source by. */
export const RENOVATE_SOURCE_NAME = "renovate";

/**
 * Whether the detectors run this source when `sources` is not set. On: the
 * spike passed with the install the container template carries.
 */
export const RENOVATE_ON_BY_DEFAULT = true;

/** 20 minutes. `JesusFilm/core` took about a minute in the spike. */
export const RENOVATE_TIMEOUT_MS = 20 * 60_000;

/** How long Renovate gets to exit after SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 10_000;

/** Files the source writes in scratch: Renovate's config, its report and its log. */
export const RENOVATE_CONFIG_FILE = "renovate-global-config.json";
export const RENOVATE_REPORT_FILE = "renovate-report.json";
export const RENOVATE_LOG_FILE = "renovate.log";

/** The datasources that reach GitHub, which a credential-free run must not look up. */
const GITHUB_DATASOURCES = [
  "github-digest",
  "github-tags",
  "github-releases",
  "github-release-attachments",
  "github-runners",
] as const;

/**
 * Renovate's global config. The `packageRules` entry is what keeps the run off
 * GitHub; it is a default, and a repository's own `packageRules` can turn a
 * datasource back on. The remap exists because Renovate's `engines` field does
 * not accept the image's Node 26, and its version check otherwise logs an
 * error, which makes Renovate exit 1 after a complete run.
 */
export const RENOVATE_GLOBAL_CONFIG = {
  logLevelRemap: [{ matchMessage: "Unsupported node environment detected*", newLogLevel: "warn" }],
  packageRules: [{ matchDatasources: [...GITHUB_DATASOURCES], enabled: false }],
};

/** Renovate's bunyan level for error; `problems` carries warnings (40) too. */
const ERROR_LEVEL = 50;

/** The engine variables Renovate inherits. Nothing else, so no token can ride along. */
const INHERITED_ENV = ["PATH", "HOME"] as const;

/** The part of a kind's run context this source reaches. */
export type RenovateSourceCtx = Pick<WorkKindRunCtx, "workspace" | "log" | "env" | "signal">;

export type RenovateSourceOptions = {
  timeoutMs?: number;
  /** The executable to run; tests point it at a script. */
  command?: string;
};

/** What Renovate did not look up, and why. */
export type RenovateCoverage = {
  lookedUp: number;
  /** Dependencies Renovate skipped, by `skipReason`. */
  skipped: Record<string, number>;
  /** Dependencies whose lookup failed: no `registryUrl`, or a `warnings` entry. */
  failed: number;
  /** Proposals with an update type the contract has no word for, by that type. */
  unmapped: Record<string, number>;
};

export type ParsedReport =
  | { ok: true; candidates: Candidate[]; coverage: RenovateCoverage }
  | { ok: false; problem: string };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Json, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

const DEP_TYPE_BY_NAME: Record<string, DepType> = {
  devDependencies: "dev",
  "dev-dependencies": "dev",
  dev: "dev",
  "dev-packages": "dev",
  "require-dev": "dev",
  optionalDependencies: "optional",
  peerDependencies: "peer",
};

/**
 * Renovate's `depType` is the manager's own word — `devDependencies` for npm,
 * `dev-dependencies` for Cargo, `final` for a Dockerfile, `action` for a
 * workflow. Anything not named as dev, optional or peer is a production
 * dependency.
 */
function depType(renovateDepType: string | undefined): DepType {
  return (renovateDepType !== undefined && DEP_TYPE_BY_NAME[renovateDepType]) || "prod";
}

/**
 * The npm manager's `depType` for an entry that overrides a package other
 * packages pull in, not one a manifest declares: `overrides` in `package.json`,
 * `pnpm.overrides`, `overrides` in `pnpm-workspace.yaml`, and yarn
 * `resolutions`. Read from Renovate's own list of npm dependency types.
 */
const OVERRIDE_DEP_TYPES: ReadonlySet<string> = new Set([
  "overrides",
  "pnpm.overrides",
  "pnpm-workspace.overrides",
  "resolutions",
]);

/**
 * The contract's update type for one of Renovate's proposals, or null for one
 * it has no word for (`rollback`, `replacement`, `bump`, `lockFileMaintenance`).
 * An in-range move Renovate makes in the lockfile alone is `lockfile` whatever
 * size Renovate gives it.
 */
function updateType(update: Json): UpdateType | null {
  const type = str(update, "updateType");
  if (update["isLockfileUpdate"] === true || type === "lockfileUpdate") return "lockfile";
  if (type === "major" || type === "minor" || type === "patch" || type === "pin") return type;
  if (type === "digest" || type === "pinDigest") return "digest";
  return null;
}

/**
 * One proposal as a candidate. A digest move names its digests; a pin names
 * the range it replaces; anything else names versions, which for a Docker tag
 * is the version Renovate reads out of it (`22.11.0` from
 * `22.11.0-bookworm-slim`).
 */
function candidateFor(
  manager: string,
  packageFile: string,
  dep: Json,
  update: Json,
  type: UpdateType,
): Candidate | null {
  const pkg = str(dep, "packageName") ?? str(dep, "depName");
  const version = str(dep, "currentVersion") ?? str(dep, "currentValue");
  let current: string | undefined;
  let target: string | undefined;
  if (type === "digest") {
    current = str(dep, "currentDigest") ?? version;
    target = str(update, "newDigest");
  } else if (type === "pin") {
    current = str(dep, "currentValue") ?? version;
    target = str(update, "newVersion") ?? str(update, "newValue");
  } else {
    current = version;
    target = str(update, "newVersion") ?? str(update, "newValue");
  }
  if (pkg === undefined || current === undefined || target === undefined) return null;
  const renovateDepType = str(dep, "depType");
  const candidate: Candidate = {
    manager,
    package: pkg,
    current,
    target,
    updateType: type,
    depType: depType(renovateDepType),
    workspace: packageFile,
    advisories: [],
    peers: [],
  };
  if (
    manager === "npm" &&
    renovateDepType !== undefined &&
    OVERRIDE_DEP_TYPES.has(renovateDepType)
  ) {
    candidate.override = true;
  }
  const publishedAt = str(update, "releaseTimestamp");
  if (publishedAt !== undefined) candidate.publishedAt = publishedAt;
  const repositoryUrl = str(dep, "sourceUrl");
  if (repositoryUrl !== undefined) candidate.repositoryUrl = repositoryUrl;
  return candidate;
}

/**
 * Read a Renovate report into candidates. Everything lives under
 * `repositories.local`, the one repository the local platform runs. A
 * dependency was looked up when it has a `registryUrl` and no `warnings`, and
 * only those yield candidates, one per entry in `updates`. A skipped
 * dependency (`github-token-required`, `disabled`) is counted, not proposed.
 *
 * Only an error-level entry in `repositories.local.problems` fails the report.
 * The warnings a credential-free run always logs there ("GitHub token is
 * required", "Unknown error fetching default owner preset"), and the remapped
 * Node version warning in the top-level `problems`, do not.
 */
export function parseRenovateReport(text: string): ParsedReport {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: `the report is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const repositories = isRecord(report) ? report["repositories"] : undefined;
  const local = isRecord(repositories) ? repositories["local"] : undefined;
  if (!isRecord(local)) return { ok: false, problem: "the report has no repositories.local" };
  const packageFiles = local["packageFiles"];
  if (!isRecord(packageFiles)) {
    return { ok: false, problem: "the report has no repositories.local.packageFiles" };
  }

  const problems = Array.isArray(local["problems"]) ? local["problems"] : [];
  const errors = problems.filter(
    (entry) =>
      isRecord(entry) && typeof entry["level"] === "number" && entry["level"] >= ERROR_LEVEL,
  ) as Json[];
  if (errors.length > 0) {
    const messages = errors.map((entry) => str(entry, "msg") ?? "(no message)");
    return {
      ok: false,
      problem: `renovate logged ${errors.length} error(s): ${messages.join("; ")}`,
    };
  }

  const candidates: Candidate[] = [];
  const coverage: RenovateCoverage = { lookedUp: 0, skipped: {}, failed: 0, unmapped: {} };
  for (const [manager, files] of Object.entries(packageFiles)) {
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (!isRecord(file) || !Array.isArray(file["deps"])) continue;
      const packageFile = str(file, "packageFile");
      if (packageFile === undefined) continue;
      for (const dep of file["deps"]) {
        if (!isRecord(dep)) continue;
        const skipReason = str(dep, "skipReason");
        if (skipReason !== undefined) {
          bump(coverage.skipped, skipReason);
          continue;
        }
        const warnings = dep["warnings"];
        if (
          str(dep, "registryUrl") === undefined ||
          (Array.isArray(warnings) && warnings.length > 0)
        ) {
          coverage.failed += 1;
          continue;
        }
        coverage.lookedUp += 1;
        const updates = Array.isArray(dep["updates"]) ? dep["updates"] : [];
        for (const update of updates) {
          if (!isRecord(update)) continue;
          const type = updateType(update);
          if (type === null) {
            bump(coverage.unmapped, str(update, "updateType") ?? "unknown");
            continue;
          }
          const candidate = candidateFor(manager, packageFile, dep, update, type);
          if (candidate === null) bump(coverage.unmapped, type);
          else candidates.push(candidate);
        }
      }
    }
  }
  return { ok: true, candidates, coverage };
}

function counted(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, n]) => `${key} ${n}`)
    .join(", ");
}

/** One line saying what the run covered and what it left to other sources. */
export function describeCoverage(candidates: number, coverage: RenovateCoverage): string {
  const parts = [
    `renovate source: ${candidates} candidate(s) from ${coverage.lookedUp} looked-up dependencies`,
  ];
  if (Object.keys(coverage.skipped).length > 0) parts.push(`skipped ${counted(coverage.skipped)}`);
  if (coverage.failed > 0) parts.push(`${coverage.failed} lookup(s) failed`);
  if (Object.keys(coverage.unmapped).length > 0) {
    parts.push(`dropped proposals ${counted(coverage.unmapped)}`);
  }
  return `${parts.join("; ")}.`;
}

type Exit =
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "timed-out" }
  | { kind: "aborted" }
  | { kind: "spawn-failed"; message: string };

/**
 * Run Renovate to completion, or kill it at the deadline. It runs in its own
 * process group so a timeout also stops the git and package-manager children
 * it starts. Output goes to a log file rather than a pipe, so a child that
 * outlives Renovate cannot hold the run open.
 */
function runRenovate(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}): Promise<Exit> {
  return new Promise((resolve) => {
    const logFd = openSync(opts.logPath, "w");
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    closeSync(logFd);

    let stopped: "timed-out" | "aborted" | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    const stop = (why: "timed-out" | "aborted"): void => {
      if (stopped !== null) return;
      stopped = why;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const deadline = setTimeout(() => stop("timed-out"), opts.timeoutMs);
    const onAbort = (): void => stop("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) stop("aborted");

    const settle = (exit: Exit): void => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(exit);
    };
    child.once("error", (error) => settle({ kind: "spawn-failed", message: error.message }));
    child.once("exit", (code, signal) => {
      // Anything Renovate left running goes with it.
      killGroup("SIGKILL");
      settle(stopped !== null ? { kind: stopped } : { kind: "exited", code, signal });
    });
  });
}

/** The message of the last error-level line in Renovate's JSON log, if any. */
function lastLoggedError(logPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return undefined;
  }
  let last: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const record = JSON.parse(line) as unknown;
      if (
        isRecord(record) &&
        typeof record["level"] === "number" &&
        record["level"] >= ERROR_LEVEL
      ) {
        last = str(record, "msg") ?? last;
      }
    } catch {
      // Not a log record.
    }
  }
  return last;
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return Number.isInteger(m) ? `${m}m` : `${ms}ms`;
}

/**
 * Run Renovate over the checkout and return its candidates. Every way this
 * can go wrong — Renovate missing, a non-zero exit, the deadline, no report,
 * a report that does not parse or carries an error — is logged and returned
 * as a failed source, never thrown.
 */
export async function runRenovateSource(
  ctx: RenovateSourceCtx,
  opts: RenovateSourceOptions = {},
): Promise<SourceResult> {
  const timeoutMs = opts.timeoutMs ?? RENOVATE_TIMEOUT_MS;
  const scratch = ctx.workspace.scratch;
  const configPath = join(scratch, RENOVATE_CONFIG_FILE);
  const reportPath = join(scratch, RENOVATE_REPORT_FILE);
  const logPath = join(scratch, RENOVATE_LOG_FILE);

  const fail = (problem: string): SourceResult => {
    const logged = lastLoggedError(logPath);
    ctx.log(
      `renovate source failed: ${problem}.` +
        (logged !== undefined ? ` Last error logged: ${logged}.` : "") +
        ` Log: ${logPath}`,
    );
    return { ok: false, problem };
  };

  let exit: Exit;
  try {
    rmSync(reportPath, { force: true });
    rmSync(logPath, { force: true });
    writeFileSync(configPath, `${JSON.stringify(RENOVATE_GLOBAL_CONFIG, null, 2)}\n`);
    const env: NodeJS.ProcessEnv = {};
    for (const name of INHERITED_ENV) {
      if (ctx.env[name] !== undefined) env[name] = ctx.env[name];
    }
    Object.assign(env, {
      LOG_FORMAT: "json",
      LOG_LEVEL: "info",
      RENOVATE_CONFIG_FILE: configPath,
      RENOVATE_BASE_DIR: join(scratch, "renovate"),
    });
    exit = await runRenovate({
      command: opts.command ?? "renovate",
      args: [
        "--platform=local",
        "--dry-run=lookup",
        "--report-type=file",
        `--report-path=${reportPath}`,
      ],
      cwd: ctx.workspace.dir,
      env,
      logPath,
      timeoutMs,
      signal: ctx.signal,
    });
  } catch (error) {
    return fail(
      `could not start renovate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  switch (exit.kind) {
    case "spawn-failed":
      return fail(`could not start renovate (${exit.message}); the container template installs it`);
    case "timed-out":
      return fail(`renovate did not finish within ${minutes(timeoutMs)}`);
    case "aborted":
      return fail("the run was aborted before renovate finished");
    case "exited":
      if (exit.code !== 0) {
        return fail(
          exit.code === null
            ? `renovate was killed by ${exit.signal}`
            : `renovate exited ${exit.code}`,
        );
      }
  }

  if (!existsSync(reportPath))
    return fail(`renovate exited 0 but wrote no report at ${reportPath}`);
  const parsed = parseRenovateReport(readFileSync(reportPath, "utf8"));
  if (!parsed.ok) return fail(parsed.problem);
  ctx.log(describeCoverage(parsed.candidates.length, parsed.coverage));
  return { ok: true, candidates: parsed.candidates };
}
