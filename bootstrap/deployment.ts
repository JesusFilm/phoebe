// The mode ladder (#66/#83, map #39) — how `phoebe boot` decides *what* to
// supervise, and builds the deps `supervise` (supervise.ts) needs to run it.
//
// A deployment is workspace XOR nested XOR flat (`bootstrap/tenants.ts`):
//   - the loaded root config carries a `workspace` block → workspace mode
//     (warns and ignores any `repos/` dir beside it);
//   - else a `repos/` dir beside the root config → nested;
//   - else → flat, the top config's own dir, run in place.
//
// `resolveDeployment` owns everything that varies by topology: the three
// discover adapters (nested/workspace scan the tree; flat's is a constant
// one-tenant list), the two spawn adapters (flat execs in place with no `cwd`
// override — the byte-identity guarantee from #64 — nested/workspace spawn
// into the tenant's dir and relocate `--config` when its assets moved, #98),
// and each topology's `onChildGone` policy (flat asks the crash-loop guard
// whether a retry is worth it; a fleet child always respawns with backoff,
// #60 §6).
//
// It does *not* own resolving an engine source to something runnable — that
// is `launchTarget` (boot.ts), shared byte-for-byte across every topology and
// wired in here as `launch`, not reimplemented.
//
// `runBoot` (boot.ts) is the composition root: install the stop latch →
// `resolveDeployment` → `supervise` → `propagateExit`. Everything impure this
// module needs — the crash-loop guard, and the two `spawn-engine.mjs`
// launchers — is injectable, defaulting to the real thing, so the ladder and
// both spawn adapters are unit-tested without a container.

import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { parseDotenv } from "../src/dotenv.ts";
import { loadUserConfig, resolveConfigPath } from "../src/config/index.ts";
import { attachBroker, type BrokerChild } from "./broker-ipc.ts";
import { createBootCrashGuard, engineProvenanceEnv, launchTarget } from "./boot.ts";
import { readConfigDir } from "./config-dir.ts";
import type { CrashGuard } from "./crash-loop.ts";
import { childEnv } from "./engine-child-env.ts";
import { createSlotBroker, resolveMaxConcurrent } from "./slot-broker.ts";
// Untyped plain-JS import (see spawn-engine.mjs for why the bootstrapper's
// child-process plumbing can't be TypeScript).
import {
  spawnEngine as defaultSpawnEngine,
  spawnEngineChild as defaultSpawnEngineChild,
} from "./spawn-engine.mjs";
import {
  configFingerprint,
  CHILD_RESPAWN_BACKOFF_MS,
  type DiscoverInput,
  type EngineExit,
  type LaunchedEngine,
  type SupervisedChild,
  type SuperviseDeps,
} from "./supervise.ts";
import {
  discoverTenants,
  discoverWorkspaceTenants,
  isFatalWorkspaceDiscoveryError,
  type DiscoveredTenant,
  type WorkspaceDiscoveryResult,
  type WorkspaceHold,
} from "./tenants.ts";
import {
  isExplicitWorkspace,
  resolveWorkspace,
  type ResolvedWorkspace,
} from "./workspace-source.ts";

/** A running child process, as far as a spawn adapter needs it. */
type SpawnedProcess = { kill: (signal: NodeJS.Signals) => void };

/** Injectable stand-in for `spawn-engine.mjs`'s `spawnEngine` (flat). */
type SpawnEngineFn = (
  entry: string,
  args: readonly string[],
  opts: {
    env?: Record<string, string>;
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
    onSpawnError?: (error: Error) => void;
  },
) => SpawnedProcess;

/** Injectable stand-in for `spawn-engine.mjs`'s `spawnEngineChild` (nested/workspace). */
type SpawnEngineChildFn = (
  entry: string,
  args: readonly string[],
  opts: {
    env?: Record<string, string>;
    cwd?: string;
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
    onSpawnError?: (error: Error) => void;
  },
) => SpawnedProcess & BrokerChild;

