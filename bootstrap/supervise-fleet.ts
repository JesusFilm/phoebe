// The supervision loop — `phoebe boot`'s fleet manager (#58/#59), and since #416
// the only one: a shared engine (#60) with one child per supervised *row* (#401),
// a global concurrency broker across them (#59), and hot add/remove/change
// without a container restart.
//
// A row is one `(tenant × pipeline)` cell, keyed `<tenantId>#<pipeline>` (#420).
// Discovery still yields tenants; the loop expands each into rows by asking the
// materialized engine (`LaunchedEngine.rows`, #417). A checkout that cannot
// enumerate yields one implicit `work` row per tenant, which is byte-for-byte
// the one-child-per-tenant fleet this loop supervised before.
//
// Solo runs here too, as a one-tenant fleet (#416/#401). The two semantics that
// genuinely differ — an exit ending the container, and a fast crash feeding the
// engine crash-loop guard — are injected as a {@link RowExitPolicy} and the
// `onRunEnd`/`onRunTick` hooks rather than forked into a second loop. The arm
// still decides discovery and whether the child inherits the supervisor's
// ambient env; it no longer decides which loop runs.
//
// Three axes are polled:
//   - Engine axis (shared, #60): the top config's `engine` field or the tracked
//     ref moves → re-materialize once and drain+respawn the *whole* fleet, so
//     every row runs a version-uniform engine. Rows are re-enumerated against
//     the new checkout before anything respawns — capability is a property of
//     the engine commit, so the pre-upgrade row list is never reused. A
//     stat-only root-config edit that does not change the resolved engine
//     source is rebased without draining (#138); the row axis still runs in the
//     same poll.
//   - Tenant axis (#58): a tenant dir appears / vanishes / its config
//     fingerprint moves → re-enumerate that tenant's rows.
//   - Row axis (#401/#420): a new row spawns, a vanished row drains, and an
//     existing row relaunches only when its own fingerprint moved. A tenant
//     fingerprint move that *no* row fingerprint accounts for is by elimination
//     tenant-wide — a git identity, a repo slug, an edited `.env` — and fans out
//     to every row of that tenant.
//
// The loop also owns the stale-state sweep's two triggers (#426), because it is
// the only thing that knows when a row is down: boot before the first spawn, and
// a row-set change after the rows it removed have drained and before anything is
// respawned. Both are moments when the disk in question is provably nobody's.
// The sweep never blocks a spawn — a failure is one log line.
//
// A row that dies on its own is that row's problem: its slot is reclaimed and it
// is respawned with backoff, leaving the shared engine and every sibling
// untouched. The container comes down only under the universality rule — every
// supervised row crash-looping at once (#401) — which is why {@link FleetRun}
// carries `everyRowCrashLooping` and why {@link RowExitPolicy.decide} is
// consulted only when it holds.
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
import { HEALTHY_RUN_MS } from "./crash-loop.ts";
import {
  diffRows,
  IMPLICIT_WORK_ROW,
  rowId,
  type PipelineRow,
  type RowSample,
  type SupervisedRow,
} from "./pipeline-rows.ts";
import type { StateSweepOutcome, StateSweepTrigger } from "./state-sweep.ts";
import {
  diffFleet,
  DuplicateOriginSlugError,
  DuplicateTenantSlugError,
  WorkspaceStructuralChangeError,
  WorkspaceTenantAxisSkip,
  type FleetDiscoverResult,
  type TenantSample,
} from "./tenants.ts";

/** How long to wait before respawning a row's child that died on its own. */
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

