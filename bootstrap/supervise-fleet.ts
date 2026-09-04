// The supervision loop — `phoebe boot`'s fleet manager (#58/#59), and since #416
// the only one: a shared engine (#60) with one child per discovered tenant
// (#58), a global concurrency broker across them (#59), and hot
// add/remove/change of tenants without a container restart.
//
// Solo runs here too, as a one-tenant fleet (#416/#401). The two semantics that
// genuinely differ — a solo engine exit ending the container, and a solo fast
// crash feeding the engine crash-loop guard — are injected as a {@link RowExitPolicy}
// and the `onRunEnd`/`onRunTick` hooks rather than forked into a second loop.
// The arm still decides discovery and whether the child inherits the supervisor's
// ambient env; it no longer decides which loop runs. #401 widens the same seam
// into the universality rule — exit only when every row is crash-looping — which
// is deliberately not implemented here.
//
// Two orthogonal axes are polled:
//   - Engine axis (shared, #60): the top config's `engine` field or the tracked
//     ref moves → re-materialize once and drain+respawn the *whole* fleet, so
//     every tenant runs a version-uniform engine. A stat-only root-config edit
//     that does not change the resolved engine source is rebased without draining
//     (#138) — the tenant axis still runs in the same poll.
//   - Tenant axis (#58): a tenant dir appears / vanishes / its config changes →
//     spawn / drain+reap / relaunch *only* that child.
// A child that dies on its own (crash / OOM) is per-tenant supervision (#60 §6):
// its slot is reclaimed and it is respawned with backoff, leaving the shared
// engine and every sibling untouched.
//
// Everything impure — materializing, spawning, the poll clock, the stop latch,
// the broker — is injected, so the ordering is unit-tested without processes or
// real timers.

import {
  detectChange,
  type EngineExit,
  type EngineRun,
  type LaunchedEngine,
  type StopLatch,
} from "./reconcile.ts";
import { engineSourcesEqual } from "./engine-source.ts";
import {
  diffFleet,
  DuplicateOriginSlugError,
  DuplicateTenantSlugError,
  WorkspaceStructuralChangeError,
  WorkspaceTenantAxisSkip,
  type DiscoveredTenant,
  type FleetDiscoverResult,
  type TenantSample,
} from "./tenants.ts";

/** How long to wait before respawning a tenant child that died on its own. */
export const CHILD_RESPAWN_BACKOFF_MS = 10_000;
/** Default fleet poll cadence (shared with the single-engine watch). */
export const DEFAULT_FLEET_INTERVAL_MS = 60_000;

/**
 * How long a drain waits for a child to exit after `SIGTERM` before escalating
 * to `SIGKILL` (#79). The engine treats `SIGTERM` as a graceful drain — finish
 * the work unit in flight, start no new one, exit (src/drain.ts) — and that unit
 * is itself bounded by the engine's per-unit run timeout (#72, default 45 min).
 * This grace sits comfortably above that so a legitimately draining unit is never
 * force-killed; it exists only for a child that ignores `SIGTERM` (or whose unit
 * timeout also fails), guaranteeing `drain` — and therefore `drainAll`, which
 * gates both the container-stop path and the in-process engine-relaunch path —
 * always completes rather than hanging on the container's stop grace alone.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 3_600_000;

/** A supervised tenant child — enough to drain it and await its exit. */
export type FleetChild = {
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<EngineExit>;
};

/**
 * A cancelable one-shot timer backing the drain escalation. Injected — like the
 * poll clock — so the `SIGKILL` path is unit-tested without real timers. `cancel`
 * runs when the child exits within the grace, so a graceful drain leaves no
 * pending timer behind.
 */
export type DrainTimer = (ms: number) => { expired: Promise<void>; cancel: () => void };

const defaultDrainTimer: DrainTimer = (ms) => {
  let cancel = (): void => {};
  const expired = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // The drain grace must never keep an otherwise-idle container alive.
    timer.unref?.();
    cancel = () => clearTimeout(timer);
  });
  return { expired, cancel };
};

/** Discover may be sync or async; samples alone, or samples + hold ids (#86/#91). */
export type FleetDiscoverInput =
  | TenantSample[]
  | FleetDiscoverResult
  | Promise<TenantSample[] | FleetDiscoverResult>;

function normalizeDiscover(raw: TenantSample[] | FleetDiscoverResult): FleetDiscoverResult {
  if (Array.isArray(raw)) return { samples: raw };
  return raw;
}

/** A finished run of one row: {@link EngineRun} plus which row ran it. */
export type FleetRun = EngineRun & { tenantId: string };