/** What `resolveDeployment` builds: everything `supervise` needs except the
 *  container-wide stop latch and poll/drain timings (runBoot owns those —
 *  they do not vary by topology). */
export type Deployment = Omit<
  SuperviseDeps<DiscoveredTenant>,
  "stop" | "intervalMs" | "drainTimeoutMs"
>;

export type ResolveDeploymentOpts = {
  /** The mounted deployment root — holds the top `phoebe.config.ts`, and (for
   *  nested) any `repos/` dir. */
  configDir: string;
  /** Read for `PHOEBE_MAX_CONCURRENT_AGENTS` (the fleet broker's cap) and
   *  handed to every spawned child as its env's base + (flat's) secrets. */
  env: NodeJS.ProcessEnv;
  /** Forwarded to every engine child on every launch (none ⇒ its normal
   *  persistent poll loop). */
  argv: readonly string[];
  /** The crash-loop fallback policy every topology's `launch` shares.
   *  Defaults to a fresh container-rooted guard (boot.ts) whose roster is
   *  topology-dependent: flat's one constant tenant, or (#79) a fleet's own
   *  live tenant set. */
  guard?: CrashGuard;
  /** Defaults to the real `spawn-engine.mjs` launchers; overridable so the
   *  spawn adapters are unit-tested without a real child process. */
  spawnEngine?: SpawnEngineFn;
  spawnEngineChild?: SpawnEngineChildFn;
};

/**
 * Is the commit `engine` is currently running condemned by the crash-loop
 * guard right now (#79)? Wired as `supervise`'s `isCondemned`, so both
 * topologies drain and relaunch onto it the moment the guard's verdict flips
 * mid-life, not only at the next scheduled launch. Guards a null sha (a local
 * mount) and an unguarded source (a pinned SHA/tag) before ever asking —
 * `condemns` would just answer false for those, but the guard is meant to be
 * inert for them, not merely quiet.
 */
function engineCondemned(guard: CrashGuard): (engine: LaunchedEngine) => boolean {
  return (engine) => engine.guarded && engine.sha !== null && guard.condemns(engine.sha);
}

/**
 * Load the mounted `phoebe.config.ts` as the arbitrary record the detection
 * ladder treats it as — it only needs the `workspace` field, and the engine
 * validates the rest once it is materialized and run. The fingerprint doubles
 * as the ESM cache-bust key, so a re-read after an edit is genuinely a re-read.
 */
async function loadMountedConfig(
  configPath: string,
  fingerprint: string | null,
): Promise<Record<string, unknown>> {
  const userConfig = await loadUserConfig(configPath, { reloadKey: fingerprint ?? undefined });
  return userConfig as unknown as Record<string, unknown>;
}

/**
 * Decide this deployment's topology and build `supervise`'s deps for it
 * (#66/#83, map #39): a root config with a `workspace` block → workspace mode
 * (warns and ignores any `repos/`); else a `repos/` dir → nested; else flat.
 * The root config is loaded once here for the mode decision; `launchTarget`
 * still re-reads it on every (re)launch for the engine source + cache bust.
 */