/** A supervised row's child — enough to drain it and await its exit. */
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
export type FleetRun = EngineRun & {
  /** `<tenantId>#<pipeline>` — the child-map key, broker owner and lease id. */
  rowId: string;
  /** The tenant half of {@link rowId}, for hooks that answer per tenant. */
  tenantId: string;
  row: SupervisedRow;
  /**
   * The universality rule (#401): every row that ran this engine has now
   * crash-looped. False while any sibling is up, which is what makes one row's
   * death survivable — and what keeps a single row's fast crash out of the
   * engine crash-loop guard's count.
   */
  everyRowCrashLooping: boolean;
};

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
 * How a row dying on its own is answered, once the universality rule lets the
 * question be asked at all (#401/#416). `decide` is consulted only when every
 * supervised row is crash-looping; a row that dies while a sibling is still up
 * is reaped and respawned whatever the policy would have said, because a row's
 * death alone is never fatal. A solo deployment has one row, so universality is
 * whatever that row just did and the policy sees every death — which is how
 * "the engine exited, so the container exits" survives unchanged.
 */
export type RowExitPolicy = {
  /**
   * Is this finished run a crash-loop tick for its row? The universality rule's
   * atom. Defaults to "it died on its own inside {@link SuperviseFleetDeps.healthyRunMs}",
   * matching the crash-loop guard's own healthy window.
   */
  crashLooping?: (run: FleetRun) => boolean;
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
  /** Spawn one engine child for a row, running the shared engine's entry. */
  spawn: (row: SupervisedRow, engine: LaunchedEngine) => FleetChild;
  stop: StopLatch;
  intervalMs?: number;
  now?: () => number;
  /**
   * How long a row must stay up before it stops counting as crash-looping.
   * Defaults to the crash-loop guard's healthy window, so "this row has proved
   * itself" means one thing across the two policies that ask.
   */
  healthyRunMs?: number;
  onEngineChange?: (reason: "config" | "ref") => void;
  /** Row ids added / drained / relaunched by one poll of the row axis. */
  onRowChange?: (change: { added: string[]; removed: string[]; changed: string[] }) => void;
  onChildExit?: (info: { row: SupervisedRow; exit: EngineExit; expected: boolean }) => void;
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
   * One tenant's rows could not be enumerated. That tenant is held — its
   * running rows keep running, it contributes no new ones, and the next poll
   * tries again — so this fires once per poll for as long as the fault lasts.
   */
  onRowsError?: (info: { tenantId: string; error: unknown }) => void;
  /** One tenant's stale-state sweep finished — what it reclaimed and what it refused. */
  onStateSweep?: (info: {
    tenantId: string;
    trigger: StateSweepTrigger;
    outcome: StateSweepOutcome;
  }) => void;
  /**
   * One tenant's sweep failed as a whole. Its disk is untouched and its rows
   * spawn anyway: reclaiming stale state is never worth a row not running.
   */
  onStateSweepError?: (info: {
    tenantId: string;
    trigger: StateSweepTrigger;
    error: unknown;
  }) => void;
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
  onRunTick?: (tick: {
    rowId: string;
    tenantId: string;
    engine: LaunchedEngine;
    elapsedMs: number;
  }) => void;
  /** What a row exiting on its own means for the container ({@link RowExitPolicy}). */
  rowExit?: RowExitPolicy;
  /** Reap a child we intentionally drained (relaunch/remove); the broker owner id. */
  onReap?: (rowId: string) => void;
  crashBackoffMs?: number;
  /** Grace after `SIGTERM` before a drain escalates to `SIGKILL` (#79). */
  drainTimeoutMs?: number;
  /** Cancelable timer backing the drain escalation; injected for tests (#79). */
  drainTimer?: DrainTimer;
};

type ChildRecord = {
  row: SupervisedRow;
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
  /**
   * The run as it was at the moment the child exited. Timed there rather than
   * where the poll gets round to it, so a death during a long backoff is not
   * credited with the waiting.
   */
  finished: FleetRun | null;
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
  const healthyRunMs = deps.healthyRunMs ?? HEALTHY_RUN_MS;
  const onSampleError = deps.onSampleError ?? deps.onLaunchError;
  const children = new Map<string, ChildRecord>();
  const clean: EngineExit = { code: 0, signal: null };
  /**
   * A row that died on its own and is not back up: the exit a stop propagates
   * when the policy asks for it. Cleared the moment a row is spawned again.
   */
  let pendingExit: EngineExit | null = null;

  /**
   * The last tenant fingerprint each supervised tenant was expanded at. The
   * trigger for re-reading rows, and — when a move turns out to be one no row
   * fingerprint accounts for — the evidence that something tenant-wide changed.
   * A tenant held by a failed enumeration keeps its old entry, so the move it
   * could not answer is still pending at the next poll.
   */
  const tenantFingerprints = new Map<string, string | null>();

  /**
   * Per engine materialization: has each row's last finished run been a
   * crash-loop tick? Sticky across a respawn — a row that keeps dying instantly
   * is crash-looping between attempts as much as during them — and cleared once
   * the row has been up past the healthy window, or once it is drained. Reset
   * wholesale on a new launch: the rule is about rows that ran *this* commit.
   */
  const crashLooping = new Map<string, boolean>();

  const isCrashLooping =
    deps.rowExit?.crashLooping ?? ((run: FleetRun) => run.elapsedMs < healthyRunMs);

  /**
   * The universality rule (#401): every row that ran this engine has crash-looped.
   * An empty fleet is not universal — there is nothing to have proved it.
   */
  const everyRowCrashLooping = (): boolean =>
    crashLooping.size > 0 && [...crashLooping.values()].every(Boolean);

  /** One row's finished run, as the exit policy and the crash-loop guard read it. */
  const runOf = (record: ChildRecord, exit: EngineExit, requestedStop: boolean): FleetRun => ({
    rowId: record.row.id,
    tenantId: record.row.tenant.id,
    row: record.row,
    engine: record.engine,
    exit,
    elapsedMs: now() - record.startedAt,
    requestedStop,
    everyRowCrashLooping: false,
  });

  /**
   * Expand discovered tenants into the row matrix by asking the running engine
   * (#417). A tenant whose enumeration throws is *held*: it contributes no rows,
   * its running ones are protected from the removal diff by the caller, and the
   * fault is reported once for this poll. An engine that cannot enumerate at all
   * gives every tenant the implicit `work` row instead, which is the fleet this
   * loop supervised before there were rows.
   */
  const expand = (samples: readonly TenantSample[]): { rows: RowSample[]; held: Set<string> } => {
    const rows: RowSample[] = [];
    const held = new Set<string>();
    const enumerator = engine.rows?.supported() === true ? engine.rows : null;
    for (const { tenant, fingerprint } of samples) {
      let pipelines: readonly PipelineRow[];
      try {
        pipelines =
          enumerator === null
            ? [IMPLICIT_WORK_ROW]
            : enumerator.rowsFor({ configPath: tenant.configPath, cwd: tenant.dir, fingerprint });
      } catch (error) {
        held.add(tenant.id);
        deps.onRowsError?.({ tenantId: tenant.id, error });
        continue;
      }
      for (const pipeline of pipelines) {
        rows.push({
          row: {
            id: rowId(tenant.id, pipeline.name),
            tenant,
            pipeline,
            enumerated: enumerator !== null,
          },
          fingerprint: pipeline.fingerprint,
        });
      }
    }
    return { rows, held };
  };

  // A re-armable wake signal so a child death breaks the poll wait immediately.
  let wake: () => void = () => {};
  const rearm = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  let waking = rearm();

  /**
   * Reclaim the disk of rows this tenant no longer has (#426), for every tenant
   * named in `tenantIds`. Called at exactly two moments, both of them ones where
   * the rows in question are provably down: facility boot before anything
   * spawns, and a row-set change once the rows it removed have drained. Never on
   * a timer.
   *
   * A tenant whose enumeration is held is skipped — unknown rows cannot tell an
   * orphan from a row that is merely stopped — and one tenant's failure is a log
   * line, not a reason to stop sweeping the next or to delay a spawn.
   */
  const sweepStaleState = (
    samples: readonly TenantSample[],
    tenantIds: ReadonlySet<string>,
    trigger: StateSweepTrigger,
  ): void => {
    const sweeper = engine.stateSweep;
    if (sweeper === undefined) return;
    for (const { tenant } of samples) {
      if (!tenantIds.has(tenant.id)) continue;
      try {
        const outcome = sweeper.sweep({ configPath: tenant.configPath, cwd: tenant.dir });
        deps.onStateSweep?.({ tenantId: tenant.id, trigger, outcome });
      } catch (error) {
        deps.onStateSweepError?.({ tenantId: tenant.id, trigger, error });
      }
    }
  };

  /**
   * Enumerate every tenant against the engine that is running now, and spawn the
   * whole matrix. The only way a fleet comes up — at boot and after an engine
   * relaunch alike — so an upgrade can never respawn a row list the old checkout
   * reported.
   *
   * `sweep` is set for the boot call alone. An engine relaunch drains the fleet
   * and comes back through here too, but a new engine ref is not a row-set
   * change: what it enumerates differently is reported by doctor and reclaimed
   * at the next trigger, rather than by a sweep on every upgrade.
   */
  const spawnFleetFromDiscovery = async (opts: { sweep?: boolean } = {}): Promise<void> => {
    const samples = normalizeDiscover(await deps.discover()).samples;
    const { rows, held } = expand(samples);
    for (const { tenant, fingerprint } of samples) {
      if (!held.has(tenant.id)) tenantFingerprints.set(tenant.id, fingerprint);
    }
    if (opts.sweep === true) {
      const enumerated = new Set(
        samples.map(({ tenant }) => tenant.id).filter((id) => !held.has(id)),
      );
      sweepStaleState(samples, enumerated, "boot");
    }
    for (const { row, fingerprint } of rows) spawnFor(row, fingerprint);
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
      // A new commit is a new question: what the old checkout said about rows,
      // and what its rows had proved about it, both stop applying here.
      crashLooping.clear();
      await spawnFleetFromDiscovery();
    } catch (error) {
      deps.onLaunchError?.(error);
    }
  };

  const relaunchEngineAndFleet = async (reason: "config" | "ref"): Promise<void> => {
    deps.onEngineChange?.(reason);
    await relaunchFleet();
  };

  let engine = await deps.launch();

  const spawnFor = (row: SupervisedRow, fingerprint: string | null): void => {
    const child = deps.spawn(row, engine);
    const record: ChildRecord = {
      row,
      child,
      fingerprint,
      engine,
      startedAt: now(),
      draining: false,
      exited: null,
      finished: null,
    };
    children.set(row.id, record);
    // A row that has never run this engine has not crash-looped on it. One that
    // is being respawned after a fast crash keeps its mark: the crash-loop is
    // the sequence, not the individual death.
    if (!crashLooping.has(row.id)) crashLooping.set(row.id, false);
    // A row is running again, so there is no unfinished death for a stop to
    // report.
    pendingExit = null;
    void child.exited.then((exit) => {
      record.exited = exit;
      const run = runOf(record, exit, false);
      record.finished = run;
      // Judged here rather than in the poll body so a fleet whose rows all died
      // together is read as such however far behind the loop is.
      if (!record.draining) crashLooping.set(row.id, isCrashLooping(run));
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
    // Nor is it a crash-loop tick: a row we stopped is a row whose next start is
    // ours to make.
    crashLooping.delete(record.row.id);
    deps.onReap?.(record.row.id);
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

  // Initial fleet: one child per row of every discovered tenant. A tenant whose
  // rows will not enumerate contributes none and is retried at the next poll.
  // Facility boot is the stale-state sweep's first trigger, and it runs here —
  // before a single row spawns, when nothing on this tenant's disk can be in use.
  await spawnFleetFromDiscovery({ sweep: true });

  while (true) {
    if (deps.stop.requested) return await stopAndDrain();

    await Promise.race([deps.stop.wait(intervalMs), waking]);
    waking = rearm();

    if (deps.stop.requested) return await stopAndDrain();

    // 0. Bank how long each row that is still up has been running, so a row that
    // never exits is still evidence the guard can fall back to.
    for (const record of children.values()) {
      if (record.exited !== null || record.draining) continue;
      const elapsedMs = now() - record.startedAt;
      // Up past the healthy window: this row has proved the commit, so it is no
      // longer one of the rows a universality verdict can be built from.
      if (elapsedMs >= healthyRunMs) crashLooping.set(record.row.id, false);
      deps.onRunTick?.({
        rowId: record.row.id,
        tenantId: record.row.tenant.id,
        engine: record.engine,
        elapsedMs,
      });
    }

    // 1. Reap / respawn rows that died on their own (per-row supervision).
    // Snapshot first — the body deletes from and adds to `children`.
    const records = Array.from(children.values());
    let relaunched = false;
    for (const record of records) {
      if (record.exited === null || record.draining) continue;
      const exit = record.exited;
      deps.onChildExit?.({ row: record.row, exit, expected: false });
      // The universality rule: this death is the container's business only if
      // every row that ran this engine has crash-looped on it. While a sibling
      // is up, the exit policy is not even asked.
      const universal = everyRowCrashLooping();
      const run = { ...(record.finished ?? runOf(record, exit, false)) };
      run.everyRowCrashLooping = universal;
      children.delete(record.row.id);
      deps.onRunEnd?.(run);
      pendingExit = exit;
      const action = universal ? (deps.rowExit?.decide(run) ?? "respawn") : "respawn";
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
      if (!children.has(record.row.id)) spawnFor(record.row, record.fingerprint);
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

    // 3. Row axis: add / drain / relaunch individual rows.
    // A discovery that throws is *unknown* state, not "every tenant removed":
    // skip the axis this poll rather than draining the whole fleet on a
    // transient `repos/` read error (tenants.ts already re-throws non-ENOENT).
    // A fatal discovery error (duplicate workspace slug) aborts the supervisor.
    let samples: TenantSample[];
    let tenantHold = new Set<string>();
    try {
      const discovered = normalizeDiscover(await deps.discover());
      samples = discovered.samples;
      tenantHold = new Set(discovered.hold ?? []);
    } catch (error) {
      // A mid-flight malformed `workspace` block is unknown state, not an empty
      // fleet: skip the axis this poll (#139).
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

    const previous = new Map<string, string | null>(
      [...children.values()].map((r) => [r.row.id, r.fingerprint] as const),
    );
    const { rows: desired, held } = expand(samples);
    // A held tenant's rows are unknown, not gone: protect every one of them from
    // the removal diff, exactly as a held tenant dir is protected today (#86).
    const rowHold = new Set<string>();
    for (const record of children.values()) {
      const tenantId = record.row.tenant.id;
      if (held.has(tenantId) || tenantHold.has(tenantId)) rowHold.add(record.row.id);
    }
    const diff = diffRows(previous, desired, rowHold);

    // A tenant fingerprint that moved with no row of its own to show for it is
    // by elimination a tenant-wide change — a git identity, a repo slug, an
    // edited `.env` — which every row of that tenant runs with and so relaunches
    // for. Rows whose *own* fingerprint moved have already accounted for the
    // move, and a row appearing or vanishing accounts for it too, so neither
    // drags its siblings down with it.
    const accounted = new Set<string>();
    for (const row of [...diff.added, ...diff.changed]) accounted.add(row.tenant.id);
    for (const id of diff.removed) {
      const record = children.get(id);
      if (record) accounted.add(record.row.tenant.id);
    }
    const fanOut: SupervisedRow[] = [];
    for (const tenant of diffFleet(tenantFingerprints, samples, tenantHold).changed) {
      if (held.has(tenant.id) || accounted.has(tenant.id)) continue;
      for (const { row } of desired) if (row.tenant.id === tenant.id) fanOut.push(row);
    }
    const changed = [...diff.changed, ...fanOut];

    // Only tenants that answered move their watermark on: one whose enumeration
    // failed keeps the old one, so the edit it could not read is still pending.
    for (const { tenant, fingerprint } of samples) {
      if (!held.has(tenant.id)) tenantFingerprints.set(tenant.id, fingerprint);
    }
    const present = new Set(samples.map((s) => s.tenant.id));
    for (const id of tenantFingerprints.keys()) {
      if (!present.has(id) && !tenantHold.has(id)) tenantFingerprints.delete(id);
    }

    if (diff.added.length || diff.removed.length || changed.length) {
      deps.onRowChange?.({
        added: diff.added.map((row) => row.id),
        removed: diff.removed,
        changed: changed.map((row) => row.id),
      });
    }
    const fingerprintById = new Map(desired.map((s) => [s.row.id, s.fingerprint] as const));
    // Which tenants this reconcile could have orphaned state for. A row that
    // vanished takes its whole keyspace with it; a row that merely *changed* may
    // have retired a kind, which orphans that kind's scratch and read-only
    // trees. A row that only appeared orphans nothing, so it is not a trigger.
    const sweepable = new Set<string>();
    for (const id of diff.removed) {
      const record = children.get(id);
      if (record) {
        sweepable.add(record.row.tenant.id);
        await drain(record);
        children.delete(id);
      }
    }
    for (const row of changed) {
      const record = children.get(row.id);
      if (record) {
        sweepable.add(row.tenant.id);
        await drain(record);
        children.delete(row.id);
      }
    }
    // Every row this reconcile takes down is down and none is back up yet: the
    // one window in a running facility where a vanished row's disk is provably
    // nobody's (#426). Held tenants are excluded — unknown rows cannot tell an
    // orphan from a row that is merely stopped.
    for (const id of [...sweepable]) {
      if (held.has(id) || tenantHold.has(id)) sweepable.delete(id);
    }
    if (sweepable.size > 0) sweepStaleState(samples, sweepable, "row-change");
    for (const row of changed) {
      spawnFor(row, fingerprintById.get(row.id) ?? null);
    }
    for (const row of diff.added) {
      spawnFor(row, fingerprintById.get(row.id) ?? null);
    }
  }
}
