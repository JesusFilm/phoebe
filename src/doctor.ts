// `phoebe doctor` — the deployment health panel. Report-only in v1: `upgrade`
// moves you between versions; `doctor` tells you whether the version you are on
// is actually working. (A `--fix` mode that repairs at the current pin is a
// mapped follow-up.)
//
// Seven checks, all reads of state that already exists:
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
// In workspace mode it also sweeps tenants — the same enumeration boot
// supervises with (#91/#154), so doctor can never report a different fleet from
// the one that is running. Per tenant: is a GH_TOKEN present the way the child
// would read it, and does the tenant repo answer to it. The full five-permission
// grant probe stays in scripts/verify-tenant-token.mjs (it ships with the repo,
// not the package); doctor's per-tenant probe is the reachability slice of it.

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { enumerateWorkspaceTenants } from "./tenant-commands.ts";

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

/** A tenant's GH_TOKEN, read exactly the way its engine child reads it. */
function tenantToken(envPath: string): string | undefined {
  try {
    const value = parseDotenv(readFileSync(envPath, "utf8"))["GH_TOKEN"];
    return value !== undefined && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
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

async function tenantRow(fields: {
  path: string;
  slug: string | null;
  arm: CredentialArm;
  token: string | undefined;
  envLabel: string;
  fetchFn: typeof fetch;
  inContainer: boolean;
  /** Path to this tenant's phoebe.config.ts, for reading `disabled` (#202). */
  configPath?: string;
}): Promise<TenantDoctorRow> {
  const checks: DoctorCheck[] = [];

  // Disabled informational note (#202): report-only, does not fail the report.
  // The tenant's other checks still run — a re-enabled tenant should not be
  // surprised by drift that doctor was hiding while it was paused.
  if (fields.configPath !== undefined) {
    let disabled = false;
    try {
      const user = await loadUserConfig(fields.configPath);
      disabled = (user as { disabled?: unknown }).disabled === true;
    } catch {
      disabled = false;
    }
    if (disabled) {
      checks.push({
        id: "disabled",
        state: "ok",
        detail: "tenant is disabled — no agent work will start until `disabled` is removed",
      });
    }
  }

  const tokenCheck = tenantTokenCheck(fields);
  checks.push(tokenCheck);

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
  const enumeration = await enumerateWorkspaceTenants({ configDir: deps.configDir });
  if (enumeration !== null) {
    // Bounded, order-preserving: each probe can wait out its 30s timeout, so a
    // serial sweep over a fleet of unreachable tenants would take
    // tenant-count × 30s. Bounded (not Promise.all) so a big fleet cannot
    // stampede api.github.com either.
    tenants.push(
      ...(await mapBounded(enumeration.tenants, TENANT_PROBE_CONCURRENCY, (tenant) => {
        const tokenValue = tenantToken(tenant.envPath);
        return tenantRow({
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
        // Solo: the root is the tenant, so one env answers both halves.
        arm: resolveCredentialArm(deps.env),
        token: token !== undefined && token.length > 0 ? token : undefined,
        envLabel: "the environment",
        fetchFn,
        inContainer,
        configPath,
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
it, and its repo reachable with that token.

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