export async function resolveDeployment(opts: ResolveDeploymentOpts): Promise<Deployment> {
  const { configDir, env, argv } = opts;
  const spawn = opts.spawnEngine ?? defaultSpawnEngine;
  const spawnChild = opts.spawnEngineChild ?? defaultSpawnEngineChild;
  const configPath = resolveConfigPath(undefined, configDir);

  const rootFingerprint = configFingerprint(configPath);
  const rootConfig = await loadMountedConfig(configPath, rootFingerprint);
  const workspace = resolveWorkspace(rootConfig, { root: configDir });

  if (workspace !== null) {
    // Tenants with a live child right now (#79) — mutated by `buildFleetDeps`'s
    // spawn/tenant-axis hooks, read fresh by the guard on every `condemns`/
    // `fallbackFor` call, so the breadth half of breadth × count (#78) reflects
    // who is actually running rather than staying permanently empty.
    const liveTenants = new Set<string>();
    const guard = opts.guard ?? createBootCrashGuard(() => [...liveTenants]);
    const launch = (): Promise<LaunchedEngine> => launchTarget(configPath, guard);
    return buildFleetDeps({
      configPath,
      guard,
      launch,
      argv,
      env,
      spawnEngineChild: spawnChild,
      discover: workspaceDiscover(configDir, workspace),
      liveTenants,
    });
  }

  // No `workspace` block → solo mode (#93/#94, nested central layout removed):
  // the top config's own dir, run in place, one engine child, no scanning.
  // `discoverTenants` itself refuses a leftover `repos/` dir here
  // (`RemovedReposLayoutError`, bootstrap/tenants.ts).
  const discovery = discoverTenants(configDir);

  // Flat is a fleet of one (#65): the top config's own dir, run in place. Its
  // tenant fingerprint is constant (null) so the tenant axis never fires — the
  // engine axis (config/ref) is its only relaunch trigger, one edit is one
  // relaunch, not two.
  const flatTenant = discovery.tenants[0];
  // Flat is a fleet of one (#65): the roster is always this one tenant, so the
  // breadth × count rule (#78) reduces exactly to the old count-only one.
  const guard = opts.guard ?? createBootCrashGuard(() => [flatTenant.id]);
  const launch = (): Promise<LaunchedEngine> => launchTarget(configPath, guard);

  return {
    launch,
    children: {
      discover: () => [{ tenant: flatTenant, fingerprint: null }],
      spawn: (_tenant, engine) => spawnSupervised(engine, argv, env, spawn),
    },
    onChildGone: (run) => {
      if (!guard.shouldRetry(run)) return { propagate: run.exit };
      console.log(
        `[phoebe] boot: relaunching the engine in ${Math.round(CHILD_RESPAWN_BACKOFF_MS / 1000)}s — ` +
          `a last-good engine commit is available to fall back to.`,
      );
      return "respawn";
    },
    onChildRun: (run) => guard.record(run, run.tenant.id),
    onChildTick: ({ engine, elapsedMs }) => {
      if (engine.sha !== null) guard.noteAlive(engine.sha, elapsedMs);
    },
    // A condemned SHA is an engine-axis change like any other (#79) — the
    // fallback `launchTarget` pins to on the resulting relaunch is otherwise
    // never reached mid-life, only at the next scheduled launch.
    isCondemned: engineCondemned(guard),
    // Flat is always exactly one child (#65): on a stop, the container's own
    // exit is that one engine's exit, not a generic 0.
    onStop: (exits) => exits[0] ?? { code: 0, signal: null },
    onEngineChange: (reason) => {
      switch (reason) {
        case "config":
          console.log(
            "[phoebe] boot: mounted config changed — draining the engine (SIGTERM) and relaunching.",
          );
          return;
        case "ref":
          console.log(
            "[phoebe] boot: tracked ref advanced — draining the engine (ref-change signal) and relaunching.",
          );
          return;
        case "condemned":
          console.log(
            "[phoebe] boot: the running engine commit was condemned by the crash-loop guard — " +
              "draining the engine and relaunching onto the last-good commit.",
          );
          return;
      }
    },
    onDrainTimeout: (reason) =>
      console.error(
        `[phoebe] boot: the engine did not finish draining for a ${reason} change — ` +
          `escalating to SIGKILL so the upgrade is not wedged.`,
      ),
    onLaunchError: (error) =>
      console.error(
        `[phoebe] boot: could not launch the engine — ${describe(error)}. Retrying next poll.`,
      ),
    onSampleError: (error) =>
      console.warn(`[phoebe] boot: reconcile poll failed — ${describe(error)}. Ignoring.`),
  };
}

/**
 * Spawn flat's single, constant tenant — its own engine (#65: flat is a fleet
 * of one, so this is `children.spawn` for the flat wiring). Its env routes
 * through the same `childEnv` builder the nested/workspace fleet path uses
 * (#64): the base allowlist and deployment knobs are already a subset of
 * `env`, so passing `env` itself as `secrets` — flat's
 * trust-domain-is-the-whole-container secret source — reproduces today's plain
 * inherit exactly, plus this launch's provenance and resolved-config snapshot.
 * No explicit `cwd` and no `--config`: the child inherits `process.cwd()`,
 * which is already the config dir, the byte-identity guarantee from #64.
 */
