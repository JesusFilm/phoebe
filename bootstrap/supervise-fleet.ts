// The supervision loop — `phoebe boot`'s fleet manager (#58/#59), and since #416
// the only one: a shared engine (#60) with one child per supervised *pipeline* (#401),
// a global concurrency broker across them (#59), and hot add/remove/change
// without a container restart.
//
// A pipeline is one `(tenant × pipeline)` cell, keyed `<tenantId>#<pipeline>` (#420).
// Discovery still yields tenants; the loop expands each into pipelines by asking the
// materialized engine (`LaunchedEngine.pipelines`, #417). A checkout that cannot
// enumerate yields one implicit `work` pipeline per tenant, which is byte-for-byte
// the one-child-per-tenant fleet this loop supervised before.
//
// Solo runs here too, as a one-tenant fleet (#416/#401). The two semantics that
// genuinely differ — an exit ending the container, and a fast crash feeding the
// engine crash-loop guard — are injected as a {@link PipelineExitPolicy} and the
// `onRunEnd`/`onRunTick` hooks rather than forked into a second loop. The arm
// still decides discovery and whether the child inherits the supervisor's
// ambient env; it no longer decides which loop runs.
//
// Three axes are polled:
//   - Engine axis (shared, #60): the top config's `engine` field or the tracked
//     ref moves → re-materialize once and drain+respawn the *whole* fleet, so
//     every pipeline runs a version-uniform engine. Pipelines are re-enumerated against
//     the new checkout before anything respawns — capability is a property of
//     the engine commit, so the pre-upgrade pipeline list is never reused. A
//     stat-only root-config edit that does not change the resolved engine
//     source is rebased without draining (#138); the pipeline axis still runs in the
//     same poll.
//   - Tenant axis (#58): a tenant dir appears / vanishes / its config
//     fingerprint moves → re-enumerate that tenant's pipelines.
//   - Pipeline axis (#401/#420): a new pipeline spawns, a vanished pipeline drains, and an
//     existing pipeline relaunches only when its own fingerprint moved. A tenant
//     fingerprint move that *no* pipeline fingerprint accounts for is by elimination
//     tenant-wide — a git identity, a repo slug, an edited `.env` — and fans out
//     to every pipeline of that tenant.
//
// A pipeline that dies on its own is that pipeline's problem: its slot is reclaimed and it
// is respawned with backoff, leaving the shared engine and every sibling
// untouched. The container comes down only under the universality rule — every
// supervised pipeline crash-looping at once (#401) — which is why {@link FleetRun}
// carries `everyPipelineCrashLooping` and why {@link PipelineExitPolicy.decide} is
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
  diffPipelines,
  IMPLICIT_WORK_PIPELINE,
  pipelineId,
  type Pipeline,
  type PipelineSample,
  type SupervisedPipeline,
} from "./pipelines.ts";
import {
  diffFleet,
  DuplicateOriginSlugError,
  DuplicateTenantSlugError,
  WorkspaceStructuralChangeError,
  WorkspaceTenantAxisSkip,
  type FleetDiscoverResult,
  type TenantSample,
} from "./tenants.ts";

/** How long to wait before respawning a pipeline's child that died on its own. */
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

/**
 * The knobs the supervisor consumes itself and so acts on without relaunching a
 * pipeline (#402/#407). Compared as one string because the question is only ever
 * "did either move?".
 */
function hotKnobs(pipeline: Pipeline): string {
  return `${pipeline.disabled}:${pipeline.priority}`;
}

/** A supervised pipeline's child — enough to drain it and await its exit. */
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

/** A finished run of one pipeline: {@link EngineRun} plus which pipeline ran it. */
export type FleetRun = EngineRun & {
  /** `<tenantId>#<pipeline>` — the child-map key, broker owner and lease id. */
  pipelineId: string;
  /** The tenant half of {@link pipelineId}, for hooks that answer per tenant. */
  tenantId: string;
  pipeline: SupervisedPipeline;
  /**
   * The universality rule (#401): every pipeline that ran this engine has now
   * crash-looped. False while any sibling is up, which is what makes one pipeline's
   * death survivable — and what keeps a single pipeline's fast crash out of the
   * engine crash-loop guard's count.
   */
  everyPipelineCrashLooping: boolean;
};