/** What the supervisor does with a row that ended a run of its own accord. */
export type RowExitAction =
  /** Reap it and start it again on the running shared engine after the backoff. */
  | "respawn"
  /**
   * Re-materialize the shared engine first, then respawn from discovery. The
   * crash-loop fallback only takes effect through a fresh `launch`, so this is
   * what a guard that wants the crash retried asks for.
   */
  | "relaunch"
  /** Stop supervising; the container exits with the row's own status. */
  | "exit";

/**
 * How a row dying on its own is answered — the one thing solo and workspace
 * genuinely disagree about (#416). A workspace row's death is that row's
 * problem, so the default reaps and respawns it and the siblings never notice.
 * A solo row *is* the engine, so its exit is the container's.
 *
 * #401 widens this seam into the universality rule (exit only when every row is
 * crash-looping); today solo answers for its one row and workspace takes the
 * default.
 */
export type RowExitPolicy = {
  /** What to do with the dead row. Consulted once, before the backoff. */
  decide: (run: FleetRun) => RowExitAction;
  /**
   * Whether a container stop exits with the supervised row's own status rather
   * than a clean 0. Solo sets it: boot has always given the container its
   * engine's exit, and a shutdown must not launder a failing engine into a clean
   * stop. A fleet cannot — N rows have no single status to propagate.
   */
  propagateOnStop?: boolean;
};

export type SuperviseFleetDeps = {
  /** Materialize the shared engine (entry + sha + engine-axis `sample`). */
  launch: () => Promise<LaunchedEngine> | LaunchedEngine;
  /**
   * The tenants that should be running now, with their config fingerprints.
   * May include `hold` ids for still-present dirs with a transiently unusable
   * config so those children are not drained (#86).
   */
  discover: () => FleetDiscoverInput;
  /** Spawn one engine child for a tenant, running the shared engine's entry. */
  spawn: (tenant: DiscoveredTenant, engine: LaunchedEngine) => FleetChild;
  stop: StopLatch;
  intervalMs?: number;
  now?: () => number;
  onEngineChange?: (reason: "config" | "ref") => void;
  onTenantChange?: (change: { added: string[]; removed: string[]; changed: string[] }) => void;
  onChildExit?: (info: { tenantId: string; exit: EngineExit; expected: boolean }) => void;
  onLaunchError?: (error: unknown) => void;
  /**
   * The engine axis could not be sampled (an `ls-remote` blip, an unreadable
   * mount) — nothing changed, look again next poll. Falls back to
   * {@link onLaunchError} when unset, which is what the workspace arm relies on.
   */
  onSampleError?: (error: unknown) => void;
  /** A tenant-discovery poll threw (unknown state) — the axis was skipped, not drained. */
  onDiscoverError?: (error: unknown) => void;
  /**
   * Every finished run of every row, however it ended — drained for a reconcile,
   * stopped with the container, or crashed. The crash-loop guard's bookkeeping
   * hook: this is where boot learns a commit ran healthily, or died on startup.
   */
  onRunEnd?: (run: FleetRun) => void;
  /**
   * Each poll, for each row still up, with how long it has been running. The
   * guard's other half: it banks a commit as proven while it is still running,
   * so an engine up for weeks and then killed outright still leaves a fallback
   * target behind.
   */
  onRunTick?: (tick: { tenantId: string; engine: LaunchedEngine; elapsedMs: number }) => void;
  /** What a row exiting on its own means for the container ({@link RowExitPolicy}). */
  rowExit?: RowExitPolicy;
  /** Reap a child we intentionally drained (relaunch/remove); the broker owner id. */
  onReap?: (tenantId: string) => void;
  crashBackoffMs?: number;
  /** Grace after `SIGTERM` before a drain escalates to `SIGKILL` (#79). */
  drainTimeoutMs?: number;
  /** Cancelable timer backing the drain escalation; injected for tests (#79). */
  drainTimer?: DrainTimer;
};

type ChildRecord = {
  tenant: DiscoveredTenant;
  child: FleetChild;
  fingerprint: string | null;
  /** The engine this row was spawned onto — what its finished run is evidence about. */
  engine: LaunchedEngine;
  /** When it was spawned, off the injected clock, for the run durations the guard reads. */
  startedAt: number;
  /** True once we asked this child to stop (relaunch/remove) — its exit is expected. */
  draining: boolean;
  /** Set when the child's exit resolves. */
  exited: EngineExit | null;
};

/**
 * Supervise a fleet of tenant children until the container stops. Resolves 0
 * when drained by a container stop — a fleet has no single "engine exit" to
 * propagate, and a lone row's death is handled in-loop rather than by exiting.
 * The two ways that changes are both injected: a {@link RowExitPolicy} that
 * answers `"exit"` ends supervision with the dead row's status, and one that
 * sets `propagateOnStop` keeps that status through a stop landing mid-respawn.
 */
