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
// (reconcile.ts, #42) polls the mounted config and the tracked ref, and when
// either moves it drains the engine, re-resolves the source, and relaunches —
// same container, no interrupted work unit. Following a branch also means
// eventually following it onto a commit that will not boot, so every launch
// passes through the crash-loop guard (crash-loop.ts, #43): a tip that dies fast
// enough times is quarantined and boot materializes the last commit that ran
// healthily instead. This module is the wiring; the loop lives in reconcile.ts,
// the fallback policy in crash-loop.ts, and everything impure is passed in from
// here.

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
  type CrashGuard,
  type CrashGuardEvent,
  type RunOutcome,
} from "./crash-loop.ts";
import { readEngineSource, type ResolvedEngineSource } from "./engine-source.ts";
import { lsRemoteBranchSha, materializeGithubEngine } from "./github-engine.ts";
import { buildEngineChildEnv, parseDotenv } from "./engine-child-env.ts";
import {
  fetchAppBotIdentity,
  mintInstallationToken,
  readAppCredentials,
  type AppBotIdentity,
  type AppCredentials,
} from "./github-app.ts";
import { attachBroker } from "./broker-ipc.ts";
import { createSlotBroker, resolveMaxConcurrent } from "./slot-broker.ts";
import {
  assertNotRemovedReposLayout,
  discoverWorkspaceTenants,
  WorkspaceStructuralChangeError,
  WorkspaceTenantAxisSkip,
  type DiscoveredTenant,
  type WorkspaceDiscoveryResult,
  type WorkspaceHold,
  type FleetDiscoverResult,
  type TenantSample,
} from "./tenants.ts";
import { readConfigDir } from "./config-dir.ts";
import { superviseFleet, type FleetChild, type FleetDiscoverInput } from "./supervise-fleet.ts";
import {
  isExplicitWorkspace,
  resolveWorkspace,
  workspaceArm,
  type ResolvedWorkspace,
} from "./workspace-source.ts";
import { readFileSync } from "node:fs";
import {
  configFingerprint,
  superviseEngine,
  CRASH_BACKOFF_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  type EngineExit,
  type EngineRun,
  type LaunchedEngine,
  type SupervisedChild,
} from "./reconcile.ts";
// Untyped plain-JS import (see spawn-engine.mjs / materialize.mjs for why the
// bootstrapper's child-process plumbing can't be TypeScript).
import { propagateExit, spawnEngine, spawnEngineChild } from "./spawn-engine.mjs";

/** Where the local-engine compose overlay mounts the engine for `source: "local"`. */
export const LOCAL_ENGINE_DIR = "/opt/phoebe-engine";

/**
 * Runs `gh` with the given argv. Injectable so boot's credential-helper setup is
 * unit-tested without a real `gh` binary or a writable `~/.gitconfig`.
 */
export type GhRunner = (args: readonly string[]) => void;

export const defaultGh: GhRunner = (args) => {
  execFileSync("gh", args, { stdio: "inherit" });
};

/**
 * Configure a global git credential helper from `GH_TOKEN` so every later git
 * call against github.com authenticates — the engine's `ensureClone` /
 * `fetchOrigin` / `pushBranch`, and the agent child's own `git push`/`fetch`.
 *
 * Uses `gh auth setup-git --hostname github.com`, which writes a
 * `!gh auth git-credential` helper into `~/.gitconfig`. That helper reads
 * `GH_TOKEN` live per call, so no secret is written to disk and token rotation
 * keeps working. Only `github.com` is configured (Phoebe is github-only).
 *
 * Skipped when no token is present (public/anonymous path unchanged). A failed
 * setup warns and continues — a missing helper is better diagnosed at the first
 * private-repo clone than by aborting the container here.
 */