/** What the supervisor does with a pipeline that ended a run of its own accord. */
export type PipelineExitAction =
  /** Reap it and start it again on the running shared engine after the backoff. */
  | "respawn"
  /**
   * Re-materialize the shared engine first, then respawn from discovery. The
   * crash-loop fallback only takes effect through a fresh `launch`, so this is
   * what a guard that wants the crash retried asks for.
   */
  | "relaunch"
  /** Stop supervising; the container exits with the pipeline's own status. */
  | "exit";

/**
 * How a pipeline dying on its own is answered, once the universality rule lets the
 * question be asked at all (#401/#416). `decide` is consulted only when every
 * supervised pipeline is crash-looping; a pipeline that dies while a sibling is still up
 * is reaped and respawned whatever the policy would have said, because a pipeline's
 * death alone is never fatal. A solo deployment has one pipeline, so universality is
 * whatever that pipeline just did and the policy sees every death — which is how
 * "the engine exited, so the container exits" survives unchanged.
 */
export type PipelineExitPolicy = {
  /**
   * Is this finished run a crash-loop tick for its pipeline? The universality rule's
   * atom. Defaults to "it died on its own inside {@link SuperviseFleetDeps.healthyRunMs}",
   * matching the crash-loop guard's own healthy window.
   */
  crashLooping?: (run: FleetRun) => boolean;
  /** What to do with the dead pipeline. Consulted once, before the backoff. */
  decide: (run: FleetRun) => PipelineExitAction;
  /**
   * Whether a container stop exits with the supervised pipeline's own status rather
   * than a clean 0. Solo sets it: boot has always given the container its
   * engine's exit, and a shutdown must not launder a failing engine into a clean
   * stop. A fleet cannot — N pipelines have no single status to propagate.
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
  /** Spawn one engine child for a pipeline, running the shared engine's entry. */
  spawn: (pipeline: SupervisedPipeline, engine: LaunchedEngine) => FleetChild;
  stop: StopLatch;
  intervalMs?: number;
  now?: () => number;
  /**
   * How long a pipeline must stay up before it stops counting as crash-looping.
   * Defaults to the crash-loop guard's healthy window, so "this pipeline has proved
   * itself" means one thing across the two policies that ask.
   */
  healthyRunMs?: number;
  onEngineChange?: (reason: "config" | "ref") => void;
  /** Pipeline ids added / drained / relaunched by one poll of the pipeline axis. */
  onPipelineChange?: (change: { added: string[]; removed: string[]; changed: string[] }) => void;
  /**
   * The live pipeline matrix, every poll that could see it move — the hot knobs the
   * supervisor consumes without relaunching a pipeline, and the reshape that may move
   * the derived slot cap (#407). `reshaped` is true only when this poll added,
   * removed or relaunched a pipeline; a poll that merely re-read a pipeline's `priority`
   * fires with false, so nothing resizes a semaphore mid-flight. Held tenants'
   * running pipelines are included: they are live, whatever their enumeration did.
   */
  onPipelines?: (matrix: { pipelines: readonly SupervisedPipeline[]; reshaped: boolean }) => void;
  onChildExit?: (info: {
    pipeline: SupervisedPipeline;
    exit: EngineExit;
    expected: boolean;
  }) => void;
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
   * One tenant's pipelines could not be enumerated. That tenant is held — its
   * running pipelines keep running, it contributes no new ones, and the next poll
   * tries again — so this fires once per poll for as long as the fault lasts.
   */
  onPipelinesError?: (info: { tenantId: string; error: unknown }) => void;
  /**
   * Every finished run of every pipeline, however it ended — drained for a reconcile,
   * stopped with the container, or crashed. The crash-loop guard's bookkeeping
   * hook: this is where boot learns a commit ran healthily, or died on startup.
   */
  onRunEnd?: (run: FleetRun) => void;
  /**
   * Each poll, for each pipeline still up, with how long it has been running. The
   * guard's other half: it banks a commit as proven while it is still running,
   * so an engine up for weeks and then killed outright still leaves a fallback
   * target behind.
   */
  onRunTick?: (tick: {
    pipelineId: string;
    tenantId: string;
    engine: LaunchedEngine;
    elapsedMs: number;
  }) => void;
  /**
   * Narrow the engine's pipeline fingerprint with what only the supervisor knows:
   * the tenant's `.env` as *this pipeline* would hold it (#425). Returning null for
   * a null input keeps the "unknown never counts as a change" rule — the
   * implicit pipeline of a checkout that cannot enumerate has no fingerprint to
   * narrow, and relaunches on the tenant axis as it always has.
   *
   * This is what makes a declared-key rotation relaunch one pipeline: the rotated
   * key moves only the digest of the pipelines that can see it, and a tenant whose
   * fingerprint moved with at least one pipeline of its own to show for it does not
   * fan out to its siblings.
   */
  pipelineFingerprint?: (pipeline: SupervisedPipeline, enumerated: string | null) => string | null;
  /** What a pipeline exiting on its own means for the container ({@link PipelineExitPolicy}). */
  rowExit?: PipelineExitPolicy;
  /** Reap a child we intentionally drained (relaunch/remove); the broker owner id. */
  onReap?: (pipelineId: string) => void;
  crashBackoffMs?: number;
  /** Grace after `SIGTERM` before a drain escalates to `SIGKILL` (#79). */
  drainTimeoutMs?: number;
  /** Cancelable timer backing the drain escalation; injected for tests (#79). */
  drainTimer?: DrainTimer;
};

