// `phoebe doctor` — the deployment health panel. Report-only in v1: `upgrade`
// moves you between versions; `doctor` tells you whether the version you are on
// is actually working. (A `--fix` mode that repairs at the current pin is a
// mapped follow-up.)
//
// Seven deployment checks, all reads of state that already exists (an eighth,
// `stale-state`, is per tenant and lives in the tenant sweep below):
//   1. cli            — installed bootstrapper vs the npm registry's latest
//   2. engine         — configured pin vs the latest release tag, plus the commit
//                       actually materialized in the engine checkout
//   3. config         — the root phoebe.config.ts loads and its engine field parses
//   4. repo           — the engine repo answers ls-remote with the current GH_TOKEN
//   5. crash-loop     — whether the deployment is silently running last-known-good
//                       (the single most confusing failure mode this system has)
//   6. supervisor     — is `phoebe boot` actually the container's main process
//   7. launcher-floor — is the launcher at or above the engine's declared minBootstrap
//                       floor? A violation deadlocks the deployment outright, not
//                       merely slows it — the two checks are not the same thing.
//
// A tenant's scheduled work kinds may declare env keys of their own (#425);
// doctor reports a missing one as a tenant finding, ahead of the engine child
// refusing to boot on it.
//
// In workspace mode it also sweeps tenants — the same enumeration boot
// supervises with (#91/#154), so doctor can never report a different fleet from
// the one that is running. Per tenant: is a GH_TOKEN present the way the child
// would read it, does the tenant repo answer to it, and — the one check that
// reads the data volume rather than the tracker — is there state under
// `/data/repos` that no pipeline row owns (#426, warn-only). The full
// five-permission grant probe stays in scripts/verify-tenant-token.mjs (it ships
// with the repo, not the package); doctor's per-tenant probe is the
// reachability slice of it.

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  CRASH_LOOP_THRESHOLD,
  crashLoopStatePath,
  readCrashLoopState,
  type CrashLoopState,
} from "../bootstrap/crash-loop.ts";
import { type CredentialArm, resolveCredentialArm } from "../bootstrap/credential-arm.ts";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import { readEngineSource, type ResolvedEngineSource } from "../bootstrap/engine-source.ts";
import {
  buildAuthenticatedRepoUrl,
  githubEngineDir,
  LS_REMOTE_TIMEOUT_MS,
} from "../bootstrap/github-engine.ts";
import { TENANT_CONFIG_FILE } from "../bootstrap/tenants.ts";
import { isInsideContainer } from "./execution-gate.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import { loadUserConfig } from "./load-config.ts";
import {
  latestReleaseTag,
  installedCliVersion,
  latestCliVersion,
  type NpmRunner,
  defaultNpm,
  redactToken,
  releaseVersion,
  compareVersions,
  readDockerfilePin,
} from "./upgrade.ts";
import {
  CONFIG_DEFAULTS,
  DEFAULT_PIPELINE_NAME,
  DEFAULT_PROMPT_FILE_BY_KIND,
  resolveConfig,
} from "./config-schema.ts";
import { resolveDataBase } from "./paths.ts";
import { enumerateDeclaredEnv } from "./pipeline-enumerate.ts";
import {
  createWorktreeInspector,
  hasTenantData,
  pipelineOwnership,
  scanStaleState,
  tenantDataDir,
  type StaleItem,
} from "./stale-state.ts";
import { enumerateWorkspaceTenants } from "./tenant-commands.ts";

/** A scheduled kind's declared key that its pipeline's env does not hold (#425). */
export type MissingDeclaredEnvKey = { pipeline: string; kind: string; key: string };

export type CheckState = "ok" | "warn" | "fail" | "unknown";

export type DoctorCheck = {
  id: string;
  state: CheckState;
  detail: string;
};

export type TenantDoctorRow = {
  path: string;
  slug: string | null;
  checks: DoctorCheck[];
};

export type DoctorReport = {
  checks: DoctorCheck[];
  tenants: TenantDoctorRow[];
  /** False when any deployment or tenant check failed. */
  ok: boolean;
};

/** Fold every check into the report verdict. Pure, for tests. */
export function buildDoctorReport(checks: DoctorCheck[], tenants: TenantDoctorRow[]): DoctorReport {
  const failed = (list: DoctorCheck[]) => list.some((check) => check.state === "fail");
  return {
    checks,
    tenants,
    ok: !failed(checks) && !tenants.some((tenant) => failed(tenant.checks)),
  };
}

/**
 * Read the crash-loop record into a check. A quarantine in force means the
 * container is serving last-known-good code, not what the config names — worth
 * a loud warn even though nothing is "broken" (the guard is doing its job).
 */
export function crashLoopCheck(
  state: CrashLoopState,
  threshold = CRASH_LOOP_THRESHOLD,
): DoctorCheck {
  if (state.failingSha !== null && state.failureCount >= threshold) {
    return {
      id: "crash-loop",
      state: "warn",
      detail:
        `commit ${state.failingSha.slice(0, 12)} is quarantined after ${state.failureCount} fast ` +
        `crashes — the engine is running last-good ${state.lastGoodSha?.slice(0, 12) ?? "(none)"}, ` +
        `NOT the tracked ref's tip, until the ref moves past the bad commit`,
    };
  }
  if (state.failingSha !== null) {
    return {
      id: "crash-loop",
      state: "warn",
      detail:
        `commit ${state.failingSha.slice(0, 12)} has ${state.failureCount} fast crash(es) recorded ` +
        `(quarantine at ${threshold})`,
    };
  }
  return {
    id: "crash-loop",
    state: "ok",
    detail:
      state.lastGoodSha !== null
        ? `no quarantine; last-good fallback target is ${state.lastGoodSha.slice(0, 12)}`
        : "no quarantine (no fallback target recorded yet)",
  };
}