export function setupGitCredentials(deps: {
  token: string | undefined;
  gh?: GhRunner;
  warn?: (message: string) => void;
}): void {
  if (!deps.token) return;
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
 * Spawn the engine and expose it as the supervisor's child handle. Both a normal
 * exit and a spawn failure settle `exited` — the failure as a non-zero exit — so
 * the supervisor always sees the child resolve and decides what to do (a
 * first-launch failure is fatal, a relaunch failure retries). Without the
 * `onSpawnError` override, spawn-engine.mjs's default would `process.exit(1)`
 * here, bypassing boot's drain-latch teardown and leaving `exited` pending.
 */
function spawnSupervised(entry: string, argv: readonly string[]): SupervisedChild {
  let settle!: (exit: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  const child = spawnEngine(entry, argv, {
    onExit: (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }),
    onSpawnError: (error: Error) => {
      console.error(`[phoebe] boot: engine failed to spawn — ${error.message}`);
      settle({ code: 1, signal: null });
    },
  });
  return { kill: (signal) => child.kill(signal), exited };
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

/**
 * Supervise a workspace multi-tenant deployment (#58/#59/#61/#91): a
 * shared engine (#60, materialized once by `launchTarget` from the top config's
 * `engine` field) with one child per tenant, a global concurrency broker across
 * them, and hot add/remove/change via `superviseFleet`.
 *
 * Each child is spawned with an IPC channel + the tenant's scrubbed env (#61)
 * and cwd (its config dir), and wired to the broker (#59). The crash-loop guard
 * still applies any existing engine fallback on each (re)launch; feeding the
 * guard fleet-aggregated crash verdicts (#60 §6) is a follow-up — live fleet
 * validation is deferred to #77.
 *
 * `discover` is injected rather than called directly so the reconcile loop stays
 * testable against a fake fleet: today's one caller re-walks the workspace tree
 * and reloads each child's `repoSlug` every poll (#91).
 */
function runFleet(opts: {
  configPath: string;
  guard: CrashGuard;
  stop: ReturnType<typeof installDrainSignal>;
  intervalMs: number;
  argv: readonly string[];
  discover: () => FleetDiscoverInput;
}): Promise<EngineExit> {
  const broker = createSlotBroker(resolveMaxConcurrent(process.env));

  const spawnFleetChild = (tenant: DiscoveredTenant, engine: LaunchedEngine): FleetChild => {
    const env = buildEngineChildEnv({
      base: process.env,
      mintedEnv: tenant.mintedEnv,
      tenantEnv: readTenantEnv(tenant.envPath),
    });
    let settle!: (exit: EngineExit) => void;
    const exited = new Promise<EngineExit>((resolve) => {
      settle = resolve;
    });
    const label = tenant.slug ?? tenant.id;
    // The child's cwd is the tenant's asset dir (#98): `dirname(envPath)`, which
    // is `tenant.dir` unless `configDir` relocated the `.env` (e.g. into
    // `.phoebe/`). When relocated, cwd is not where the config lives, so pass
    // `--config` explicitly (the child's CLI resolves config from cwd otherwise
    // — and `--config` always wins). Relative `promptFiles` then resolve under
    // the asset dir. The default path (co-located) is byte-for-byte unchanged.
    const assetsDir = dirname(tenant.envPath);
    const relocated = assetsDir !== tenant.dir;
    const argv = relocated ? ["--config", tenant.configPath, ...opts.argv] : opts.argv;
    const child = spawnEngineChild(engine.entry, argv, {
      env,
      cwd: assetsDir,
      onExit: (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }),
      onSpawnError: (error: Error) => {
        console.error(`[phoebe] boot: tenant ${label} failed to spawn — ${error.message}`);
        settle({ code: 1, signal: null });
      },
    });
    attachBroker({ owner: tenant.id, broker, child });
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
          ? "[phoebe] boot: shared config changed — draining the fleet and relaunching every tenant."
          : "[phoebe] boot: tracked engine ref advanced — draining the fleet and relaunching every tenant.",
      ),
    onTenantChange: ({ added, removed, changed }) =>
      console.log(
        `[phoebe] boot: tenant reconcile — +${added.length} added, -${removed.length} removed, ` +
          `~${changed.length} relaunched (no container restart).`,
      ),
    onChildExit: ({ tenantId, exit }) =>
      console.error(
        `[phoebe] boot: tenant ${tenantId} exited (${exit.code ?? exit.signal}) — ` +
          `respawning with backoff (per-tenant supervision; the shared engine is untouched).`,
      ),
    onLaunchError: (error) =>
      console.error(`[phoebe] boot: fleet (re)launch failed — ${describe(error)}. Retrying.`),
    onDiscoverError: (error) =>
      console.warn(
        `[phoebe] boot: tenant discovery failed — ${describe(error)}. ` +
          `Skipping the tenant axis this poll (the running fleet is left intact).`,
      ),
  });
}

/**
 * Per-tenant App token minting closure. Given a tenant's `repoSlug`, returns
 * a minted env record containing GH_TOKEN, PHOEBE_GH_LOGIN, and the fallback
 * git identity. Throws when minting fails — the caller holds the tenant.
 */
type AppMintFn = (slug: string) => Promise<Record<string, string>>;

/**
 * Build a minted-env record from App credentials and cached bot identity.
 * Called once per tenant per poll when the tenant has no GH_TOKEN of its own.
 */
