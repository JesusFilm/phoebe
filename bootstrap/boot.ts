// `phoebe boot` — the container's long-lived main process.
//
// The bootstrapper's job at boot is small: read the mounted consumer config,
// resolve where the engine source lives, and exec that engine as a long-running
// child (its normal persistent poll loop). Stop signals are forwarded to the
// child so a container `SIGTERM` reaches the engine and triggers its graceful
// drain (src/drain.ts); the child's exit is propagated so the container exits
// with the engine's status.
//
// Two engine sources are wired: `local` — a host→container mount at
// `/opt/phoebe-engine` (the dev-only `compose.local.yml` overlay, #40) — and
// `github` — a git checkout of the engine repo at a ref (github-engine.ts, #41).
//
// Boot then stays in charge for the life of the container: the reconcile watch
// (#42) polls the mounted config and the tracked ref, and when either moves it
// drains the engine, re-resolves the source, and relaunches — same container, no
// interrupted work unit. Following a branch also means eventually following it
// onto a commit that will not boot, so every launch passes through the
// crash-loop guard (crash-loop.ts, #43): a tip that dies fast enough times is
// quarantined and boot materializes the last commit that ran healthily instead.
//
// Both arms — solo and workspace — run on one supervision loop and share one
// slot broker (#416). The arm still picks discovery (the root itself, or a walk
// of the workspace tree) and how a child gets its environment (the supervisor's
// ambient env, or the per-tenant scrub); what a pipeline's death means for the
// container is injected policy, not a second loop. This module is the wiring;
// the loop lives in supervise-fleet.ts, the watched-world vocabulary in
// reconcile.ts, the fallback policy in crash-loop.ts, and everything impure is
// passed in from here.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { installDrainSignal } from "../src/drain.ts";
import { defaultGit, type GitRunner } from "../src/git-model.ts";
import { loadUserConfig, resolveConfigPath } from "../src/load-config.ts";
import {
  crashLoopStatePath,
  createCrashGuard,
  judgeRun,
  type CrashGuard,
  type CrashGuardEvent,
  type RunOutcome,
} from "./crash-loop.ts";
import { readEngineSource, type ResolvedEngineSource } from "./engine-source.ts";
import {
  createPipelineEnumerator,
  pipelineLabel,
  siblingOnlyEnvKeys,
  type PipelineEnumerator,
  type SupervisedPipeline,
} from "./pipelines.ts";
import { lsRemoteBranchSha, materializeGithubEngine } from "./github-engine.ts";
import { buildEngineChildEnv, envReconcileDigest, parseDotenv } from "./engine-child-env.ts";
import { attachCredentialHandler, type CredentialCache } from "./credential-ipc.ts";
import {
  fetchAppBotIdentity,
  mintInstallationToken,
  readAppCredentials,
  type AppBotIdentity,
  type AppCredentials,
  type MintedToken,
} from "./github-app.ts";
import { attachBroker } from "./broker-ipc.ts";
import {
  createSlotBroker,
  describeCap,
  resolveEffectiveCap,
  resolveFloorBudget,
  type BrokerPipeline,
  type SlotBroker,
} from "./slot-broker.ts";
import {
  discoverTenants,
  discoverWorkspaceTenants,
  WorkspaceStructuralChangeError,
  WorkspaceTenantAxisSkip,
  type DiscoveredTenant,
  type MintedCredentials,
  type WorkspaceDiscoveryResult,
  type WorkspaceHold,
  type FleetDiscoverResult,
  type TenantSample,
} from "./tenants.ts";
import { readConfigDir } from "./config-dir.ts";
import { readGitIdentity, soloIdentityEnv, type GitIdentity } from "./git-identity.ts";
import {
  superviseFleet,
  type FleetChild,
  type FleetDiscoverInput,
  type FleetRun,
  type PipelineExitPolicy,
  type SuperviseFleetDeps,
} from "./supervise-fleet.ts";
import {
  isExplicitWorkspace,
  resolveWorkspace,
  workspaceArm,
  type ResolvedWorkspace,
} from "./workspace-source.ts";
import { readFileSync } from "node:fs";
import { resolveCredentialArm, type CredentialArm } from "./credential-arm.ts";
import {
  configFingerprint,
  CRASH_BACKOFF_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  type EngineExit,
  type EngineRun,
  type LaunchedEngine,
} from "./reconcile.ts";
// Untyped plain-JS import (see spawn-engine.mjs / materialize.mjs for why the
// bootstrapper's child-process plumbing can't be TypeScript).
import { propagateExit, spawnEngineChild, spawnSoloChild } from "./spawn-engine.mjs";

/** Where the local-engine compose overlay mounts the engine for `source: "local"`. */
export const LOCAL_ENGINE_DIR = "/opt/phoebe-engine";

/**
 * The solo pipeline's reconcile fingerprint — a constant, because solo has no tenant
 * axis to reconcile. The root config *is* the engine's config, so every edit to
 * it is already the engine axis's business (relaunch on a moved engine source,
 * a silent rebase otherwise, #138). A fingerprint that tracked the file would
 * relaunch the child a second time for the same edit.
 */
const SOLO_TENANT_FINGERPRINT = "solo";

/**
 * The launcher's own semver version, read once at module load.
 *
 * In the deployed package flow (bin.mjs → materialize.mjs → outside
 * node_modules), the `.materialized` marker written by ensureEngine() holds the
 * version string. In a dev git checkout there is no marker, so the package.json
 * one level up from this file is the fallback. Falls back to "0.0.0" only when
 * both reads fail (e.g. unit tests that call checkMinBootstrap directly — those
 * pass launcherVersion explicitly and never read this constant).
 */
const LAUNCHER_VERSION: string = (() => {
  try {
    return readFileSync(join(import.meta.dirname, "..", ".materialized"), "utf8").trim();
  } catch {
    try {
      const pkg = JSON.parse(
        readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
      ) as Record<string, unknown>;
      return typeof pkg["version"] === "string" ? pkg["version"] : "0.0.0";
    } catch {
      return "0.0.0";
    }
  }
})();

/**
 * Read `phoebe.minBootstrap` from the materialized engine checkout's
 * `package.json` and refuse when the running launcher is below that floor.
 *
 * Absence of the file, absence of the field, or an unparseable value all
 * mean "no floor" — engines that predate the field keep working with any
 * launcher version. The check is pure given two version strings and a
 * `readFile`, so it tests without processes.
 */
export function checkMinBootstrap(opts: {
  launcherVersion: string;
  engineDir: string;
  readFile?: (path: string) => string;
}): void {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = readFile(join(opts.engineDir, "package.json"));
  } catch {
    return;
  }
  let minBootstrap: unknown;
  try {
    const pkg = JSON.parse(raw) as unknown;
    if (typeof pkg !== "object" || pkg === null) return;
    const phoebe = (pkg as Record<string, unknown>)["phoebe"];
    if (typeof phoebe !== "object" || phoebe === null) return;
    minBootstrap = (phoebe as Record<string, unknown>)["minBootstrap"];
  } catch {
    return;
  }
  if (typeof minBootstrap !== "string" || !/^\d+\.\d+\.\d+/.test(minBootstrap)) return;
  if (semverLt(opts.launcherVersion, minBootstrap)) {
    throw new Error(
      `engine requires launcher >= ${minBootstrap}, but this launcher is ` +
        `${opts.launcherVersion}. ` +
        `Pin the bootstrapper in your Dockerfile (\`npm install -g phoebe-agent@${minBootstrap}\` ` +
        `or higher), then rebuild the image.`,
    );
  }
}

function semverLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

/**
 * Runs `gh` with the given argv. Injectable so boot's credential-helper setup is
 * unit-tested without a real `gh` binary or a writable `~/.gitconfig`.
 */
export type GhRunner = (args: readonly string[]) => void;

export const defaultGh: GhRunner = (args) => {
  execFileSync("gh", args, { stdio: "inherit" });
};

/**
 * Configure a global git credential helper so every later git call against
 * github.com authenticates — the engine's `ensureClone` / `fetchOrigin` /
 * `pushBranch`, and the agent child's own `git push`/`fetch`.
 *
 * Uses `gh auth setup-git --hostname github.com`, which writes a
 * `!gh auth git-credential` helper into `~/.gitconfig`. That helper reads
 * `GH_TOKEN` live per call, so no secret is written to disk and token rotation
 * keeps working. Only `github.com` is configured (Phoebe is github-only).
 *
 * Runs unconditionally: when the supervisor holds no token a GitHub App child
 * can still mint its own `GH_TOKEN` and have the helper ready. A failed setup
 * warns and continues — a missing helper is better diagnosed at the first
 * private-repo clone than by aborting the container here.
 */
export function setupGitCredentials(deps: {
  gh?: GhRunner;
  warn?: (message: string) => void;
}): void {
  const gh = deps.gh ?? defaultGh;
  const warn = deps.warn ?? ((message) => console.warn(message));
  try {
    gh(["auth", "setup-git", "--hostname", "github.com"]);
  } catch (error) {
    warn(
      `[phoebe] boot: could not configure git credentials — ${describe(error)}. ` +
        `Continuing without a credential helper.`,
    );
  }
}

/**
 * Resolve a `local` engine source to the mounted engine's `src/cli.ts`, failing
 * loudly if it is absent — a missing/empty mount means a misconfigured
 * container, not a fallback. Checking the entry file (not just the directory)
 * catches a mounted-but-empty volume too. `github` is handled separately
 * (materializeGithubEngine), so this only ever sees `local`.
 *
 * `exists`/`localEngineDir` are injectable so the decision is unit-tested
 * without a real filesystem.
 */
export function resolveEngineEntry(
  _source: { source: "local" },
  deps: { localEngineDir?: string; exists?: (path: string) => boolean } = {},
): string {
  const exists = deps.exists ?? existsSync;
  const dir = deps.localEngineDir ?? LOCAL_ENGINE_DIR;
  const entry = join(dir, "src", "cli.ts");
  if (!exists(entry)) {
    throw new Error(
      `engine.source is "local" but no engine is mounted at ${dir} (missing ${entry}). ` +
        `Mount the engine there (container/compose.local.yml) before \`phoebe boot\`.`,
    );
  }
  return entry;
}

/**
 * Base directory the github source clones the engine into. Reuses
 * `PHOEBE_ENGINE_DIR` (the same knob bin.mjs materializes under); point it at a
 * persistent volume so github clones survive restarts and later boots fetch
 * instead of re-cloning. Defaults to a per-user temp dir for local dev.
 */
function engineBaseDir(): string {
  return process.env["PHOEBE_ENGINE_DIR"] ?? join(tmpdir(), "phoebe-agent");
}

/**
 * How often the reconcile watch samples the config and the tracked ref.
 * `PHOEBE_RECONCILE_INTERVAL_MS` tightens it for dogfooding (the default is a
 * minute, which is a long time to wait when demonstrating a relaunch).
 */