function spawnSupervised(
  engine: LaunchedEngine,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  spawn: SpawnEngineFn,
): SupervisedChild {
  let settle!: (exit: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  const childEnvVars = childEnv({
    base: env,
    secrets: env,
    extraEnv: engineProvenanceEnv(engine),
  });
  const child = spawn(engine.entry, argv, {
    env: childEnvVars,
    onExit: (code, signal) => settle({ code, signal }),
    onSpawnError: (error) => {
      console.error(`[phoebe] boot: engine failed to spawn — ${error.message}`);
      settle({ code: 1, signal: null });
    },
  });
  return { kill: (signal) => child.kill(signal), exited };
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
 * Supervise a nested or workspace multi-tenant deployment (#58/#59/#61/#91): a
 * shared engine (#60, materialized once by `launchTarget` from the top config's
 * `engine` field) with one child per tenant, a global concurrency broker across
 * them, and hot add/remove/change via the shared `supervise` loop (#65) — a
 * fleet child that dies on its own is always respawned with backoff, leaving
 * the shared engine and every sibling untouched (#60 §6).
 *
 * Each child is spawned with an IPC channel + the tenant's scrubbed env (#61)
 * and cwd (its config dir), and wired to the broker (#59). The crash-loop
 * guard's bookkeeping (`record`/`noteAlive`) sees every run and tick here too
 * (#79), against the live `liveTenants` roster this function maintains — a
 * fleet now accrues fleet-aggregated crash verdicts (#78's breadth × count
 * rule) the same as flat does. `onChildGone` itself is unchanged: a fleet
 * child that dies is always respawned with backoff regardless of the guard's
 * `shouldRetry` — that call is flat-only, since a fleet's per-child answer to
 * one tenant dying has nothing to do with crash policy. Nested live
 * validation is deferred to #77.
 *
 * `discover` is injected so nested mode can stay a pure filesystem scan while
 * workspace mode re-walks the tree and reloads each child's `repoSlug` (#91).
 */
function buildFleetDeps(opts: {
  configPath: string;
  guard: CrashGuard;
  launch: () => Promise<LaunchedEngine>;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  spawnEngineChild: SpawnEngineChildFn;
  discover: () => DiscoverInput<DiscoveredTenant>;
  /** Tenant ids with a live child right now — mutated here, read by the guard's roster. */
  liveTenants: Set<string>;
}): Deployment {
  const broker = createSlotBroker(resolveMaxConcurrent(opts.env));
  const { guard, liveTenants } = opts;

  const spawnFleetChild = (tenant: DiscoveredTenant, engine: LaunchedEngine): SupervisedChild => {
    const env = childEnv({
      base: opts.env,
      secrets: readTenantEnv(tenant.envPath),
      extraEnv: engineProvenanceEnv(engine),
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
    const childArgv = relocated ? ["--config", tenant.configPath, ...opts.argv] : opts.argv;
    const child = opts.spawnEngineChild(engine.entry, childArgv, {
      env,
      cwd: assetsDir,
      onExit: (code, signal) => settle({ code, signal }),
      onSpawnError: (error) => {
        console.error(`[phoebe] boot: tenant ${label} failed to spawn — ${error.message}`);
        settle({ code: 1, signal: null });
      },
    });
    attachBroker({ owner: tenant.id, broker, child });
    liveTenants.add(tenant.id);
    return { kill: (signal) => child.kill(signal), exited };
  };

  return {
    launch: opts.launch,
    children: { discover: opts.discover, spawn: spawnFleetChild },
    // A fleet child that dies on its own is always respawned — the shared
    // engine and every sibling are untouched (#60 §6). This is per-child
    // supervision, not crash policy, so `guard.shouldRetry` is never
    // consulted here; only `isCondemned` (below) ever pulls the whole fleet
    // off a bad engine commit.
    onChildGone: (run) => {
      console.error(
        `[phoebe] boot: tenant ${run.tenant.id} exited (${run.exit.code ?? run.exit.signal}) — ` +
          `respawning with backoff (per-tenant supervision; the shared engine is untouched).`,
      );
      return "respawn";
    },
    // The guard's bookkeeping half (#79): every ended run (a requested drain's
    // `inconclusive` verdict included) and a heartbeat for one still running,
    // so the fleet actually accrues the crash record `isCondemned` reads.
    onChildRun: (run) => guard.record(run, run.tenant.id),
    onChildTick: ({ engine, elapsedMs }) => {
      if (engine.sha !== null) guard.noteAlive(engine.sha, elapsedMs);
    },
    // A condemned SHA is an engine-axis change like any other (#79) — drain
    // the fleet and relaunch, where `launchTarget`'s `fallbackFor` pins the
    // fresh launch to the last-good commit. No new drain path, no new spawn
    // path: the loop already knows how to relaunch every tenant.
    isCondemned: engineCondemned(guard),
    onEngineChange: (reason) => {
      switch (reason) {
        case "config":
          console.log(
            "[phoebe] boot: shared config changed — draining the fleet and relaunching every tenant.",
          );
          return;
        case "ref":
          console.log(
            "[phoebe] boot: tracked engine ref advanced — draining the fleet and relaunching every tenant.",
          );
          return;
        case "condemned":
          console.log(
            "[phoebe] boot: the running engine commit was condemned by the crash-loop guard — " +
              "draining the fleet and relaunching every tenant onto the last-good commit.",
          );
          return;
      }
    },
    onChildChange: ({ added, removed, changed }) => {
      for (const id of removed) liveTenants.delete(id);
      console.log(
        `[phoebe] boot: tenant reconcile — +${added.length} added, -${removed.length} removed, ` +
          `~${changed.length} relaunched (no container restart).`,
      );
    },
    onLaunchError: (error) =>
      console.error(`[phoebe] boot: fleet (re)launch failed — ${describe(error)}. Retrying.`),
    onDiscoverError: (error) => {
      // A fatal identity clash (#92: duplicate workspace slug or origin) must
      // abort boot, not soft-skip like a transient `repos/` read error.
      if (isFatalWorkspaceDiscoveryError(error)) throw error;
      console.warn(
        `[phoebe] boot: tenant discovery failed — ${describe(error)}. ` +
          `Skipping the tenant axis this poll (the running fleet is left intact).`,
      );
    },
  };
}

/**
 * Workspace-mode discover callback (#91/#137): re-run discovery every poll, load
 * each child's `repoSlug`, and report hold ids for mid-rewrite configs (#86) or
 * declared dirs that cannot become tenants (explicit arm).
 */
function workspaceDiscover(
  configDir: string,
  workspace: ResolvedWorkspace,
): () => DiscoverInput<DiscoveredTenant> {
  let previousHoldKey: string | null = null;
  let summaryLogged = false;

  return async () => {
    const result = await discoverWorkspaceTenants(configDir, workspace, {
      loadRepoSlug: loadTenantRepoSlug,
      loadConfigDir: loadTenantConfigDir,
      warn: (message) => console.warn(message),
    });
    const holdKey = workspaceHoldKey(result.holds);
    if (!summaryLogged) {
      logWorkspaceBootSummary(configDir, workspace, result);
      summaryLogged = true;
      previousHoldKey = holdKey;
    } else if (holdKey !== previousHoldKey) {
      logWorkspaceHoldSummary(configDir, workspace, result.holds);
      previousHoldKey = holdKey;
    }
    return {
      samples: result.tenants.map((tenant) => ({
        tenant,
        fingerprint: tenantFingerprint(tenant.configPath, tenant.envPath),
      })),
      hold: reconcileHoldIds(result),
    };
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
 * malformed — the workspace walker treats that as skip-and-warn, nested falls
 * back to co-location. Reuses `loadUserConfig`'s fingerprint cache, so this does
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