function createAppMintFn(creds: AppCredentials, identity: AppBotIdentity): AppMintFn {
  return async (slug: string) => {
    const token = await mintInstallationToken(creds, slug);
    return {
      GH_TOKEN: token,
      PHOEBE_GH_LOGIN: identity.login,
      GIT_AUTHOR_NAME: identity.gitName,
      GIT_AUTHOR_EMAIL: identity.gitEmail,
      GIT_COMMITTER_NAME: identity.gitName,
      GIT_COMMITTER_EMAIL: identity.gitEmail,
    };
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

  const discoveryDeps = {
    loadRepoSlug: loadTenantRepoSlug,
    loadConfigDir: loadTenantConfigDir,
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
            const mintedEnv = await appMint(tenant.slug);
            samples.push({
              tenant: { ...tenant, mintedEnv },
              fingerprint: tenantFingerprint(tenant.configPath, tenant.envPath),
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
    } else if (holdKey !== previousHoldKey) {
      logWorkspaceHoldSummary(configDir, workspace, discovery.holds);
      if (mintFailedIds.length > 0) {
        console.warn(
          `[phoebe] boot: workspace: held ${mintFailedIds.length} tenant(s) — App token mint failed.`,
        );
      }
      previousHoldKey = holdKey;
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

function logWorkspaceBootSummary(
  configDir: string,
  workspace: ResolvedWorkspace,
  result: WorkspaceDiscoveryResult,
): void {
  if (isExplicitWorkspace(workspace)) {
    const declared = workspace.tenants.length;
    const suffix = declared === 0 ? " (empty declared fleet)" : "";
    const message =
      `[phoebe] boot: workspace mode — supervising ${result.tenants.length} of ${declared} ` +
      `declared tenant(s) on one shared engine${suffix}.`;
    if (declared === 0) console.warn(message);
    else console.log(message);
  } else {
    console.log(
      `[phoebe] boot: workspace mode — supervising ${result.tenants.length} tenant(s) ` +
        `on one shared engine (depth ${workspace.depth}).`,
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
 * Load a workspace child config and return its authoritative `repoSlug`.
 * Throws when the file will not load or the slug is missing — the walker
 * treats that as skip-and-warn + hold.
 */
async function loadTenantRepoSlug(configPath: string): Promise<string> {
  const fingerprint = configFingerprint(configPath);
  if (fingerprint === null) {
    throw new Error(`config unreadable at ${configPath}`);
  }
  const user = await loadUserConfig(configPath, { reloadKey: fingerprint });
  const slug = user.repoSlug;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error(`missing or empty repoSlug in ${configPath}`);
  }
  return slug.trim();
}

/**
 * Load a tenant config and return its bootstrapper-only `configDir` (#98), or
 * "." when unset. Throws when the config will not load or the value is
 * malformed — the workspace walker treats that as skip-and-warn. Reuses
 * `loadUserConfig`'s fingerprint cache, so this does
 * not re-read a config the slug load already parsed this poll.
 */
async function loadTenantConfigDir(configPath: string): Promise<string> {
  const fingerprint = configFingerprint(configPath);
  if (fingerprint === null) {
    throw new Error(`config unreadable at ${configPath}`);
  }
  const user = await loadUserConfig(configPath, { reloadKey: fingerprint });
  return readConfigDir(user as unknown as Record<string, unknown>);
}

/**
 * One tenant's reconcile fingerprint: its config *and* its co-located `.env`,
 * so a secrets-only edit relaunches the child (the env scrub reads `.env` at
 * spawn, #61). A null config fingerprint stays null — "unknown", never a change
 * (`diffFleet`) — so a mid-rewrite config does not churn the child; a present
 * config with an absent `.env` is a stable `"<config>:"`.
 */
function tenantFingerprint(configPath: string, envPath: string): string | null {
  const config = configFingerprint(configPath);
  if (config === null) return null;
  return `${config}:${configFingerprint(envPath) ?? ""}`;
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
  setupGitCredentials({ token: process.env["GH_TOKEN"] });

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

  // Not a workspace ⇒ solo, the single-tenant fast-path below: one engine child,
  // no scanning. One guard first — a root that carries the removed `repos/`
  // layout is refused by name here, rather than read as a solo deployment whose
  // config is missing every per-repo field.
  assertNotRemovedReposLayout(configDir);

  let exit: EngineExit;
  try {
    exit = await superviseEngine({
      launch: () => launchTarget(configPath, guard),
      spawn: (entry) => spawnSupervised(entry, argv),
      stop,
      intervalMs,
      onRunEnd: (run) => {
        const outcome = runOutcome(run);
        if (outcome !== null) guard.record(outcome);
      },
      onRunTick: ({ engine, elapsedMs }) => {
        if (engine.sha !== null) guard.noteAlive(engine.sha, elapsedMs);
      },
      relaunchAfterExit: (run) => {
        // Only a guarded launch retries: a pinned ref that crashes takes the
        // container down, exactly as it did before there was a guard.
        const outcome = run.engine.guarded ? runOutcome(run) : null;
        if (outcome === null || !guard.shouldRetry(outcome)) return false;
        console.log(
          `[phoebe] boot: relaunching the engine in ${Math.round(CRASH_BACKOFF_MS / 1000)}s — ` +
            `a last-good engine commit is available to fall back to.`,
        );
        return true;
      },
      onRelaunch: (reason) =>
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