type ChildRecord = {
  pipeline: SupervisedPipeline;
  child: FleetChild;
  fingerprint: string | null;
  /** The engine this pipeline was spawned onto — what its finished run is evidence about. */
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
 * propagate, and a lone pipeline's death is handled in-loop rather than by exiting.
 * The two ways that changes are both injected: a {@link PipelineExitPolicy} that
 * answers `"exit"` ends supervision with the dead pipeline's status, and one that
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
   * A pipeline that died on its own and is not back up: the exit a stop propagates
   * when the policy asks for it. Cleared the moment a pipeline is spawned again.
   */
  let pendingExit: EngineExit | null = null;

  /**
   * The last tenant fingerprint each supervised tenant was expanded at. The
   * trigger for re-reading pipelines, and — when a move turns out to be one no pipeline
   * fingerprint accounts for — the evidence that something tenant-wide changed.
   * A tenant held by a failed enumeration keeps its old entry, so the move it
   * could not answer is still pending at the next poll.
   */
  const tenantFingerprints = new Map<string, string | null>();

  /**
   * Per engine materialization: has each pipeline's last finished run been a
   * crash-loop tick? Sticky across a respawn — a pipeline that keeps dying instantly
   * is crash-looping between attempts as much as during them — and cleared once
   * the pipeline has been up past the healthy window, or once it is drained. Reset
   * wholesale on a new launch: the rule is about pipelines that ran *this* commit.
   */
  const crashLooping = new Map<string, boolean>();

  const isCrashLooping =
    deps.rowExit?.crashLooping ?? ((run: FleetRun) => run.elapsedMs < healthyRunMs);

  /**
   * The universality rule (#401): every pipeline that ran this engine has crash-looped.
   * An empty fleet is not universal — there is nothing to have proved it.
   */
  const everyPipelineCrashLooping = (): boolean =>
    crashLooping.size > 0 && [...crashLooping.values()].every(Boolean);

  /** One pipeline's finished run, as the exit policy and the crash-loop guard read it. */
  const runOf = (record: ChildRecord, exit: EngineExit, requestedStop: boolean): FleetRun => ({
    pipelineId: record.pipeline.id,
    tenantId: record.pipeline.tenant.id,
    pipeline: record.pipeline,
    engine: record.engine,
    exit,
    elapsedMs: now() - record.startedAt,
    requestedStop,
    everyPipelineCrashLooping: false,
  });

  /**
   * Expand discovered tenants into the pipeline matrix by asking the running engine
   * (#417). A tenant whose enumeration throws is *held*: it contributes no pipelines,
   * its running ones are protected from the removal diff by the caller, and the
   * fault is reported once for this poll. An engine that cannot enumerate at all
   * gives every tenant the implicit `work` pipeline instead, which is the fleet this
   * loop supervised before there were pipelines.
   */
  const expand = (
    samples: readonly TenantSample[],
  ): { pipelines: PipelineSample[]; held: Set<string> } => {
    const sampled: PipelineSample[] = [];
    const held = new Set<string>();
    const enumerator = engine.pipelines?.supported() === true ? engine.pipelines : null;
    for (const { tenant, fingerprint } of samples) {
      let declared: readonly Pipeline[];
      try {
        declared =
          enumerator === null
            ? [IMPLICIT_WORK_PIPELINE]
            : enumerator.pipelinesFor({
                configPath: tenant.configPath,
                cwd: tenant.dir,
                fingerprint,
              });
      } catch (error) {
        held.add(tenant.id);
        deps.onPipelinesError?.({ tenantId: tenant.id, error });
        continue;
      }
      // Sibling declarations are a property of the tenant's whole pipeline set, so
      // they are assembled here, once, rather than re-derived per spawn.
      for (const pipeline of declared) {
        const supervised: SupervisedPipeline = {
          id: pipelineId(tenant.id, pipeline.name),
          tenant,
          pipeline,
          enumerated: enumerator !== null,
          siblingEnv: [
            ...new Set(declared.filter((p) => p !== pipeline).flatMap((p) => p.env)),
          ].sort(),
        };
        sampled.push({
          pipeline: supervised,
          fingerprint:
            deps.pipelineFingerprint?.(supervised, pipeline.fingerprint) ?? pipeline.fingerprint,
        });
      }
    }
    return { pipelines: sampled, held };
  };

  // A re-armable wake signal so a child death breaks the poll wait immediately.
  let wake: () => void = () => {};
  const rearm = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  let waking = rearm();

  /**
   * Enumerate every tenant against the engine that is running now, and spawn the
   * whole matrix. The only way a fleet comes up — at boot and after an engine
   * relaunch alike — so an upgrade can never respawn a pipeline list the old checkout
   * reported.
   */
  const spawnFleetFromDiscovery = async (): Promise<void> => {
    const samples = normalizeDiscover(await deps.discover()).samples;
    const { pipelines, held } = expand(samples);
    for (const { tenant, fingerprint } of samples) {
      if (!held.has(tenant.id)) tenantFingerprints.set(tenant.id, fingerprint);
    }
    // Announced before anything spawns: a child must never be able to ask for a
    // slot the broker has not been sized and ordered for.
    deps.onPipelines?.({ pipelines: pipelines.map((sample) => sample.pipeline), reshaped: true });
    for (const { pipeline, fingerprint } of pipelines) spawnFor(pipeline, fingerprint);
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
      // A new commit is a new question: what the old checkout said about pipelines,
      // and what its pipelines had proved about it, both stop applying here.
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

  const spawnFor = (pipeline: SupervisedPipeline, fingerprint: string | null): void => {
    const child = deps.spawn(pipeline, engine);
    const record: ChildRecord = {
      pipeline,
      child,
      fingerprint,
      engine,
      startedAt: now(),
      draining: false,
      exited: null,
      finished: null,
    };
    children.set(pipeline.id, record);
    // A pipeline that has never run this engine has not crash-looped on it. One that
    // is being respawned after a fast crash keeps its mark: the crash-loop is
    // the sequence, not the individual death.
    if (!crashLooping.has(pipeline.id)) crashLooping.set(pipeline.id, false);
    // A pipeline is running again, so there is no unfinished death for a stop to
    // report.
    pendingExit = null;
    void child.exited.then((exit) => {
      record.exited = exit;
      const run = runOf(record, exit, false);
      record.finished = run;
      // Judged here rather than in the poll body so a fleet whose pipelines all died
      // together is read as such however far behind the loop is.
      if (!record.draining) crashLooping.set(pipeline.id, isCrashLooping(run));
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
    // Nor is it a crash-loop tick: a pipeline we stopped is a pipeline whose next start is
    // ours to make.
    crashLooping.delete(record.pipeline.id);
    deps.onReap?.(record.pipeline.id);
    return exit;
  };

  const drainAll = async (): Promise<EngineExit[]> => {
    const exits = await Promise.all([...children.values()].map((record) => drain(record)));
    children.clear();
    return exits;
  };

  /**
   * End supervision on a container stop: drain every pipeline, then resolve. A clean
   * 0, unless the policy propagates the pipeline's own status — as it drained, or,
   * when it died just before the stop and the backoff never got to respawn it,
   * the death that left the fleet empty.
   */
  const stopAndDrain = async (): Promise<EngineExit> => {
    const drained = await drainAll();
    if (deps.rowExit?.propagateOnStop !== true) return clean;
    return drained[0] ?? pendingExit ?? clean;
  };

  // Initial fleet: one child per pipeline of every discovered tenant. A tenant whose
  // pipelines will not enumerate contributes none and is retried at the next poll.
  await spawnFleetFromDiscovery();

  while (true) {
    if (deps.stop.requested) return await stopAndDrain();

    await Promise.race([deps.stop.wait(intervalMs), waking]);
    waking = rearm();

    if (deps.stop.requested) return await stopAndDrain();

    // 0. Bank how long each pipeline that is still up has been running, so a pipeline that
    // never exits is still evidence the guard can fall back to.
    for (const record of children.values()) {
      if (record.exited !== null || record.draining) continue;
      const elapsedMs = now() - record.startedAt;
      // Up past the healthy window: this pipeline has proved the commit, so it is no
      // longer one of the pipelines a universality verdict can be built from.
      if (elapsedMs >= healthyRunMs) crashLooping.set(record.pipeline.id, false);
      deps.onRunTick?.({
        pipelineId: record.pipeline.id,
        tenantId: record.pipeline.tenant.id,
        engine: record.engine,
        elapsedMs,
      });
    }

    // 1. Reap / respawn pipelines that died on their own (per-pipeline supervision).
    // Snapshot first — the body deletes from and adds to `children`.
    const records = Array.from(children.values());
    let relaunched = false;
    for (const record of records) {
      if (record.exited === null || record.draining) continue;
      const exit = record.exited;
      deps.onChildExit?.({ pipeline: record.pipeline, exit, expected: false });
      // The universality rule: this death is the container's business only if
      // every pipeline that ran this engine has crash-looped on it. While a sibling
      // is up, the exit policy is not even asked.
      const universal = everyPipelineCrashLooping();
      const run = { ...(record.finished ?? runOf(record, exit, false)) };
      run.everyPipelineCrashLooping = universal;
      children.delete(record.pipeline.id);
      deps.onRunEnd?.(run);
      pendingExit = exit;
      const action = universal ? (deps.rowExit?.decide(run) ?? "respawn") : "respawn";
      if (action === "exit") {
        await drainAll();
        return exit;
      }
      // Back off first, so a pipeline that dies instantly cannot spin the loop.
      await deps.stop.wait(backoffMs);
      if (deps.stop.requested) break;
      if (action === "relaunch") {
        // A crash-loop fallback only lands through a fresh materialization, so
        // the whole fleet goes back onto a re-launched engine.
        relaunched = true;
        await relaunchFleet();
        break;
      }
      if (!children.has(record.pipeline.id)) spawnFor(record.pipeline, record.fingerprint);
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

    // 3. Pipeline axis: add / drain / relaunch individual pipelines.
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
      [...children.values()].map((r) => [r.pipeline.id, r.fingerprint] as const),
    );
    const { pipelines: desired, held } = expand(samples);
    // A held tenant's pipelines are unknown, not gone: protect every one of them from
    // the removal diff, exactly as a held tenant dir is protected today (#86).
    const rowHold = new Set<string>();
    for (const record of children.values()) {
      const tenantId = record.pipeline.tenant.id;
      if (held.has(tenantId) || tenantHold.has(tenantId)) rowHold.add(record.pipeline.id);
    }
    const diff = diffPipelines(previous, desired, rowHold);

    // A tenant fingerprint that moved with no pipeline of its own to show for it is
    // by elimination a tenant-wide change — a git identity, a repo slug, an
    // edited `.env` — which every pipeline of that tenant runs with and so relaunches
    // for. Pipelines whose *own* fingerprint moved have already accounted for the
    // move, and a pipeline appearing or vanishing accounts for it too, so neither
    // drags its siblings down with it.
    const accounted = new Set<string>();
    for (const pipeline of [...diff.added, ...diff.changed]) accounted.add(pipeline.tenant.id);
    // A hot knob is one the supervisor acts on without relaunching (#402/#407):
    // `disabled` and `priority`, both deliberately outside the pipeline fingerprint.
    // Editing one moves the tenant's stat fingerprint and nothing else, so
    // without this the fan-out below would relaunch the very pipeline a hot edit was
    // meant to spare. The running record takes the new values instead, and the
    // move is accounted for.
    const relaunching = new Set(diff.changed.map((pipeline) => pipeline.id));
    for (const { pipeline } of desired) {
      const record = children.get(pipeline.id);
      if (record === undefined || relaunching.has(pipeline.id)) continue;
      if (hotKnobs(record.pipeline.pipeline) !== hotKnobs(pipeline.pipeline))
        accounted.add(pipeline.tenant.id);
      record.pipeline = pipeline;
    }
    for (const id of diff.removed) {
      const record = children.get(id);
      if (record) accounted.add(record.pipeline.tenant.id);
    }
    const fanOut: SupervisedPipeline[] = [];
    for (const tenant of diffFleet(tenantFingerprints, samples, tenantHold).changed) {
      if (held.has(tenant.id) || accounted.has(tenant.id)) continue;
      for (const { pipeline } of desired)
        if (pipeline.tenant.id === tenant.id) fanOut.push(pipeline);
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

    const reshaped = diff.added.length > 0 || diff.removed.length > 0 || changed.length > 0;
    if (reshaped) {
      deps.onPipelineChange?.({
        added: diff.added.map((pipeline) => pipeline.id),
        removed: diff.removed,
        changed: changed.map((pipeline) => pipeline.id),
      });
    }
    // The matrix as it will be once this poll has applied: everything desired,
    // plus the running pipelines of a held tenant, which are live but unenumerable
    // this poll. Announced before the diff is applied, for the same reason the
    // first spawn is.
    const live = desired.map((sample) => sample.pipeline);
    const desiredIds = new Set(live.map((pipeline) => pipeline.id));
    for (const record of children.values()) {
      if (!desiredIds.has(record.pipeline.id) && rowHold.has(record.pipeline.id))
        live.push(record.pipeline);
    }
    deps.onPipelines?.({ pipelines: live, reshaped });
    const fingerprintById = new Map(desired.map((s) => [s.pipeline.id, s.fingerprint] as const));
    for (const id of diff.removed) {
      const record = children.get(id);
      if (record) {
        await drain(record);
        children.delete(id);
      }
    }
    for (const pipeline of changed) {
      const record = children.get(pipeline.id);
      if (record) {
        await drain(record);
        children.delete(pipeline.id);
      }
      spawnFor(pipeline, fingerprintById.get(pipeline.id) ?? null);
    }
    for (const pipeline of diff.added) {
      spawnFor(pipeline, fingerprintById.get(pipeline.id) ?? null);
    }
  }
}