function reconcileIntervalMs(): number {
  const raw = Number(process.env["PHOEBE_RECONCILE_INTERVAL_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECONCILE_INTERVAL_MS;
}

/**
 * Load the mounted `phoebe.config.ts` as the arbitrary record the bootstrapper
 * treats it as — it owns only one field (`engine`), and the engine validates the
 * rest once it is materialized and run. The fingerprint doubles as the ESM
 * cache-bust key, so a re-read after an edit is genuinely a re-read.
 */
async function loadMountedConfig(
  configPath: string,
  fingerprint: string | null,
): Promise<Record<string, unknown>> {
  const userConfig = await loadUserConfig(configPath, { reloadKey: fingerprint ?? undefined });
  return userConfig as unknown as Record<string, unknown>;
}

/**
 * Read the config and turn the engine source it names into something runnable —
 * the whole of a (re)launch. Called once at boot and again for every reconcile,
 * so an edited config is genuinely re-read (hence the fingerprint as the ESM
 * cache-bust key) and a moved ref is genuinely re-fetched.
 *
 * The tracked ref's tip is materialized first even when a fallback is in force:
 * the tip is what the guard's verdict is *about*, so resolving it is how boot
 * notices both that the quarantine still applies and that the branch has moved
 * past it. A fallback then checks out the last-good commit in the same clone.
 */
/**
 * Probe a freshly materialized checkout for pipeline enumeration and say so, once
 * (#417). The line is worth printing on every launch: on an engine without the
 * subcommand it is the whole explanation for why a tenant's declared `intake`
 * pipeline is not running, and the answer can legitimately change under the same
 * config the moment the engine ref moves.
 */
function probePipelineEnumeration(entry: string): PipelineEnumerator {
  const pipelines = createPipelineEnumerator({ entry });
  console.log(
    pipelines.supported()
      ? "[phoebe] boot: engine supports pipeline enumeration — pipelines are read per tenant."
      : "[phoebe] boot: engine has no `pipelines` subcommand — every tenant runs one implicit " +
          "`work` pipeline.",
  );
  return pipelines;
}

async function launchTarget(configPath: string, guard: CrashGuard): Promise<LaunchedEngine> {
  const fingerprint = configFingerprint(configPath);
  const source = readEngineSource(await loadMountedConfig(configPath, fingerprint));
  const token = process.env["GH_TOKEN"];
  const sample = () => ({
    config: configFingerprint(configPath),
    remoteSha: watchedRefSha(source, token),
  });
  const confirmEngineSource = async () =>
    readEngineSource(await loadMountedConfig(configPath, configFingerprint(configPath)));

  if (source.source === "local") {
    const entry = resolveEngineEntry(source);
    console.log(`[phoebe] boot: engine source "local" — exec ${entry} (long-running).`);
    return {
      entry,
      sha: null,
      config: fingerprint,
      source,
      confirmEngineSource,
      guarded: false,
      quarantinedSha: null,
      sample,
      pipelines: probePipelineEnumeration(entry),
    };
  }

  const guarded = isMovingBranch(source, token);
  const baseDir = engineBaseDir();
  let { entry, sha } = materializeGithubEngine(source, { baseDir, token });

  let quarantinedSha: string | null = null;
  const pin = guarded && sha !== null ? guard.fallbackFor(sha) : null;
  if (pin !== null) {
    quarantinedSha = sha;
    ({ entry, sha } = materializeGithubEngine({ ...source, ref: pin }, { baseDir, token }));
  }

  // dirname twice: entry is <checkout>/src/cli.ts, so two levels up is the root.
  checkMinBootstrap({ launcherVersion: LAUNCHER_VERSION, engineDir: dirname(dirname(entry)) });

  const provenance =
    quarantinedSha !== null
      ? `${source.repo}@${source.ref} → last-good ${sha} (crash-loop fallback from ${quarantinedSha})`
      : `${source.repo}@${source.ref}${sha ? ` (${sha})` : ""}`;
  console.log(
    `[phoebe] boot: engine source "github" ${provenance} — exec ${entry} (long-running).`,
  );

  return {
    entry,
    sha,
    config: fingerprint,
    source,
    confirmEngineSource,
    guarded,
    quarantinedSha,
    sample,
    pipelines: probePipelineEnumeration(entry),
  };
}

/**
 * Does the crash-loop guard apply to this source? Only a moving branch is
 * guarded: a local mount has no commit to pin, and a pinned SHA or tag means the
 * operator chose that exact commit — quietly serving a different one would be
 * worse than crash-looping visibly. `lsRemoteBranchSha` answers precisely that
 * question (it yields a tip only for a branch) and short-circuits a pinned SHA
 * without touching the network.
 *
 * A remote that will not answer leaves the guard off for this launch rather than
 * failing it: materializing is about to make the same call, and its error is the
 * one worth surfacing.
 */
export function isMovingBranch(
  source: ResolvedEngineSource,
  token: string | undefined,
  git: GitRunner = defaultGit,
): boolean {
  if (source.source === "local") return false;
  try {
    return lsRemoteBranchSha(source, { token, git }) !== null;
  } catch (error) {
    console.warn(
      `[phoebe] boot: could not check whether ${source.repo}@${source.ref} is a moving branch — ` +
        `${describe(error)}. Crash-loop fallback is off for this launch.`,
    );
    return false;
  }
}

/**
 * The ref half of a poll: where the tracked branch points now, or null when
 * there is nothing to watch (a local mount, or a pinned SHA/tag — which the
 * ref-watch leaves alone by design).
 */
function watchedRefSha(source: ResolvedEngineSource, token: string | undefined): string | null {
  if (source.source === "local") return null;
  return lsRemoteBranchSha(source, { token });
}

/**
 * The crash-loop guard for this container, rooted at the deployment-global
 * engine dir (`/data/engine`, the shared `phoebe-engine` volume — #60/#62). One
 * guard about one engine SHA for the whole fleet; its home is a container
 * constant (the engine checkout base), not a per-tenant path, so it no longer
 * depends on loading any config and cannot drift with a mid-flight config edit.
 */
function createBootCrashGuard(): CrashGuard {
  return createCrashGuard({
    statePath: crashLoopStatePath(engineBaseDir()),
    onEvent: logCrashGuardEvent,
  });
}

/**
 * The guard's decisions, in an operator's terms. A container quietly serving
 * older code than its config asks for is exactly the confusion these lines
 * exist to prevent, so every fallback event names both commits.
 */
function logCrashGuardEvent(event: CrashGuardEvent): void {
  switch (event.kind) {
    case "crash":
      console.error(
        `[phoebe] boot: engine ${event.sha} exited ${event.exitCode} after ` +
          `${Math.round(event.elapsedMs / 1000)}s — fast crash ${event.failureCount}/${event.threshold}.`,
      );
      return;
    case "last-good":
      console.log(
        `[phoebe] boot: engine ${event.sha} ran healthily — recorded as the crash-loop fallback target.`,
      );
      return;
    case "fallback":
      console.error(
        `[phoebe] boot: engine ${event.quarantinedSha} crash-looped ${event.failureCount}× — ` +
          `falling back to last-good ${event.lastGoodSha}, and staying there until the tracked ` +
          `ref moves past the bad commit.`,
      );
      return;
    case "fallback-crashed":
      console.error(
        `[phoebe] boot: the last-good engine ${event.sha} crashed too ` +
          `(exit ${event.exitCode} after ${Math.round(event.elapsedMs / 1000)}s) — ` +
          `${event.quarantinedSha} stays quarantined and the container will exit.`,
      );
      return;
    case "recovered":
      console.log(
        `[phoebe] boot: tracked ref advanced to ${event.sha}, past quarantined ` +
          `${event.quarantinedSha} — crash-loop fallback lifted.`,
      );
      return;
    case "persist-failed":
      console.warn(
        `[phoebe] boot: could not write crash-loop state to ${event.path} — ` +
          `${describe(event.error)}. The fallback will not survive a container restart.`,
      );
      return;
  }
}

/**
 * A finished run as the crash-loop guard sees it, or null when there is no
 * commit to say anything about (a local mount). Note this is *not* gated on
 * `guarded`: what a pinned launch proved is still worth remembering — it only
 * must not cause a fallback — and recording it means an operator who later moves
 * that deployment onto a branch already has a target to fall back to.
 */
function runOutcome(run: EngineRun): RunOutcome | null {
  if (run.engine.sha === null) return null;
  return {
    sha: run.engine.sha,
    exitCode: run.exit.code,
    elapsedMs: run.elapsedMs,
    requestedStop: run.requestedStop,
  };
}

/**
 * Read a tenant's co-located `.env` into a plain record for the #61 env scrub.
 * A missing/unreadable file is an empty record — the child then holds only the
 * allowlisted base + deployment knobs (fail-closed), which boot surfaces at the
 * first private-repo git call rather than here.
 */
function readTenantEnv(envPath: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

/** One supervised pipeline as the slot broker orders and sizes for it (#407). */
function brokerPipeline(pipeline: SupervisedPipeline): BrokerPipeline {
  return {
    id: pipeline.id,
    tenantId: pipeline.tenant.id,
    priority: pipeline.pipeline.priority,
    concurrency: pipeline.pipeline.concurrency,
    label: pipelineLabel(pipeline),
  };
}

/**
 * Keep the broker in step with the live pipeline matrix (#407), in either arm.
 *
 * Two different things ride on the same hook. Every poll refreshes the ordering
 * data — a pipeline's tenant and its hot `priority` — which is what lets a `priority`
 * edit reorder the queue with no relaunch. Only a poll that *reshaped* the
 * matrix re-derives the effective cap: shrinking a semaphore below its own
 * `inUse` has no safe answer, so the number moves only when the supervisor is
 * already mid-reshape, never on a hot flip.
 *
 * The cap line is logged when it says something new, so an operator sees the
 * two numbers of the worst case (`cap + floorBudget`) at boot and again whenever
 * a reconcile moves them, without a line per poll.
 */
export function trackPipelines(
  broker: SlotBroker,
  env: NodeJS.ProcessEnv = process.env,
): NonNullable<SuperviseFleetDeps["onPipelines"]> {
  let reported: string | null = null;
  return ({ pipelines, reshaped }) => {
    const live = pipelines.map(brokerPipeline);
    broker.setPipelines(live);
    if (!reshaped) return;
    const cap = resolveEffectiveCap(live, env);
    broker.setCapacity(cap.capacity);
    const line = describeCap(cap, broker.floorBudget);
    if (line === reported) return;
    console.log(`[phoebe] boot: ${line}`);
    reported = line;
  };
}

/**
 * Supervise a workspace multi-tenant deployment (#58/#59/#61/#91): a
 * shared engine (#60, materialized once by `launchTarget` from the top config's
 * `engine` field) with one child per `(tenant × pipeline)` pipeline (#401/#420), a
 * global concurrency broker across them, and hot add/remove/change via
 * `superviseFleet`.
 *
 * Each child is spawned with an IPC channel + the tenant's scrubbed env (#61),
 * cwd (its config dir) and its pipeline's `--pipeline`, and wired to the broker (#59)
 * under the pipeline id. The crash-loop guard applies any existing engine fallback on
 * each (re)launch, and now hears about the fleet's runs under the universality
 * rule — live fleet validation is still deferred to #77.
 *
 * `discover` is injected rather than called directly so the reconcile loop stays
 * testable against a fake fleet: today's one caller re-walks the workspace tree
 * and reloads each child's `repoSlug` every poll (#91). Pipelines come from the
 * engine, not from here, so this stays tenant-shaped.
 */
function runFleet(opts: {
  configPath: string;
  guard: CrashGuard;
  stop: ReturnType<typeof installDrainSignal>;
  intervalMs: number;
  argv: readonly string[];
  discover: () => FleetDiscoverInput;
  broker: SlotBroker;
}): Promise<EngineExit> {
  const { broker } = opts;
  // Fleet-level credential-lease state (#211/#205): the cache and the warn-once
  // tracker outlive child respawns. Every child's lease must be answered — a
  // spawned engine requests one at the top of each poll and blocks until the
  // supervisor replies.
  const credentialCache: CredentialCache = new Map();
  const warnedOverBudget = new Set<string>();

  const spawnFleetChild = (pipeline: SupervisedPipeline, engine: LaunchedEngine): FleetChild => {
    const tenant = pipeline.tenant;
    const env = buildEngineChildEnv({
      base: process.env,
      mintedEnv: tenant.mintedEnv,
      // The tenant config's declared attribution (#199) — above the deployment
      // base and the App bot fallback, below the tenant's own `.env`.
      configIdentity: tenant.gitIdentity,
      tenantEnv: readTenantEnv(tenant.envPath),
      // The subtractive pipeline scrub (#425): this tenant's `.env` reaches the pipeline
      // whole except for the keys a sibling pipeline declared and this one did not.
      scrubKeys: siblingOnlyEnvKeys(pipeline),
    });
    let settle!: (exit: EngineExit) => void;
    const exited = new Promise<EngineExit>((resolve) => {
      settle = resolve;
    });
    const label = pipelineLabel(pipeline);
    // The child's cwd is the tenant's asset dir (#98): `dirname(envPath)`, which
    // is `tenant.dir` unless `configDir` relocated the `.env` (e.g. into
    // `.phoebe/`). When relocated, cwd is not where the config lives, so pass
    // `--config` explicitly (the child's CLI resolves config from cwd otherwise
    // — and `--config` always wins). Relative `promptFiles` then resolve under
    // the asset dir. The default path (co-located) is byte-for-byte unchanged.
    const assetsDir = dirname(tenant.envPath);
    const relocated = assetsDir !== tenant.dir;
    const child = spawnEngineChild(
      engine.entry,
      rowArgv(pipeline, tenant.configPath, relocated, opts.argv),
      {
        env,
        cwd: assetsDir,
        onExit: (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }),
        onSpawnError: (error: Error) => {
          console.error(`[phoebe] boot: pipeline ${label} failed to spawn — ${error.message}`);
          settle({ code: 1, signal: null });
        },
      },
    );
    attachBroker({ owner: pipeline.id, broker, child });
    // The lease answerer (#211/#205). `readPatToken` re-reads this tenant's
    // `.env` per request, so a rotated PAT lands in the running child at its
    // next lease call site — no drain, no respawn (the fingerprint above
    // deliberately ignores `GH_TOKEN`'s value for exactly this reason; its
    // *removal* still relaunches, since a lease cannot deliver an absence).
    // App tenants
    // (no explicit token) get the null no-op: their refreshed installation
    // token still arrives via the mint-expiry fingerprint relaunch (#209).
    // Leased under the pipeline id, so a lease answered for one pipeline of a tenant is
    // never mistaken for its sibling's (#420).
    attachCredentialHandler({
      tenantId: pipeline.id,
      child,
      cache: credentialCache,
      mint: null,
      readPatToken: () => readTenantEnv(tenant.envPath)["GH_TOKEN"] ?? null,
      warnedOverBudget,
    });
    return { kill: (signal) => child.kill(signal), exited };
  };

  return superviseFleet({
    launch: () => launchTarget(opts.configPath, opts.guard),
    discover: opts.discover,
    spawn: spawnFleetChild,
    stop: opts.stop,
    intervalMs: opts.intervalMs,
    onEngineChange: (reason) =>
      console.log(
        reason === "config"
          ? "[phoebe] boot: shared config changed — draining the fleet and relaunching every pipeline."
          : "[phoebe] boot: tracked engine ref advanced — draining the fleet and relaunching every pipeline.",
      ),
    onPipelineChange: ({ added, removed, changed }) =>
      console.log(
        `[phoebe] boot: pipeline reconcile — +${added.length} added, -${removed.length} removed, ` +
          `~${changed.length} relaunched (no container restart).`,
      ),
    onPipelines: trackPipelines(broker),
    onChildExit: ({ pipeline, exit }) =>
      console.error(
        `[phoebe] boot: pipeline ${pipelineLabel(pipeline)} exited (${exit.code ?? exit.signal}) — ` +
          `respawning with backoff (per-pipeline supervision; the shared engine and every ` +
          `sibling pipeline are untouched).`,
      ),
    onLaunchError: (error) =>
      console.error(`[phoebe] boot: fleet (re)launch failed — ${describe(error)}. Retrying.`),
    onDiscoverError: (error) =>
      console.warn(
        `[phoebe] boot: tenant discovery failed — ${describe(error)}. ` +
          `Skipping the pipeline axis this poll (the running fleet is left intact).`,
      ),
    pipelineFingerprint: workspacePipelineFingerprint,
    onPipelinesError: ({ tenantId, error }) =>
      console.warn(
        `[phoebe] boot: could not enumerate pipelines for ${tenantId} — ${describe(error)}. ` +
          `Holding the tenant (its running pipelines keep running); retrying next poll.`,
      ),
    onRunEnd: recordRunEnd(opts.guard),
    onRunTick: ({ engine, elapsedMs }) => {
      if (engine.sha !== null) opts.guard.noteAlive(engine.sha, elapsedMs);
    },
    rowExit: rowExitPolicy(opts.guard),
  });
}

/**
 * A pipeline's reconcile fingerprint: what the engine said about the pipeline's config,
 * narrowed by the tenant's `.env` *as this pipeline would hold it* (#425).
 *
 * The tenant fingerprint still counts every `.env` key, so an edit there is
 * always noticed. What this decides is *who relaunches*: a rotated key that
 * only the intake pipeline can see moves only the intake pipeline's digest, and because
 * the supervisor never fans a tenant-wide change out to pipelines that already
 * accounted for it, the work pipeline keeps running. A rotated undeclared key is
 * visible to every pipeline and moves all of them, which is the behaviour a
 * single-pipeline tenant has always had.
 *
 * A null enumerated fingerprint stays null — the implicit pipeline of a checkout
 * that cannot enumerate declares nothing and relaunches on the tenant axis.
 */
export function workspacePipelineFingerprint(
  pipeline: SupervisedPipeline,
  enumerated: string | null,
): string | null {
  if (enumerated === null) return null;
  const hidden = siblingOnlyEnvKeys(pipeline);
  let digest: string;
  try {
    digest = envReconcileDigest(readFileSync(pipeline.tenant.envPath, "utf8"), hidden);
  } catch {
    digest = "";
  }
  return `${enumerated}:${digest}`;
}

/**
 * A pipeline's child argv: the pipeline it runs, plus the config path when the tenant's
 * assets were relocated away from it (#98). `--pipeline` is omitted for the
 * implicit pipeline of an engine that cannot enumerate — that checkout has no such
 * flag and would exit on it before reading a config (#417).
 */
export function rowArgv(
  pipeline: SupervisedPipeline,
  configPath: string,
  relocated: boolean,
  forwarded: readonly string[],
): string[] {
  return [
    ...(relocated ? ["--config", configPath] : []),
    ...(pipeline.enumerated ? ["--pipeline", pipeline.pipeline.name] : []),
    ...forwarded,
  ];
}

/**
 * Feed the crash-loop guard one finished pipeline run, under the universality rule
 * (#401/#420): a fast crash is evidence against the *engine commit* only once
 * every pipeline that ran it has fast-crashed. Until then it is one pipeline's problem,
 * and counting it would let a single broken tenant quarantine a commit the rest
 * of the fleet is running happily. Healthy runs are never gated — any pipeline
 * proving the commit boots is worth banking as the fallback target.
 */
function recordRunEnd(guard: CrashGuard): (run: FleetRun) => void {
  return (run) => {
    const outcome = runOutcome(run);
    if (outcome === null) return;
    if (!run.everyPipelineCrashLooping && judgeRun(outcome) === "crash") return;
    guard.record(outcome);
  };
}

/**
 * What a pipeline dying on its own means for the container. The loop asks only when
 * every supervised pipeline is crash-looping (#401), so by the time this runs the
 * question is "is this engine commit worth another try", not "did one tenant
 * misbehave". Only a guarded launch retries: a pinned ref that crashes takes the
 * container down, exactly as it did before there was a guard.
 */
function rowExitPolicy(guard: CrashGuard): PipelineExitPolicy {
  return {
    decide: (run) => {
      const outcome = run.engine.guarded ? runOutcome(run) : null;
      if (outcome === null || !guard.shouldRetry(outcome)) return "exit";
      console.log(
        `[phoebe] boot: relaunching the engine in ${Math.round(CRASH_BACKOFF_MS / 1000)}s — ` +
          `a last-good engine commit is available to fall back to.`,
      );
      // Through a fresh launch, which is where the fallback to the last-good
      // commit actually takes effect.
      return "relaunch";
    },
  };
}

/**
 * Per-tenant App token minting closure. Given a tenant's `repoSlug`, returns
 * the minted credentials and their expiry. Throws when minting fails — the
 * caller holds the tenant.
 */
type AppMintFn = (slug: string) => Promise<MintedToken & { mintedEnv: MintedCredentials }>;

/** How long before a minted token's expiry to proactively refresh it. */
const MINT_REFRESH_MARGIN_MS = 10 * 60 * 1000;

/**
 * Build a minted-env closure from App credentials and cached bot identity.
 * Caches the minted token per-tenant, only reminting when it is within
 * {@link MINT_REFRESH_MARGIN_MS} of expiry. Callers that receive a cached
 * result (same `expiresAt`) produce the same fingerprint, so the running child
 * is not restarted. A fresh mint changes `expiresAt`, which changes the
 * fingerprint, triggering a controlled restart that delivers the new token.
 */
function createAppMintFn(creds: AppCredentials, identity: AppBotIdentity): AppMintFn {
  const cache = new Map<string, MintedToken & { mintedEnv: MintedCredentials }>();

  return async (slug: string) => {
    const cached = cache.get(slug);
    if (cached !== undefined && cached.expiresAt - Date.now() > MINT_REFRESH_MARGIN_MS) {
      return cached;
    }
    const { token, expiresAt } = await mintInstallationToken(creds, slug);
    const mintedEnv: MintedCredentials = {
      GH_TOKEN: token,
      PHOEBE_GH_LOGIN: identity.login,
      GIT_AUTHOR_NAME: identity.gitName,
      GIT_AUTHOR_EMAIL: identity.gitEmail,
      GIT_COMMITTER_NAME: identity.gitName,
      GIT_COMMITTER_EMAIL: identity.gitEmail,
    };
    const result = { token, expiresAt, mintedEnv };
    cache.set(slug, result);
    return result;
  };
}

/**
 * Workspace-mode discover callback (#91/#137/#139/#209): re-read the root
 * `workspace` block *and* each child's config every poll, so adding or
 * removing one declared entry churns exactly that child. Reports hold ids for
 * mid-rewrite configs (#86) and for declared dirs that cannot become tenants
 * (explicit arm). When `appMint` is supplied, also mints per-repo installation
 * tokens for tenants whose `.env` carries no `GH_TOKEN` (#209).
 *
 * The block is only re-read for its *payload*: deleting it, or switching arms,
 * is a shape change this callback cannot absorb — it raises
 * {@link WorkspaceStructuralChangeError} so the supervisor drains and boot
 * re-runs the detection ladder. An unreadable root config or a malformed block
 * mid-write is unknown state, not an empty fleet: {@link WorkspaceTenantAxisSkip}
 * leaves the running fleet intact for this poll.
 */
function workspaceDiscover(
  configDir: string,
  configPath: string,
  initialWorkspace: ResolvedWorkspace,
  appMint?: AppMintFn,
): () => FleetDiscoverInput {
  let lastArm = workspaceArm(initialWorkspace);
  let previousHoldKey: string | null = null;
  let summaryLogged = false;
  /** Per-tenant id → last-known arm, for flip detection. */
  let previousTenantArms = new Map<string, CredentialArm>();

  const discoveryDeps = {
    loadRepoSlug: loadTenantRepoSlug,
    loadConfigDir: loadTenantConfigDir,
    loadGitIdentity: loadTenantGitIdentity,
    warn: (message: string) => console.warn(message),
  };

  const toFleetResult = async (
    workspace: ResolvedWorkspace,
    discovery: WorkspaceDiscoveryResult,
  ): Promise<FleetDiscoverResult> => {
    const samples: TenantSample[] = [];
    const mintFailedIds: string[] = [];

    for (const tenant of discovery.tenants) {
      if (appMint && tenant.slug !== null) {
        const tenantEnv = readTenantEnv(tenant.envPath);
        if (!tenantEnv["GH_TOKEN"]) {
          try {
            const { mintedEnv, expiresAt } = await appMint(tenant.slug);
            const configFp = tenantFingerprint(tenant.configPath, tenant.envPath);
            samples.push({
              tenant: { ...tenant, mintedEnv },
              // Include the token expiry in the fingerprint so that when the
              // cache refreshes (new expiresAt), diffFleet sees a change and
              // restarts the child with the updated token. Preserve the null
              // sentinel so a mid-rewrite config still blocks churning.
              fingerprint: configFp !== null ? `${configFp}|mint:${expiresAt}` : null,
            });
          } catch (error) {
            const diagnosis = error instanceof Error ? error.message : String(error);
            console.warn(`[phoebe] boot: tenant ${tenant.slug} held — mint failed: ${diagnosis}.`);
            mintFailedIds.push(tenant.id);
          }
          continue;
        }
      }
      samples.push({
        tenant,
        fingerprint: tenantFingerprint(tenant.configPath, tenant.envPath),
      });
    }

    const allHoldIds = [...reconcileHoldIds(discovery), ...mintFailedIds];
    const holdKey = [workspaceHoldKey(discovery.holds), mintFailedIds.join("\n")].join("|");
    if (!summaryLogged) {
      logWorkspaceBootSummary(configDir, workspace, discovery);
      if (mintFailedIds.length > 0) {
        console.warn(
          `[phoebe] boot: workspace: held ${mintFailedIds.length} tenant(s) — App token mint failed.`,
        );
      }
      summaryLogged = true;
      previousHoldKey = holdKey;
      for (const tenant of discovery.tenants) {
        previousTenantArms.set(tenant.id, tenantArm(tenant.envPath));
      }
    } else {
      // Detect arm flips — log a line for each tenant whose arm changed.
      const nextArms = new Map<string, CredentialArm>();
      for (const tenant of discovery.tenants) {
        const arm = tenantArm(tenant.envPath);
        nextArms.set(tenant.id, arm);
        const prev = previousTenantArms.get(tenant.id);
        if (prev !== undefined && prev !== arm) {
          const label = tenant.slug ?? tenant.id;
          console.log(`[phoebe] boot: tenant ${label} credential arm: ${prev} → ${arm}.`);
        }
      }
      previousTenantArms = nextArms;
      if (holdKey !== previousHoldKey) {
        logWorkspaceHoldSummary(configDir, workspace, discovery.holds);
        if (mintFailedIds.length > 0) {
          console.warn(
            `[phoebe] boot: workspace: held ${mintFailedIds.length} tenant(s) — App token mint failed.`,
          );
        }
        previousHoldKey = holdKey;
      }
    }
    return { samples, hold: allHoldIds };
  };

  return async () => {
    const rootFingerprint = configFingerprint(configPath);
    let rootConfig: Record<string, unknown>;
    try {
      if (rootFingerprint === null) {
        throw new WorkspaceTenantAxisSkip(
          "root phoebe.config.ts is unreadable — skipping the tenant axis this poll",
        );
      }
      rootConfig = await loadMountedConfig(configPath, rootFingerprint);
    } catch (error) {
      if (error instanceof WorkspaceTenantAxisSkip) throw error;
      console.warn(
        `[phoebe] boot: could not read root config — ${describe(error)}. ` +
          "Skipping the tenant axis this poll (the running fleet is left intact).",
      );
      throw new WorkspaceTenantAxisSkip(describe(error));
    }

    let workspace: ResolvedWorkspace | null;
    try {
      workspace = resolveWorkspace(rootConfig, { root: configDir });
    } catch (error) {
      console.warn(
        `[phoebe] boot: malformed workspace block — ${describe(error)}. ` +
          "Skipping the tenant axis this poll (the running fleet is left intact).",
      );
      throw new WorkspaceTenantAxisSkip(describe(error));
    }

    if (workspace === null) {
      throw new WorkspaceStructuralChangeError(
        "workspace block deleted from phoebe.config.ts — draining the fleet and restarting boot",
      );
    }

    const arm = workspaceArm(workspace);
    if (arm !== lastArm) {
      throw new WorkspaceStructuralChangeError(
        "workspace discovery arm switched (depth ⇄ tenants) — draining the fleet and restarting boot",
      );
    }
    lastArm = arm;

    const discovery = await discoverWorkspaceTenants(configDir, workspace, discoveryDeps);
    return toFleetResult(workspace, discovery);
  };
}

function workspaceHoldKey(holds: readonly WorkspaceHold[]): string {
  return holds
    .map((hold) => `${hold.dir}\0${hold.reason}`)
    .sort()
    .join("\n");
}

function reconcileHoldIds(result: WorkspaceDiscoveryResult): string[] {
  return result.holds.map((hold) => hold.dir);
}

/**
 * One tenant's credential arm: its own `.env` weighed against the supervisor's
 * env, which is the only place the deployment's App key lives.
 */
function tenantArm(envPath: string): CredentialArm {
  return resolveCredentialArm(readTenantEnv(envPath), process.env);
}

/**
 * Build the arm tally suffix for the workspace boot summary line, e.g.
 * " (2 pat, 1 app)" or " (3 pat)". Empty string when there are no tenants.
 */
function buildArmTally(tenants: readonly DiscoveredTenant[]): string {
  if (tenants.length === 0) return "";
  let pat = 0;
  let app = 0;
  for (const tenant of tenants) {
    if (tenantArm(tenant.envPath) === "pat") pat++;
    else app++;
  }
  const parts: string[] = [];
  if (pat > 0) parts.push(`${pat} pat`);
  if (app > 0) parts.push(`${app} app`);
  return ` (${parts.join(", ")})`;
}

function logWorkspaceBootSummary(
  configDir: string,
  workspace: ResolvedWorkspace,
  result: WorkspaceDiscoveryResult,
): void {
  const armTally = buildArmTally(result.tenants);
  if (isExplicitWorkspace(workspace)) {
    const declared = workspace.tenants.length;
    const suffix = declared === 0 ? " (empty declared fleet)" : "";
    const message =
      `[phoebe] boot: workspace mode — supervising ${result.tenants.length} of ${declared} ` +
      `declared tenant(s) on one shared engine${armTally}${suffix}.`;
    if (declared === 0) console.warn(message);
    else console.log(message);
  } else {
    const depthAndTally =
      armTally.length > 0
        ? `(depth ${workspace.depth}, ${armTally.slice(2, -1)})`
        : `(depth ${workspace.depth})`;
    console.log(
      `[phoebe] boot: workspace mode — supervising ${result.tenants.length} tenant(s) ` +
        `on one shared engine ${depthAndTally}.`,
    );
  }
  if (result.holds.length > 0) {
    console.warn(formatWorkspaceHoldSummary(configDir, workspace, result.holds));
  }
}

function logWorkspaceHoldSummary(
  configDir: string,
  workspace: ResolvedWorkspace,
  holds: readonly WorkspaceHold[],
): void {
  console.warn(formatWorkspaceHoldSummary(configDir, workspace, holds));
}

function formatWorkspaceHoldSummary(
  configDir: string,
  workspace: ResolvedWorkspace,
  holds: readonly WorkspaceHold[],
): string {
  if (holds.length === 0) {
    return "[phoebe] boot: workspace: no held tenants.";
  }
  const label = isExplicitWorkspace(workspace) ? "declared tenant(s)" : "tenant(s)";
  const parts = holds.map((hold) => {
    const rel = relative(configDir, hold.dir).replace(/\\/g, "/");
    const name = rel.length > 0 ? rel : hold.dir;
    return `${name} (${hold.reason})`;
  });
  return `[phoebe] boot: workspace: held ${holds.length} ${label}: ${parts.join(", ")}.`;
}

/**
 * Load one workspace child's config as the arbitrary record the bootstrapper
 * treats it as. Throws when the file will not load — the walker turns that into
 * skip-and-warn + hold. The fingerprint doubles as `loadUserConfig`'s cache key,
 * so the per-field readers below share one parse per config per poll.
 */
async function loadTenantConfig(configPath: string): Promise<Record<string, unknown>> {
  const fingerprint = configFingerprint(configPath);
  if (fingerprint === null) {
    throw new Error(`config unreadable at ${configPath}`);
  }
  const user = await loadUserConfig(configPath, { reloadKey: fingerprint });
  return user as unknown as Record<string, unknown>;
}

/**
 * Load a workspace child config and return its authoritative `repoSlug`.
 * Throws when the file will not load or the slug is missing — the walker
 * treats that as skip-and-warn + hold.
 */
async function loadTenantRepoSlug(configPath: string): Promise<string> {
  const slug = (await loadTenantConfig(configPath))["repoSlug"];
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error(`missing or empty repoSlug in ${configPath}`);
  }
  return slug.trim();
}

/**
 * Load a tenant config and return its bootstrapper-only `configDir` (#98), or
 * "." when unset. A malformed value throws and the workspace walker treats that
 * as skip-and-warn.
 */
async function loadTenantConfigDir(configPath: string): Promise<string> {
  return readConfigDir(await loadTenantConfig(configPath));
}

/**
 * Load a tenant config and return its bootstrapper-only `gitIdentity` (#199),
 * or null when unset. A malformed value throws and the workspace walker treats
 * that as skip-and-warn — a repo that declared how its commits are attributed
 * and got it wrong must not fall back to committing under the deployment's
 * identity.
 */
async function loadTenantGitIdentity(configPath: string): Promise<GitIdentity | null> {
  return readGitIdentity(await loadTenantConfig(configPath));
}

/**
 * One tenant's reconcile fingerprint: its config *and* its co-located `.env`,
 * so a secrets-only edit relaunches the child (the env scrub reads `.env` at
 * spawn, #61) — with one deliberate blind spot: the `.env` half is a content
 * digest that excludes `GH_TOKEN` (#205), so rotating the PAT alone moves
 * nothing here. The rotated token is delivered in place by the credential
 * lease (`attachCredentialHandler`'s live read); every other `.env` value has
 * no live channel and keeps the relaunch. A null config fingerprint stays
 * null — "unknown", never a change (`diffFleet`) — so a mid-rewrite config
 * does not churn the child; a present config with an absent/unreadable `.env`
 * is a stable `"<config>:"`.
 */
export function tenantFingerprint(configPath: string, envPath: string): string | null {
  const config = configFingerprint(configPath);
  if (config === null) return null;
  let envDigest: string;
  try {
    envDigest = envReconcileDigest(readFileSync(envPath, "utf8"));
  } catch {
    envDigest = "";
  }
  return `${config}:${envDigest}`;
}

/**
 * `phoebe boot` entry. Loads the mounted config, resolves the engine source to a
 * runnable `src/cli.ts` — a local mount or a github checkout — execs the engine
 * as a long-lived child, and supervises it: reconcile relaunches on a config or
 * ref change, the crash-loop guard pins back to the last-good commit when the
 * tracked ref will not boot, and a container stop drains it and exits with its
 * status. Extra args after `boot` are forwarded to the engine (none ⇒ the
 * persistent loop).
 */
export async function runBoot(argv: readonly string[]): Promise<void> {
  // Before any engine git call (ensureClone, fetch/push, agent child): one
  // global github.com credential helper from GH_TOKEN. Survives reconcile
  // relaunches via ~/.gitconfig + the agent-env HOME/GH_TOKEN allowlist.
  setupGitCredentials({});

  const configDir = process.cwd();
  const configPath = resolveConfigPath(undefined, configDir);
  const guard = createBootCrashGuard();
  const intervalMs = reconcileIntervalMs();

  // The container's stop request. A one-way latch, and the poll clock: a
  // SIGTERM mid-poll wakes the watch immediately instead of sleeping out the
  // interval. Holding these listeners also keeps boot alive across the moment
  // between an engine exiting and its replacement spawning, where the child's
  // own forwarders are not installed.
  const stop = installDrainSignal(process, ["SIGTERM", "SIGINT"]);

  // One slot broker for the whole container, both arms (#416/#407). It is the
  // only entity that sees every pipeline, which is what makes it the fairness
  // authority; two of them would be two caps blind to each other.
  //
  // Its capacity is derived from the live pipelines (`trackPipelines`), so a solo tenant
  // declaring `pipelines.work.concurrency: 3` gets 3 rather than a silent 1.
  // Until the first pipeline matrix arrives there is nothing to derive from and no
  // child to ask, so it starts at the operator's override or 1.
  const broker = createSlotBroker({
    capacity: resolveEffectiveCap([], process.env).capacity,
    floorBudget: resolveFloorBudget(process.env),
    onOverGrant: ({ label, inUse, capacity, outstanding, floorBudget }) =>
      console.log(
        `[phoebe] boot: slot floor — ${label} held no slot with work waiting; granting one ` +
          `over the cap (in use ${inUse}, cap ${capacity}, floor ${outstanding}/${floorBudget}).`,
      ),
    onOverGrantReturned: ({ label, inUse, capacity, outstanding, floorBudget }) =>
      console.log(
        `[phoebe] boot: slot floor — the over-cap slot held by ${label} is free again ` +
          `(in use ${inUse}, cap ${capacity}, floor ${outstanding}/${floorBudget}).`,
      ),
  });

  // Detection ladder (#83/#91): loaded root config has a `workspace` block →
  // workspace mode; else solo. The root config is loaded here for the mode
  // decision; `launchTarget` still re-reads on each (re)launch for the engine
  // source + cache bust.
  const rootFingerprint = configFingerprint(configPath);
  const rootConfig = await loadMountedConfig(configPath, rootFingerprint);
  const workspace = resolveWorkspace(rootConfig, { root: configDir });

  if (workspace !== null) {
    // GitHub App mode (#209): if the supervisor holds App credentials, fetch
    // the bot identity once at fleet startup and wire up a per-tenant mint fn.
    // Tenants with their own GH_TOKEN are untouched; tenants without one get a
    // scoped installation token each poll. A failed identity fetch disables App
    // mode gracefully — each tenant must then carry its own GH_TOKEN.
    let appMint: AppMintFn | undefined;
    const appCreds = readAppCredentials(process.env);
    if (appCreds) {
      try {
        const identity = await fetchAppBotIdentity(appCreds);
        console.log(`[phoebe] boot: GitHub App mode active — minting tokens as ${identity.login}.`);
        appMint = createAppMintFn(appCreds, identity);
      } catch (error) {
        console.warn(
          `[phoebe] boot: could not fetch App bot identity — ${describe(error)}. ` +
            `App mode disabled; each tenant must carry its own GH_TOKEN.`,
        );
      }
    }

    let fleetExit: EngineExit;
    try {
      fleetExit = await runFleet({
        configPath,
        guard,
        stop,
        intervalMs,
        argv,
        broker,
        // The root `workspace` block is re-read every poll from here on: this
        // callback owns both the hot tenant list and the shape-change abort (#139).
        discover: workspaceDiscover(configDir, configPath, workspace, appMint),
      });
    } catch (error) {
      if (error instanceof WorkspaceStructuralChangeError) {
        console.error(`[phoebe] boot: ${error.message}`);
        propagateExit(1, null);
        return;
      }
      throw error;
    } finally {
      stop.dispose();
    }
    propagateExit(fleetExit.code, fleetExit.signal);
    return;
  }

  // Not a workspace ⇒ solo: a one-tenant fleet, the root config run in place.
  // `discoverTenants` refuses a root that carries the removed `repos/` layout by
  // name, rather than reading it as a solo deployment whose config is missing
  // every per-repo field.
  const soloTenant = discoverTenants(configDir).tenants[0];

  // Solo: log the credential arm once at first spawn. The root *is* the tenant
  // here, so the ambient env serves as both the tenant and the deployment env.
  console.log(
    `[phoebe] boot: credential arm: ${resolveCredentialArm(process.env as Record<string, string | undefined>)}.`,
  );

  // Lease bookkeeping shared across engine relaunches (#211): unused while solo
  // answers the null no-op, but the handler's contract wants both.
  const soloCredentialCache: CredentialCache = new Map();
  const soloWarnedOverBudget = new Set<string>();

  // Solo's arm of the #199 ladder: the root *is* the tenant, so the ambient
  // container env is that tenant's own env-file — it wins every identity var it
  // sets, and the declared `gitIdentity` fills the rest.
  //
  // One mutable cell, written by the launcher and read by the spawner. The
  // identity must be re-read per launch, but `spawn` is synchronous while the
  // read is not — so it happens in `launch`, which the supervision loop always
  // runs first (supervise-fleet.ts). Seeded from the config boot already loaded
  // so the cell is never unset. A malformed value fails the launch (fatal at
  // boot, retried next poll on a relaunch) — never a silent fall back to
  // whatever identity the deployment happens to carry.
  let soloIdentity: GitIdentity | null = readGitIdentity(rootConfig);
  const launchSolo = async (): Promise<LaunchedEngine> => {
    soloIdentity = readGitIdentity(
      await loadMountedConfig(configPath, configFingerprint(configPath)),
    );
    return launchTarget(configPath, guard);
  };

  const spawnSolo = (pipeline: SupervisedPipeline, engine: LaunchedEngine): FleetChild => {
    let settle!: (exit: EngineExit) => void;
    const exited = new Promise<EngineExit>((resolve) => {
      settle = resolve;
    });
    const { env, overridden } = soloIdentityEnv(process.env, soloIdentity);
    // Solo's arm of the subtractive pipeline scrub (#425). There is no per-tenant
    // `.env` here — the container env *is* the tenant's — so the subtraction
    // runs against what the child would otherwise inherit. Materializing a copy
    // is the only way to take a key away from an inherited env, so a pipeline with
    // nothing to scrub keeps the null: the child then inherits verbatim, as it
    // always has.
    const scrubKeys = siblingOnlyEnvKeys(pipeline);
    const childEnv = env ?? (scrubKeys.length > 0 ? { ...process.env } : null);
    if (childEnv !== null) {
      for (const key of scrubKeys) delete childEnv[key];
    }
    if (soloIdentity !== null && overridden.length > 0) {
      // The declaration lost, which is the rule — but say so. A leftover
      // `GIT_AUTHOR_NAME` on the container env would otherwise make a repo's
      // declared attribution quietly inert (#199).
      console.warn(
        `[phoebe] boot: gitIdentity declares ${soloIdentity.name} <${soloIdentity.email}>, ` +
          `but this deployment's env already sets ${overridden.join(", ")} — the env wins ` +
          `(in solo it is this tenant's own env-file). Unset those vars to use the declaration.`,
      );
    }
    // Solo's config is the root's, resolved from cwd exactly as it always was:
    // `relocated` is false, so this argv is today's plus the pipeline's `--pipeline`.
    const child = spawnSoloChild(engine.entry, rowArgv(pipeline, configPath, false, argv), {
      // Null when neither a `gitIdentity` nor a sibling declaration asked for a
      // change: the child then inherits the supervisor's env exactly as it
      // always has.
      ...(childEnv === null ? {} : { env: childEnv }),
      onExit: (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }),
      onSpawnError: (error: Error) => {
        console.error(`[phoebe] boot: engine failed to spawn — ${error.message}`);
        settle({ code: 1, signal: null });
      },
    });
    attachBroker({ owner: pipeline.id, broker, child });
    // Answer the child's credential lease (#211) with the null no-op: solo is
    // one trust domain whose secrets arrive on the ambient container env, so
    // there is no per-tenant `.env` to re-read (#205's rotation-in-place has no
    // solo arm — #159) and nothing to mint supervisor-side (a solo App-arm
    // child mints its own token in-loop when the lease yields nothing).
    // Without an answerer the child would hang forever on its first request.
    attachCredentialHandler({
      tenantId: pipeline.id,
      child,
      cache: soloCredentialCache,
      mint: null,
      warnedOverBudget: soloWarnedOverBudget,
    });
    return { kill: (signal) => child.kill(signal), exited };
  };

  let exit: EngineExit;
  try {
    exit = await superviseFleet({
      launch: launchSolo,
      // Solo's tenant axis stays inert: the root *is* the tenant, so every edit
      // to its config is already the engine axis's business (relaunch on a moved
      // engine source, a silent rebase otherwise, #138). A constant fingerprint
      // keeps it that way — the pipelines the engine enumerates at launch are the
      // pipelines solo runs until something re-materializes the engine.
      discover: () => [{ tenant: soloTenant, fingerprint: SOLO_TENANT_FINGERPRINT }],
      spawn: spawnSolo,
      stop,
      intervalMs,
      // Solo contends on the same broker, so its pipelines size and order it too:
      // one tenant, but its own pipelines' `concurrency` and `priority`.
      onPipelines: trackPipelines(broker),
      // Solo backs off on the engine constant, not the fleet's per-pipeline one: the
      // relaunch line quotes it, so the two must not drift.
      crashBackoffMs: CRASH_BACKOFF_MS,
      onRunEnd: recordRunEnd(guard),
      onRunTick: ({ engine, elapsedMs }) => {
        if (engine.sha !== null) guard.noteAlive(engine.sha, elapsedMs);
      },
      // The universality rule over a one-pipeline fleet: that pipeline *is* the engine, so
      // every death of it is universal and reaches the policy — which is how
      // "the engine exited, so the container exits" is still what solo does.
      rowExit: { ...rowExitPolicy(guard), propagateOnStop: true },
      onEngineChange: (reason) =>
        console.log(
          reason === "config"
            ? "[phoebe] boot: mounted config changed — draining the engine (SIGTERM) and relaunching."
            : "[phoebe] boot: tracked ref advanced — draining the engine (SIGTERM) and relaunching.",
        ),
      onLaunchError: (error) =>
        console.error(
          `[phoebe] boot: could not launch the engine — ${describe(error)}. Retrying next poll.`,
        ),
      onSampleError: (error) =>
        console.warn(`[phoebe] boot: reconcile poll failed — ${describe(error)}. Ignoring.`),
    });
  } finally {
    // Drop the listeners before propagating: re-raising the engine's killing
    // signal must actually kill this process, and our own latch would swallow it.
    stop.dispose();
  }
  propagateExit(exit.code, exit.signal);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