/** Parse a bare semver string ("0.5.0") into [major, minor, patch]. */
function parseBareVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Read `phoebe.minBootstrap` from the materialized engine checkout's
 * `package.json`. Returns null when the checkout, the file, or the field is
 * absent — all three map to "no floor declared", not "check failed".
 */
function readMinBootstrap(engineDir: string): string | null {
  try {
    const raw = readFileSync(join(engineDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as unknown;
    if (typeof pkg !== "object" || pkg === null) return null;
    const phoebe = (pkg as Record<string, unknown>)["phoebe"];
    if (typeof phoebe !== "object" || phoebe === null) return null;
    const floor = (phoebe as Record<string, unknown>)["minBootstrap"];
    if (typeof floor !== "string" || !/^\d+\.\d+\.\d+/.test(floor)) return null;
    return floor;
  } catch {
    return null;
  }
}

/**
 * Check whether the effective launcher version meets the engine's declared
 * `phoebe.minBootstrap` floor. A floor violation deadlocks the deployment
 * outright — no work runs until the launcher is updated. Pure, for tests.
 *
 * `minBootstrap === null` means no floor is declared (the engine predates
 * #293, or no checkout is materialized yet); the check reports "does not
 * apply" rather than passing silently, matching the local-mount engine check.
 */
export function launcherFloorCheck(fields: {
  /** null when no floor is declared or the checkout is not yet materialized. */
  minBootstrap: string | null;
  /** null when the launcher version cannot be determined. */
  launcherVersion: string | null;
  launcherSource: "dockerfile" | "npm-global" | "unknown";
}): DoctorCheck {
  if (fields.minBootstrap === null) {
    return {
      id: "launcher-floor",
      state: "ok",
      detail: "no floor declared — check does not apply (engine predates minBootstrap)",
    };
  }
  if (fields.launcherVersion === null) {
    const why =
      fields.launcherSource === "dockerfile"
        ? "Dockerfile has no ARG PHOEBE_AGENT_VERSION pin"
        : fields.launcherSource === "npm-global"
          ? "phoebe-agent is not installed globally here"
          : "launcher version is not readable";
    return {
      id: "launcher-floor",
      state: "unknown",
      detail: `engine floor is ${fields.minBootstrap} but the launcher version is unknown — ${why}`,
    };
  }
  const floor = parseBareVersion(fields.minBootstrap);
  const actual = parseBareVersion(fields.launcherVersion);
  if (floor === null || actual === null) {
    return {
      id: "launcher-floor",
      state: "unknown",
      detail: `could not compare versions — floor: ${fields.minBootstrap}, launcher: ${fields.launcherVersion}`,
    };
  }
  if (compareVersions(actual, floor) < 0) {
    const fix =
      fields.launcherSource === "dockerfile"
        ? `set \`ARG PHOEBE_AGENT_VERSION=${fields.minBootstrap}\` in container/Dockerfile and rebuild the image`
        : `run \`npm install -g phoebe-agent@${fields.minBootstrap}\` and restart`;
    return {
      id: "launcher-floor",
      state: "fail",
      detail:
        `launcher ${fields.launcherVersion} is below the engine floor ${fields.minBootstrap} — ` +
        `this is not a staleness warning: the deployment does no work in this state. Fix: ${fix}`,
    };
  }
  return {
    id: "launcher-floor",
    state: "ok",
    detail: `launcher ${fields.launcherVersion} meets the engine floor ${fields.minBootstrap}`,
  };
}

/** Same default as boot.ts `engineBaseDir` — where github engine clones live. */
function engineBaseDir(env: NodeJS.ProcessEnv): string {
  return env["PHOEBE_ENGINE_DIR"] ?? join(tmpdir(), "phoebe-agent");
}

type DoctorDeps = {
  configDir: string;
  env: NodeJS.ProcessEnv;
  git?: GitRunner;
  npm?: NpmRunner;
  fetchFn?: typeof fetch;
};

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Classify a repo-probe status. Only 401/403/404 are token verdicts — a 429 or
 * a 5xx says GitHub is rate-limiting or down, and blaming the token for those
 * would send an operator off to re-mint a credential that is fine. Pure, for
 * tests.
 */
export function describeRepoProbe(status: number, slug: string): { ok: boolean; detail: string } {
  if (status === 200) return { ok: true, detail: "reachable with this token (HTTP 200)" };
  if (status === 401 || status === 403 || status === 404) {
    return {
      ok: false,
      detail:
        `HTTP ${status} from GET /repos/${slug} — the token cannot see the repo. ` +
        `Run node scripts/verify-tenant-token.mjs for the per-permission diagnosis`,
    };
  }
  return {
    ok: false,
    detail:
      `HTTP ${status} from GET /repos/${slug} — not a token verdict ` +
      `(rate limiting or a GitHub outage?); retry before re-minting anything`,
  };
}

/**
 * Fetch all label names for a repo via `GET /repos/{slug}/labels`. Returns the
 * full list on success, or `null` when the request fails or is denied. A non-200
 * response means the token lacks Issues:read — map that to `unknown` rather than
 * reporting labels as missing and emitting a spurious `gh label create` fix.
 * Paginates up to 5 pages (500 labels) to handle repos with many labels.
 */
export async function fetchRepoLabels(
  slug: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<string[] | null> {
  const names: string[] = [];
  for (let page = 1; page <= 5; page++) {
    let res: Response;
    try {
      res = await fetchFn(`https://api.github.com/repos/${slug}/labels?per_page=100&page=${page}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "phoebe-doctor",
          authorization: `Bearer ${token}`,
        },
      });
    } catch {
      return null;
    }
    if (res.status !== 200) return null;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return null;
    const pageNames = (body as unknown[])
      .filter(
        (item): item is { name: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>)["name"] === "string",
      )
      .map((item) => item.name);
    names.push(...pageNames);
    if (pageNames.length < 100) break;
  }
  return names;
}

/**
 * Verify that `readyLabel`, `processingLabel`, and `prOptOutLabel` exist in
 * the tenant's repo. Fails and names each missing label with the exact
 * `gh label create` command to fix it. Pure, for tests.
 */
export function labelsCheck(fields: {
  /** Label names confirmed absent from the repo. */
  missing: string[];
  /** Label names confirmed present in the repo. */
  present: string[];
  /** `owner/repo` slug, used to name the fix command's `--repo` flag. */
  slug: string;
}): DoctorCheck {
  if (fields.missing.length === 0) {
    return {
      id: "labels",
      state: "ok",
      detail: `readyLabel, processingLabel, and prOptOutLabel all exist in ${fields.slug}`,
    };
  }
  const fixes = fields.missing
    .map((name) => `gh label create ${JSON.stringify(name)} --repo ${fields.slug}`)
    .join("  ");
  return {
    id: "labels",
    state: "fail",
    detail: `label(s) missing from ${fields.slug}: ${fields.missing.join(", ")}. Fix: ${fixes}`,
  };
}

/**
 * Warn when a tenant has overridden `promptFiles.issue` with a vendored file
 * that lacks the blocker-recording rule added in #368. When a blocked issue
 * has no such rule, the agent burns runs and quarantines instead of parking.
 *
 * Skips entirely when the tenant uses the shipped default prompt. Passes when
 * the vendored file contains "blocked by" (case-insensitive) — the phrase the
 * agent must write to the issue body, stable enough that a reworded-but-correct
 * prompt still passes. Pure, for tests.
 */
export function promptDriftCheck(fields: {
  /** The tenant's effective promptFiles.issue path. */
  issuePromptPath: string;
  /** The shipped default promptFiles.issue path. */
  defaultIssuePromptPath: string;
  /**
   * Content of the vendored file. `null` when the file cannot be read, or
   * when the path equals the default (skip the check entirely in that case).
   */
  promptContent: string | null;
}): DoctorCheck {
  if (fields.issuePromptPath === fields.defaultIssuePromptPath) {
    return {
      id: "prompt-drift",
      state: "ok",
      detail: "issues prompt: using the shipped default",
    };
  }
  if (fields.promptContent === null) {
    return {
      id: "prompt-drift",
      state: "warn",
      detail:
        `vendored issues prompt at ${fields.issuePromptPath} could not be read — ` +
        `verify the file exists and is readable`,
    };
  }
  // Key on "blocked by" (the phrase the agent writes to the issue body) rather
  // than exact prose — any correctly-updated prompt will include this phrase.
  const hasBlockerRule = /\bblocked\s+by\b/i.test(fields.promptContent);
  if (hasBlockerRule) {
    return {
      id: "prompt-drift",
      state: "ok",
      detail: `vendored issues prompt at ${fields.issuePromptPath} includes a blocker-recording rule`,
    };
  }
  return {
    id: "prompt-drift",
    state: "warn",
    detail:
      `vendored issues prompt at ${fields.issuePromptPath} has no blocker-recording rule — ` +
      `without it, blocked issues burn runs and quarantine instead of parking cleanly. ` +
      `The shipped prompt says: "edit the body to include \`Blocked by #N\`" ` +
      `(see prompts/issues-prompt.md for the current text).`,
  };
}

/**
 * GET /repos/<slug> with a token — the reachability slice of #154's probe
 * ladder. 200 proves the token sees the repo; 401/403/404 all mean the child
 * would fail its first API hop.
 */
async function probeRepo(
  slug: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchFn(`https://api.github.com/repos/${slug}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "phoebe-doctor",
        authorization: `Bearer ${token}`,
      },
    });
    return describeRepoProbe(res.status, slug);
  } catch (error) {
    return {
      ok: false,
      detail: `could not reach api.github.com: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** How many tenant repo probes run at once during the sweep. */
const TENANT_PROBE_CONCURRENCY = 4;

/** Map with bounded concurrency, preserving input order in the results. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Which declared keys (#425) a tenant's scheduled kinds cannot read. Null when
 * the question could not be answered at all — a config that will not load, a
 * custom kind module that throws — which the check reports as `unknown` rather
 * than inventing a shortfall out of a different fault.
 *
 * Loading kind modules installs the resolved config on a process-wide holder,
 * so this is deliberately awaited one tenant at a time, ahead of the concurrent
 * repo probes.
 */
export async function scanDeclaredEnv(opts: {
  configPath: string;
  env: Record<string, string | undefined>;
}): Promise<MissingDeclaredEnvKey[] | null> {
  try {
    const user = await loadUserConfig(opts.configPath);
    const config = resolveConfig(user, { dataBase: resolveDataBase(process.env) });
    const declarations = await enumerateDeclaredEnv(config, dirname(opts.configPath));
    return declarations.flatMap(({ pipeline, kind, keys }) =>
      keys
        .filter((key) => {
          const value = opts.env[key];
          return value === undefined || value.trim().length === 0;
        })
        .map((key) => ({ pipeline, kind, key })),
    );
  } catch {
    return null;
  }
}

/**
 * The tenant finding for a scheduled kind whose declared key is missing. The
 * engine child would refuse to boot on exactly this, so doctor says so first —
 * the same relationship the prompt-file check has with its boot assertion.
 */
export function declaredEnvCheck(
  missing: MissingDeclaredEnvKey[] | null,
  envLabel: string,
): DoctorCheck {
  if (missing === null) {
    return {
      id: "declared-env",
      state: "unknown",
      detail: "not evaluated (config or work-kind modules failed to load)",
    };
  }
  if (missing.length === 0) {
    return {
      id: "declared-env",
      state: "ok",
      detail: "every scheduled kind can read the env keys it declares",
    };
  }
  return {
    id: "declared-env",
    state: "fail",
    detail:
      `${missing.map((m) => `${m.pipeline}/${m.kind} declares ${m.key}`).join(", ")} — ` +
      `not set in ${envLabel}. Those pipelines' children refuse to boot until the key is ` +
      `set (or the kind is disabled).`,
  };
}

/** A tenant's `.env` as its engine child would parse it; empty when unreadable. */
function readTenantDotenv(envPath: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

/** A tenant's GH_TOKEN, read exactly the way its engine child reads it. */
function tenantToken(envPath: string): string | undefined {
  const value = readTenantDotenv(envPath)["GH_TOKEN"];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The credential-aware token check for one tenant. Pure, for tests.
 *
 * Three cases:
 * - App arm: absent GH_TOKEN is expected — returns `ok`.
 * - PAT arm, token present: returns `ok`.
 * - PAT arm, no token, outside the container: returns `unknown` (unverifiable —
 *   GH_APP_ID is only visible inside the container, so doctor cannot
 *   tell whether this is an unconfigured PAT or a healthy App-arm deployment).
 * - PAT arm, no token, inside the container: returns `fail` (genuine shortfall).
 */
export function tenantTokenCheck(fields: {
  arm: CredentialArm;
  token: string | undefined;
  envLabel: string;
  inContainer: boolean;
}): DoctorCheck {
  if (fields.arm === "app") {
    return {
      id: "token",
      state: "ok",
      detail: "App arm: installation token minted by the GitHub App at runtime",
    };
  }
  if (fields.token !== undefined) {
    return { id: "token", state: "ok", detail: `GH_TOKEN present in ${fields.envLabel}` };
  }
  if (!fields.inContainer) {
    // Outside the container: GH_APP_ID is only visible inside, so we cannot
    // tell whether this is a broken PAT arm or an App arm whose credential is
    // simply not reachable from the host. Never fail --check on this.
    return {
      id: "token",
      state: "unknown",
      detail:
        `unverifiable — no GH_TOKEN in ${fields.envLabel} and the credential source is not ` +
        `visible outside the container (run \`docker compose exec phoebe phoebe doctor\` for a definitive check)`,
    };
  }
  return {
    id: "token",
    state: "fail",
    detail:
      `no GH_TOKEN in ${fields.envLabel} — the supervisor scrubs its own env, so this ` +
      `tenant's child boots with no token at all`,
  };
}

/**
 * The `stale-state` check (#411/#426) — doctor's first look at the repos data
 * directory, and its only one.
 *
 * The sweep runs at facility boot and after a row-set change, so between those
 * triggers orphaned state simply sits there. This is what makes it visible,
 * including the dirty worktrees the sweep refused to delete: those are the ones
 * an operator has to act on, and nothing else in the deployment would ever
 * mention them.
 *
 * Warn, never fail. Accumulated dirt is a chore, not a fault, and a doctor that
 * exits 1 over a leftover directory trains an operator to ignore its exit code.
 */
export function staleStateCheck(fields: {
  dataDir: string;
  items: readonly StaleItem[];
}): DoctorCheck {
  const { dataDir, items } = fields;
  if (items.length === 0) {
    return { id: "stale-state", state: "ok", detail: `nothing orphaned under ${dataDir}` };
  }
  const tiers = new Map<string, number>();
  for (const item of items) tiers.set(item.tier, (tiers.get(item.tier) ?? 0) + 1);
  const byTier = [...tiers].map(([tier, count]) => `${tier} ${count}`).join(", ");
  const kept = items.filter((item) => item.reclaim !== null);
  const parts = [`${items.length} orphan(s) under ${dataDir} (${byTier})`];
  parts.push(
    kept.length === items.length
      ? "none of it auto-reclaimable"
      : `${items.length - kept.length} the next sweep reclaims`,
  );
  for (const item of kept) {
    parts.push(`left in place: ${item.path} — ${item.detail}; to reclaim, ${item.reclaim}`);
  }
  return { id: "stale-state", state: "warn", detail: parts.join("; ") };
}

/**
 * Scan one tenant's data directory without touching it. Unknown — never a
 * finding — when the config will not resolve or the volume is not mounted
 * where doctor is running: an unreadable enumeration cannot tell orphaned from
 * merely stopped, which is the same posture the sweep itself takes.
 */
async function tenantStaleState(fields: {
  configPath: string;
  dataBase: string;
  git?: GitRunner;
}): Promise<DoctorCheck> {
  let config;
  try {
    // Deliberately un-overlaid: a tenant's env comes from its own `.env`, which
    // is the child's, not doctor's. `pipelines` is not overlaid by anything.
    config = resolveConfig(await loadUserConfig(fields.configPath), { dataBase: fields.dataBase });
  } catch (error) {
    return {
      id: "stale-state",
      state: "unknown",
      detail: `not evaluated (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const dataDir = tenantDataDir(config.paths);
  if (!hasTenantData(config.paths)) {
    return { id: "stale-state", state: "unknown", detail: `not evaluated (no data at ${dataDir})` };
  }
  const items = scanStaleState({
    paths: config.paths,
    ownership: pipelineOwnership(config),
    inspector: createWorktreeInspector({
      repoDir: config.paths.repoDir,
      defaultBranch: config.defaultBranch,
      ...(fields.git !== undefined ? { git: fields.git } : {}),
    }),
  });
  return staleStateCheck({ dataDir, items });
}

export async function tenantRow(fields: {
  path: string;
  slug: string | null;
  arm: CredentialArm;
  token: string | undefined;
  envLabel: string;
  fetchFn: typeof fetch;
  inContainer: boolean;
  /** Path to this tenant's phoebe.config.ts, for reading `disabled` (#202). */
  configPath?: string;
  /**
   * What {@link scanDeclaredEnv} found, or undefined when the caller did not
   * ask — the sweep runs the scan itself, sequentially, because loading kind
   * modules is not safe to interleave.
   */
  declaredEnv?: MissingDeclaredEnvKey[] | null;
  /** Where tenant data lives, for the `stale-state` check (#426). */
  dataBase?: string;
  git?: GitRunner;
}): Promise<TenantDoctorRow> {
  const checks: DoctorCheck[] = [];

  // Load the user config once: captures `disabled`, the three label names,
  // and the issues prompt path override — all from a single file read.
  let configLoaded = false;
  let issuePromptPath: string | undefined;
  let readyLabel: string = CONFIG_DEFAULTS.readyLabel;
  let processingLabel: string = CONFIG_DEFAULTS.processingLabel;
  let prOptOutLabel: string = CONFIG_DEFAULTS.prOptOutLabel;

  if (fields.configPath !== undefined) {
    let disabled = false;
    try {
      const user = await loadUserConfig(fields.configPath);
      const anyUser = user as {
        disabled?: unknown;
        promptFiles?: { issue?: unknown };
        pipelines?: Record<string, { kinds?: Record<string, { promptFile?: unknown }> }>;
        readyLabel?: unknown;
        processingLabel?: unknown;
        prOptOutLabel?: unknown;
      };
      disabled = anyUser.disabled === true;
      if (typeof anyUser.readyLabel === "string") readyLabel = anyUser.readyLabel;
      if (typeof anyUser.processingLabel === "string") processingLabel = anyUser.processingLabel;
      if (typeof anyUser.prOptOutLabel === "string") prOptOutLabel = anyUser.prOptOutLabel;
      // The kind block first, the deprecated `promptFiles` alias second (#419):
      // a migrated config carries the path under the kind that reads it, and
      // declaring both is already fatal at load, so there is no third case.
      const rawIssuePath =
        anyUser.pipelines?.[DEFAULT_PIPELINE_NAME]?.kinds?.["issues"]?.promptFile ??
        anyUser.promptFiles?.issue;
      if (typeof rawIssuePath === "string" && rawIssuePath.trim().length > 0) {
        issuePromptPath = rawIssuePath;
      }
      configLoaded = true;
    } catch {
      // Labels and prompt-drift depend on config values; emit unknown for both.
    }
    // Disabled informational note (#202): report-only, does not fail the report.
    // The tenant's other checks still run — a re-enabled tenant should not be
    // surprised by drift that doctor was hiding while it was paused.
    if (disabled) {
      checks.push({
        id: "disabled",
        state: "ok",
        detail: "tenant is disabled — no agent work will start until `disabled` is removed",
      });
    }
  }

  if (fields.declaredEnv !== undefined) {
    checks.push(declaredEnvCheck(fields.declaredEnv, fields.envLabel));
  }

  const tokenCheck = tenantTokenCheck(fields);
  checks.push(tokenCheck);

  let repoPassed = false;
  if (fields.arm === "app") {
    // Probing the repo requires minting a token, which doctor does not do.
    // Repo access is verified at runtime when the token is minted.
    checks.push({
      id: "repo",
      state: "unknown",
      detail: "not probed (App arm — repo access verified at runtime when the token is minted)",
    });
  } else if (fields.token !== undefined) {
    if (fields.slug !== null) {
      const probe = await probeRepo(fields.slug, fields.token, fields.fetchFn);
      repoPassed = probe.ok;
      checks.push({ id: "repo", state: probe.ok ? "ok" : "fail", detail: probe.detail });
    } else {
      checks.push({ id: "repo", state: "unknown", detail: "not probed (no repoSlug)" });
    }
  } else {
    checks.push({
      id: "repo",
      state: "unknown",
      detail:
        tokenCheck.state === "unknown"
          ? "not probed (credential source unverifiable outside the container)"
          : "not probed (no token)",
    });
  }

  // Labels check: verify the three workflow labels exist in the tenant's repo.
  // Only runs when the repo check passed (token works), a slug is known, and
  // the config was loaded (label names are tenant-specific).
  if (fields.configPath !== undefined && !configLoaded) {
    checks.push({ id: "labels", state: "unknown", detail: "not evaluated (config load failed)" });
  } else if (fields.slug !== null && repoPassed && fields.token !== undefined) {
    const allLabels = await fetchRepoLabels(fields.slug, fields.token, fields.fetchFn);
    if (allLabels === null) {
      // Non-200 from the label list endpoint means access denied, not labels
      // missing — avoid emitting a spurious `gh label create` remediation.
      checks.push({
        id: "labels",
        state: "unknown",
        detail:
          `could not list labels for ${fields.slug} — token may lack Issues:read permission. ` +
          `Grant it and re-run \`phoebe doctor\`.`,
      });
    } else {
      const labelNames = [readyLabel, processingLabel, prOptOutLabel];
      const missing = labelNames.filter((name) => !allLabels.includes(name));
      const present = labelNames.filter((name) => allLabels.includes(name));
      checks.push(labelsCheck({ missing, present, slug: fields.slug }));
    }
  } else {
    const reason =
      fields.slug === null
        ? "no repoSlug"
        : fields.token === undefined
          ? "no token"
          : "repo check did not pass";
    checks.push({ id: "labels", state: "unknown", detail: `not probed (${reason})` });
  }

  // Prompt-drift check: warn when a vendored issues prompt lacks the
  // blocker-recording rule that keeps blocked issues from burning runs.
  if (fields.configPath !== undefined) {
    if (!configLoaded) {
      checks.push({
        id: "prompt-drift",
        state: "unknown",
        detail: "not evaluated (config load failed)",
      });
    } else {
      const defaultPath = DEFAULT_PROMPT_FILE_BY_KIND.issues;
      const effectivePath = issuePromptPath ?? defaultPath;
      let promptContent: string | null = null;
      if (effectivePath !== defaultPath) {
        try {
          const resolvedPath = isAbsolute(effectivePath)
            ? effectivePath
            : join(dirname(fields.configPath), effectivePath);
          promptContent = readFileSync(resolvedPath, "utf8");
        } catch {
          promptContent = null;
        }
      }
      checks.push(
        promptDriftCheck({
          issuePromptPath: effectivePath,
          defaultIssuePromptPath: defaultPath,
          promptContent,
        }),
      );
    }
  }

  // Stale-state check: the only one that looks at the data volume, so it runs
  // last and asks nothing of the tracker.
  if (fields.configPath !== undefined && fields.dataBase !== undefined) {
    checks.push(
      await tenantStaleState({
        configPath: fields.configPath,
        dataBase: fields.dataBase,
        ...(fields.git !== undefined ? { git: fields.git } : {}),
      }),
    );
  }

  return { path: fields.path, slug: fields.slug, checks };
}

/** Run every check and assemble the report. The CLI renders it. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const git = deps.git ?? defaultGit;
  const npm = deps.npm ?? defaultNpm;
  const fetchFn = deps.fetchFn ?? fetch;
  const token = deps.env["GH_TOKEN"];
  const checks: DoctorCheck[] = [];

  // 3. Root config loads + engine field parses. Everything engine-shaped hangs
  // off this, so it runs first even though it is check three in the docs.
  const configPath = join(deps.configDir, TENANT_CONFIG_FILE);
  let source: ResolvedEngineSource | null = null;
  let rootConfig: Record<string, unknown> | null = null;
  if (!existsSync(configPath)) {
    checks.push({
      id: "config",
      state: "fail",
      detail: `no ${TENANT_CONFIG_FILE} at ${deps.configDir}`,
    });
  } else {
    try {
      rootConfig = (await loadUserConfig(configPath)) as unknown as Record<string, unknown>;
      source = readEngineSource(rootConfig);
      checks.push({
        id: "config",
        state: "ok",
        detail:
          source.source === "github"
            ? `loads; engine: github ${source.repo}@${source.ref}`
            : "loads; engine: local mount",
      });
    } catch (error) {
      checks.push({
        id: "config",
        state: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 4 + 2. One ls-remote serves both: reachability with the current token, and
  // the latest release tag for the pin comparison.
  let latestTag: string | null = null;
  if (source !== null && source.source === "github") {
    try {
      const url = buildAuthenticatedRepoUrl(source.repo, token);
      const output = git(["ls-remote", "--tags", url], { timeout: LS_REMOTE_TIMEOUT_MS });
      latestTag = latestReleaseTag(output);
      checks.push({
        id: "repo",
        state: "ok",
        detail: `${source.repo} answers ls-remote${token ? " with GH_TOKEN" : " (no token — public access)"}`,
      });
    } catch (error) {
      checks.push({
        id: "repo",
        state: "fail",
        // Redacted: execFileSync's failure message includes the full command
        // line, and the authenticated URL on it carries GH_TOKEN.
        detail:
          `${source.repo} did not answer ls-remote${token ? " with GH_TOKEN" : ""}: ` +
          redactToken(error instanceof Error ? error.message : String(error), token),
      });
    }

    // 2. The pin vs the latest release, plus what is actually checked out.
    let materialized = "";
    const cloneDir = githubEngineDir(engineBaseDir(deps.env), source.repo);
    if (existsSync(join(cloneDir, ".git"))) {
      try {
        materialized = `; materialized ${git(["-C", cloneDir, "rev-parse", "HEAD"]).trim().slice(0, 12)}`;
      } catch {
        materialized = "; materialized commit unreadable";
      }
    } else {
      materialized = "; no engine checkout yet (first boot pending?)";
    }
    const refVersion = releaseVersion(source.ref);
    if (refVersion === null) {
      checks.push({
        id: "engine",
        state: "ok",
        detail:
          `tracking \`${source.ref}\` (auto-upgrades on push)` +
          (latestTag !== null ? `; latest release ${latestTag}` : "") +
          materialized,
      });
    } else if (latestTag !== null && compareVersions(refVersion, releaseVersion(latestTag)!) < 0) {
      checks.push({
        id: "engine",
        state: "warn",
        detail: `pinned ${source.ref}, behind latest ${latestTag} — \`phoebe upgrade\` to advance${materialized}`,
      });
    } else {
      checks.push({
        id: "engine",
        state: latestTag !== null ? "ok" : "unknown",
        detail:
          `pinned ${source.ref}` +
          (latestTag !== null ? ` (latest ${latestTag})` : " (latest unknown)") +
          materialized,
      });
    }
  } else if (source !== null) {
    checks.push({
      id: "repo",
      state: "unknown",
      detail: "local engine mount — no remote to probe",
    });
    checks.push({
      id: "engine",
      state: "ok",
      detail: "local mount — version pinning does not apply",
    });
  } else {
    // Config resolution failed above; the report still carries all six checks
    // so the (JSON) shape never varies with the failure mode.
    checks.push({
      id: "repo",
      state: "unknown",
      detail: "not probed — config resolution failed (see the config check)",
    });
    checks.push({
      id: "engine",
      state: "unknown",
      detail: "not probed — config resolution failed (see the config check)",
    });
  }

  // 1. Bootstrapper vs npm latest.
  const installed = installedCliVersion(npm);
  const latestCli = latestCliVersion(npm);
  if (installed === null) {
    checks.push({
      id: "cli",
      state: "unknown",
      detail: isInsideContainer()
        ? "baked into the image (npm global lookup does not apply in-container)"
        : "phoebe-agent is not npm-installed globally here (npx run, or a repo checkout?)",
    });
  } else if (latestCli === null) {
    checks.push({
      id: "cli",
      state: "unknown",
      detail: `${installed} installed; registry unreachable`,
    });
  } else if (installed === latestCli) {
    checks.push({ id: "cli", state: "ok", detail: `${installed} (latest)` });
  } else {
    checks.push({
      id: "cli",
      state: "warn",
      detail: `${installed} installed, latest is ${latestCli} — \`phoebe upgrade --cli\` to advance`,
    });
  }

  // 5. Crash-loop / quarantine state.
  checks.push(crashLoopCheck(readCrashLoopState(crashLoopStatePath(engineBaseDir(deps.env)))));

  // 6. Supervisor liveness. Only answerable from inside the container, where
  // `phoebe boot` should be PID 1. On the host this is honest "unknown" — there
  // is no pidfile, and guessing from status.json age would misread an idle
  // (event-driven, not heartbeat) deployment as dead.
  if (isInsideContainer()) {
    let cmdline = "";
    try {
      cmdline = readFileSync("/proc/1/cmdline", "utf8").replaceAll("\0", " ");
    } catch {
      cmdline = "";
    }
    checks.push(
      cmdline.includes("boot")
        ? { id: "supervisor", state: "ok", detail: "phoebe boot is the container's main process" }
        : {
            id: "supervisor",
            state: "fail",
            detail: `PID 1 is \`${cmdline.trim() || "unreadable"}\`, not phoebe boot`,
          },
    );
  } else {
    checks.push({
      id: "supervisor",
      state: "unknown",
      detail:
        "not in the container — run `docker compose exec phoebe phoebe doctor` for a live check",
    });
  }

  // 7. Launcher floor — is the bootstrapper at or above the engine's declared floor?
  // A violation means boot throws immediately on startup: the deployment is not
  // "mildly stale" but fully deadlocked. Only meaningful when the engine is a
  // github checkout (local mounts manage their own launcher; config-failed means
  // we have no checkout to read from).
  if (source === null) {
    checks.push({
      id: "launcher-floor",
      state: "unknown",
      detail: "not probed — config resolution failed (see the config check)",
    });
  } else if (source.source !== "github") {
    checks.push({
      id: "launcher-floor",
      state: "ok",
      detail: "local mount — floor check does not apply",
    });
  } else {
    const floorEngineDir = githubEngineDir(engineBaseDir(deps.env), source.repo);
    const minBootstrap = existsSync(join(floorEngineDir, ".git"))
      ? readMinBootstrap(floorEngineDir)
      : null;
    const dockerfilePath = join(deps.configDir, "container", "Dockerfile");
    let launcherVersion: string | null = null;
    let launcherSource: "dockerfile" | "npm-global" | "unknown" = "unknown";
    if (existsSync(dockerfilePath)) {
      const pin = readDockerfilePin(readFileSync(dockerfilePath, "utf8"));
      launcherSource = "dockerfile";
      if (pin.kind === "pinned") launcherVersion = pin.version;
    } else {
      const inst = installedCliVersion(npm);
      if (inst !== null) {
        launcherVersion = inst;
        launcherSource = "npm-global";
      }
    }
    checks.push(launcherFloorCheck({ minBootstrap, launcherVersion, launcherSource }));
  }

  // Tenant sweep: workspace mode enumerates the same fleet boot supervises;
  // solo probes the root itself (the deployment root IS the tenant there).
  const tenants: TenantDoctorRow[] = [];
  const inContainer = isInsideContainer();
  // Where tenant data lives, for the stale-state check: the container constant
  // unless `PHOEBE_DATA_DIR` moves it, which is how doctor reads a mounted
  // volume from the host.
  const dataBase = resolveDataBase(deps.env);
  const enumeration = await enumerateWorkspaceTenants({ configDir: deps.configDir });
  if (enumeration !== null) {
    // Bounded, order-preserving: each probe can wait out its 30s timeout, so a
    // serial sweep over a fleet of unreachable tenants would take
    // tenant-count × 30s. Bounded (not Promise.all) so a big fleet cannot
    // stampede api.github.com either.
    // Ahead of the bounded probes, and one at a time: the declared-key scan
    // loads each tenant's kind modules, which install a process-wide resolved
    // config on the way past (#425).
    const declaredEnvByTenant = new Map<string, MissingDeclaredEnvKey[] | null>();
    for (const tenant of enumeration.tenants) {
      declaredEnvByTenant.set(
        tenant.id,
        await scanDeclaredEnv({
          configPath: tenant.configPath,
          env: readTenantDotenv(tenant.envPath),
        }),
      );
    }
    tenants.push(
      ...(await mapBounded(enumeration.tenants, TENANT_PROBE_CONCURRENCY, (tenant) => {
        const tokenValue = tenantToken(tenant.envPath);
        return tenantRow({
          declaredEnv: declaredEnvByTenant.get(tenant.id) ?? null,
          path: tenant.dir,
          slug: tenant.slug,
          // Per tenant, not per deployment: a fleet mixes arms whenever one
          // tenant keeps its own PAT, and #157's per-installation approvals
          // make that the normal state during any permission change.
          arm: resolveCredentialArm({ GH_TOKEN: tokenValue }, deps.env),
          token: tokenValue,
          envLabel: tenant.envPath,
          fetchFn,
          inContainer,
          configPath: tenant.configPath,
          dataBase,
          git,
        });
      })),
    );
    for (const hold of enumeration.holds) {
      tenants.push({
        path: hold.dir,
        slug: hold.slug,
        checks: [{ id: "discovery", state: "fail", detail: `held — ${hold.reason}` }],
      });
    }
  } else if (rootConfig !== null && typeof rootConfig["repoSlug"] === "string") {
    // Solo: the child inherits the supervisor's env, so the ambient token is
    // the truth here (and only here) — same reasoning as verify-tenant-token.
    const slug = rootConfig["repoSlug"];
    tenants.push(
      await tenantRow({
        path: deps.configDir,
        slug,
        // Solo: the ambient container env is this tenant's env-file, so it is
        // what the declared keys are checked against.
        declaredEnv: await scanDeclaredEnv({ configPath, env: deps.env }),
        // Solo: the root is the tenant, so one env answers both halves.
        arm: resolveCredentialArm(deps.env),
        token: token !== undefined && token.length > 0 ? token : undefined,
        envLabel: "the environment",
        fetchFn,
        inContainer,
        configPath,
        dataBase,
        git,
      }),
    );
  }

  return buildDoctorReport(checks, tenants);
}

const STATE_MARK: Record<CheckState, string> = { ok: "✓", warn: "!", fail: "✗", unknown: "?" };

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["[phoebe] doctor"];
  for (const check of report.checks) {
    lines.push(`  ${STATE_MARK[check.state]} ${check.id.padEnd(11)} ${check.detail}`);
  }
  if (report.tenants.length > 0) {
    lines.push("tenants:");
    for (const tenant of report.tenants) {
      lines.push(`  ${tenant.path}${tenant.slug !== null ? `  (${tenant.slug})` : ""}`);
      for (const check of tenant.checks) {
        lines.push(`      ${STATE_MARK[check.state]} ${check.id.padEnd(6)} ${check.detail}`);
      }
    }
  }
  const failing =
    report.checks.filter((c) => c.state === "fail").length +
    report.tenants.flatMap((t) => t.checks).filter((c) => c.state === "fail").length;
  lines.push(
    report.ok ? "healthy: no failing checks." : `${failing} failing check(s) — see above.`,
  );
  return lines.join("\n");
}

const DOCTOR_HELP_TEXT = `phoebe doctor — deployment health checks (report-only)

Usage:
  phoebe doctor [--json]

Checks: cli version vs npm latest; engine pin vs latest release (+ the commit
actually materialized); root config loads; engine repo reachable with GH_TOKEN;
crash-loop/quarantine state (are you silently on last-known-good?); supervisor
liveness (in-container only); launcher version vs the engine's minBootstrap floor
(a floor violation deadlocks the deployment — not the same as being merely stale).
In workspace mode every tenant is swept — token present the way its child reads
it, repo reachable with that token, the three workflow labels present in the
repo, every env key a scheduled work kind declares set in that tenant's .env,
and (when the issues prompt is overridden) that it includes the
blocker-recording rule.

The full five-permission token probe is scripts/verify-tenant-token.mjs.
Exit code is 1 when any check fails. \`phoebe upgrade\` moves versions;
doctor reports whether the version you are on works.
`;

/** `phoebe doctor` entry. */
export async function runDoctorCli(argv: readonly string[]): Promise<void> {
  let json = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(DOCTOR_HELP_TEXT);
      return;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown flag \`${arg}\` for \`phoebe doctor\`. See \`phoebe doctor --help\`.`);
  }
  const report = await runDoctor({ configDir: process.cwd(), env: process.env });
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${formatDoctorReport(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}