export async function superviseFleet(deps: SuperviseFleetDeps): Promise<EngineExit> {
  const intervalMs = deps.intervalMs ?? DEFAULT_FLEET_INTERVAL_MS;
  const backoffMs = deps.crashBackoffMs ?? CHILD_RESPAWN_BACKOFF_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const drainTimer = deps.drainTimer ?? defaultDrainTimer;
  const now = deps.now ?? Date.now;
  const onSampleError = deps.onSampleError ?? deps.onLaunchError;
  const children = new Map<string, ChildRecord>();
  const clean: EngineExit = { code: 0, signal: null };
  /**
   * A row that died on its own and is not back up: the exit a stop propagates
   * when the policy asks for it. Cleared the moment a row is spawned again.
   */
  let pendingExit: EngineExit | null = null;

  /** One row's finished run, as the exit policy and the crash-loop guard read it. */
  const runOf = (record: ChildRecord, exit: EngineExit, requestedStop: boolean): FleetRun => ({
    tenantId: record.tenant.id,
    engine: record.engine,
    exit,
    elapsedMs: now() - record.startedAt,
    requestedStop,
  });

  // A re-armable wake signal so a child death breaks the poll wait immediately.
  let wake: () => void = () => {};
  const rearm = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  let waking = rearm();

  const respawnFleetFromDiscovery = async (): Promise<void> => {
    for (const { tenant, fingerprint } of normalizeDiscover(await deps.discover()).samples) {
      spawnFor(tenant, fingerprint);
    }
  };

  /**
   * Re-materialize the shared engine and put the whole fleet back on it. A
   * launch that fails leaves the fleet drained and retries next poll — the old
   * children are already gone, and taking the container down for a network blip
   * mid-fetch would be worse than a gap.
   */
  const relaunchFleet = async (): Promise<void> => {
    await drainAll();
    // Nothing is respawned into a shutdown: the stop path is the next thing to
    // run, and a child spawned here would only be SIGTERMed on arrival.
    if (deps.stop.requested) return;
    try {
      engine = await deps.launch();
      await respawnFleetFromDiscovery();
    } catch (error) {
      deps.onLaunchError?.(error);
    }
  };

  const relaunchEngineAndFleet = async (reason: "config" | "ref"): Promise<void> => {
    deps.onEngineChange?.(reason);
    await relaunchFleet();
  };

  let engine = await deps.launch();

  const spawnFor = (tenant: DiscoveredTenant, fingerprint: string | null): void => {
    const child = deps.spawn(tenant, engine);
    const record: ChildRecord = {
      tenant,
      child,
      fingerprint,
      engine,
      startedAt: now(),
      draining: false,
      exited: null,
    };
    children.set(tenant.id, record);
    // A row is running again, so there is no unfinished death for a stop to
    // report.
    pendingExit = null;
    void child.exited.then((exit) => {
      record.exited = exit;
      wake();
    });
  };

  const drain = async (record: ChildRecord): Promise<EngineExit> => {
    record.draining = true;
    record.child.kill("SIGTERM");
    // Bound the graceful drain: a child that ignores `SIGTERM`, or whose work
    // unit never finishes, must not block `drain` — and so `drainAll`, which
    // gates the container-stop and in-process engine-relaunch paths — forever.
    const timer = drainTimer(drainTimeoutMs);
    const outcome = await Promise.race([
      record.child.exited.then(() => "exited" as const),
      timer.expired.then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") {
      record.child.kill("SIGKILL");
      await record.child.exited;
    } else {
      timer.cancel();
    }
    const exit = await record.child.exited;
    // We ended this run, so it is evidence about nothing: the guard must be able
    // to tell "this commit died" from "we stopped it".
    deps.onRunEnd?.(runOf(record, exit, true));
    deps.onReap?.(record.tenant.id);
    return exit;
  };

  const drainAll = async (): Promise<EngineExit[]> => {
    const exits = await Promise.all([...children.values()].map((record) => drain(record)));
    children.clear();
    return exits;
  };

  /**
   * End supervision on a container stop: drain every row, then resolve. A clean
   * 0, unless the policy propagates the row's own status — as it drained, or,
   * when it died just before the stop and the backoff never got to respawn it,
   * the death that left the fleet empty.
   */
  const stopAndDrain = async (): Promise<EngineExit> => {
    const drained = await drainAll();
    if (deps.rowExit?.propagateOnStop !== true) return clean;
    return drained[0] ?? pendingExit ?? clean;
  };

  // Initial fleet: one child per discovered tenant.
  for (const { tenant, fingerprint } of normalizeDiscover(await deps.discover()).samples) {
    spawnFor(tenant, fingerprint);
  }

  while (true) {
    if (deps.stop.requested) return await stopAndDrain();

    await Promise.race([deps.stop.wait(intervalMs), waking]);
    waking = rearm();

    if (deps.stop.requested) return await stopAndDrain();

    // 0. Bank how long each row that is still up has been running, so a row that
    // never exits is still evidence the guard can fall back to.
    for (const record of children.values()) {
      if (record.exited !== null || record.draining) continue;
      deps.onRunTick?.({
        tenantId: record.tenant.id,
        engine: record.engine,
        elapsedMs: now() - record.startedAt,
      });
    }

    // 1. Reap / respawn children that died on their own (per-tenant supervision).
    // Snapshot first — the body deletes from and adds to `children`.
    const records = Array.from(children.values());
    let relaunched = false;
    for (const record of records) {
      if (record.exited === null || record.draining) continue;
      const exit = record.exited;
      deps.onChildExit?.({ tenantId: record.tenant.id, exit, expected: false });
      const run = runOf(record, exit, false);
      children.delete(record.tenant.id);
      deps.onRunEnd?.(run);
      pendingExit = exit;
      // The policy decides what this death means for the container. Default:
      // this row's problem alone.
      const action = deps.rowExit?.decide(run) ?? "respawn";
      if (action === "exit") {
        await drainAll();
        return exit;
      }
      // Back off first, so a row that dies instantly cannot spin the loop.
      await deps.stop.wait(backoffMs);
      if (deps.stop.requested) break;
      if (action === "relaunch") {
        // A crash-loop fallback only lands through a fresh materialization, so
        // the whole fleet goes back onto a re-launched engine.
        relaunched = true;
        await relaunchFleet();
        break;
      }
      if (!children.has(record.tenant.id)) spawnFor(record.tenant, record.fingerprint);
    }
    if (deps.stop.requested) return await stopAndDrain();
    if (relaunched) continue;

    // 2. Engine axis: a shared-engine change drains + respawns the whole fleet.
    let current;
    try {
      current = engine.sample();
    } catch (error) {
      onSampleError?.(error);
      current = null;
    }
    if (current) {
      const reason = detectChange({
        launched: { config: engine.config, sha: engine.sha, quarantinedSha: engine.quarantinedSha },
        current,
      });
      if (reason) {
        if (reason === "config" && engine.confirmEngineSource) {
          try {
            const confirmed = await engine.confirmEngineSource();
            if (engineSourcesEqual(engine.source, confirmed)) {
              engine = { ...engine, config: current.config };
            } else {
              await relaunchEngineAndFleet(reason);
              continue;
            }
          } catch (error) {
            onSampleError?.(error);
            continue;
          }
        } else {
          await relaunchEngineAndFleet(reason);
          continue;
        }
      }
    }

    // 3. Tenant axis: add / remove / relaunch individual children.
    // A discovery that throws is *unknown* state, not "every tenant removed":
    // skip the tenant axis this poll rather than draining the whole fleet on a
    // transient `repos/` read error (tenants.ts already re-throws non-ENOENT).
    // A fatal discovery error (duplicate workspace slug) aborts the supervisor.
    const previous = new Map<string, string | null>(
      [...children.values()].map((r) => [r.tenant.id, r.fingerprint] as const),
    );
    let samples: TenantSample[];
    let hold = new Set<string>();
    try {
      const discovered = normalizeDiscover(await deps.discover());
      samples = discovered.samples;
      hold = new Set(discovered.hold ?? []);
    } catch (error) {
      // A mid-flight malformed `workspace` block is unknown state, not an empty
      // fleet: skip the tenant axis this poll (#139).
      if (error instanceof WorkspaceTenantAxisSkip) {
        deps.onDiscoverError?.(error);
        continue;
      }
      if (
        error instanceof DuplicateTenantSlugError ||
        error instanceof DuplicateOriginSlugError ||
        error instanceof WorkspaceStructuralChangeError
      ) {
        await drainAll();
        throw error;
      }
      deps.onDiscoverError?.(error);
      continue;
    }
    const diff = diffFleet(previous, samples, hold);
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      deps.onTenantChange?.({
        added: diff.added.map((t) => t.id),
        removed: diff.removed,
        changed: diff.changed.map((t) => t.id),
      });
    }
    const sampleById = new Map(samples.map((s) => [s.tenant.id, s] as const));
    for (const id of diff.removed) {
      const record = children.get(id);
      if (record) {
        await drain(record);
        children.delete(id);
      }
    }
    for (const tenant of diff.changed) {
      const record = children.get(tenant.id);
      if (record) {
        await drain(record);
        children.delete(tenant.id);
      }
      spawnFor(tenant, sampleById.get(tenant.id)?.fingerprint ?? null);
    }
    for (const tenant of diff.added) {
      spawnFor(tenant, sampleById.get(tenant.id)?.fingerprint ?? null);
    }
  }
}
