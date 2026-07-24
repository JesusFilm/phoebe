// The reconcile watch loop — `phoebe boot`'s supervision of the running engine.
//
// `boot` is the container's long-lived main process (#40): it resolves the
// engine source and execs the engine as a long-running child. This module is
// what it does for the rest of the container's life — poll the two things that
// decide *which* engine should be running, and reconcile when they diverge:
//
//   - the mounted `phoebe.config.ts` (its `engine` field picks the source), and
//   - the tip of the tracked branch, versus the commit the engine is running.
//
// On a change the engine is not killed: it is sent `SIGTERM`, which it treats as
// a graceful drain (src/drain.ts) — finish the work unit in flight, start no new
// one, exit 0. Only once it is gone does boot re-resolve the source (re-read the
// config, fetch and check out the new ref) and spawn the replacement. So a
// reconcile never interrupts a work unit and never restarts the container.
//
// A poll is deliberately cheap: one `stat` of the config plus at most one
// `git ls-remote` (see bootstrap/github-engine.ts). No fetch, no checkout, and
// no work at all when nothing moved.
//
// The loop takes everything impure as a dependency — launching, spawning, the
// poll clock, the stop latch — so the drain-then-relaunch ordering is unit-tested
// without processes or timers.

import { statSync } from "node:fs";

/** How often the watch samples the config and the tracked ref. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/** Which of the two watched inputs moved, and so why the engine is relaunching. */
export type ReconcileReason = "config" | "ref";

/**
 * A single sample of the watched world.
 * - `config`: the mounted config's stat fingerprint; null when it cannot be read.
 * - `remoteSha`: the tracked branch's current tip; null when there is nothing to
 *   watch — a local mount, a pinned SHA/tag, or a ref the remote does not have.
 */
export type WatchState = {
  config: string | null;
  remoteSha: string | null;
};

/** A running engine, and the world it was launched from. */
export type LaunchedEngine = {
  /** The engine CLI path that was spawned. */
  entry: string;
  /** The commit it is running; null for a local mount (nothing to compare). */
  sha: string | null;
  /** The config fingerprint at launch. */
  config: string | null;
  /** Sample the watched inputs now, bound to the source this engine came from. */
  sample: () => WatchState;
};

export type EngineExit = { code: number | null; signal: NodeJS.Signals | null };

/** The supervised engine child: enough of a process to drain it and await it. */
export type SupervisedChild = {
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<EngineExit>;
};

/**
 * The outside stop request (container `SIGTERM`/`SIGINT`). A one-way latch whose
 * `wait` doubles as the poll clock, so a shutdown wakes the loop immediately
 * instead of sleeping out a whole poll interval — `installDrainSignal`
 * (src/drain.ts) is exactly this shape.
 */
export type StopLatch = {
  readonly requested: boolean;
  wait: (ms: number) => Promise<void>;
};

export type SuperviseDeps = {
  /** Re-read the config, resolve + materialize the engine source. */
  launch: () => Promise<LaunchedEngine> | LaunchedEngine;
  /** Spawn the engine as a long-running child. */
  spawn: (entry: string) => SupervisedChild;
  stop: StopLatch;
  intervalMs?: number;
  onRelaunch?: (reason: ReconcileReason) => void;
  onLaunchError?: (error: unknown) => void;
  onSampleError?: (error: unknown) => void;
};

/**
 * A cheap identity for the mounted config: mtime plus size. A stat is all a
 * no-change poll should cost, and any edit — in place or a replacing rename —
 * moves the mtime. Unreadable (missing, mid-rewrite, mount blip) is null, which
 * `detectChange` reads as "unknown", never as a change.
 */
export function configFingerprint(
  path: string,
  stat: (path: string) => { mtimeMs: number; size: number } = statSync,
): string | null {
  try {
    const stats = stat(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

/**
 * Is the running engine stale? Compares the live sample against what the engine
 * was launched from — not against the previous sample — so the answer is always
 * "is what's running still right", which survives a missed poll and cannot
 * relaunch twice for the same change.
 *
 * Either side being null means "nothing to compare" and yields no relaunch: an
 * unreadable config must not restart the engine, and a null `remoteSha` is how a
 * local mount and a pinned SHA/tag report an inert ref-watch.
 */
export function detectChange(opts: {
  launched: { config: string | null; sha: string | null };
  current: WatchState;
}): ReconcileReason | null {
  const { launched, current } = opts;
  // Config first: re-reading it can change which ref is even tracked.
  if (launched.config !== null && current.config !== null && current.config !== launched.config) {
    return "config";
  }
  if (launched.sha !== null && current.remoteSha !== null && current.remoteSha !== launched.sha) {
    return "ref";
  }
  return null;
}

type WatchOutcome =
  | { kind: "exit"; exit: EngineExit }
  | { kind: "change"; reason: ReconcileReason };

/**
 * Poll until the engine exits by itself, the container is stopping, or a watched
 * input moves. Races the child's exit against the poll clock so neither a long
 * poll interval nor a quiet engine delays the other.
 */
async function watchEngine(
  engine: LaunchedEngine,
  child: SupervisedChild,
  deps: SuperviseDeps,
  intervalMs: number,
): Promise<WatchOutcome> {
  // One reaction on the child's exit for the whole watch — re-deriving it each
  // iteration would pile up handlers on a promise that outlives thousands of
  // polls over a long-lived container.
  const exitOutcome = child.exited.then((exit) => ({ kind: "exit" as const, exit }));
  while (true) {
    const raced = await Promise.race([
      exitOutcome,
      deps.stop.wait(intervalMs).then(() => ({ kind: "tick" as const })),
    ]);
    if (raced.kind === "exit") return raced;

    if (deps.stop.requested) {
      // The container is going down. The spawn wrapper forwards the signal to
      // the child, but one that arrived before this child existed never reached
      // it — so re-send (the engine's drain latch is one-way and idempotent) and
      // wait the drain out rather than relaunching into a shutdown.
      child.kill("SIGTERM");
      return { kind: "exit", exit: await child.exited };
    }

    let current: WatchState;
    try {
      current = engine.sample();
    } catch (error) {
      // A failed poll (network blip on `ls-remote`, unreadable mount) is not a
      // change — leave the engine alone and look again next tick.
      deps.onSampleError?.(error);
      continue;
    }

    const reason = detectChange({
      launched: { config: engine.config, sha: engine.sha },
      current,
    });
    if (reason) return { kind: "change", reason };
  }
}

/**
 * Run the engine, and keep the *right* engine running: watch, drain, relaunch,
 * repeat. Resolves with the exit to give the container when the engine exits on
 * its own or the container is stopping — the two cases where boot should stop
 * supervising and die with the engine's status.
 */
export async function superviseEngine(deps: SuperviseDeps): Promise<EngineExit> {
  const intervalMs = deps.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  let everLaunched = false;

  while (true) {
    if (deps.stop.requested) return { code: 0, signal: null };

    let engine: LaunchedEngine;
    try {
      engine = await deps.launch();
    } catch (error) {
      // The first launch is the container's whole reason to exist, so a bad
      // config or a missing mount fails loudly. A *relaunch* failure is
      // transient by comparison (network blip mid-fetch, a ref deleted between
      // poll and fetch) and the old engine has already drained — retrying on the
      // next poll brings the engine back instead of taking the container down.
      if (!everLaunched) throw error;
      deps.onLaunchError?.(error);
      await deps.stop.wait(intervalMs);
      continue;
    }
    everLaunched = true;

    const child = deps.spawn(engine.entry);
    const outcome = await watchEngine(engine, child, deps, intervalMs);
    if (outcome.kind === "exit") return outcome.exit;

    deps.onRelaunch?.(outcome.reason);
    child.kill("SIGTERM");
    // Nothing new starts until the drain finishes: one engine at a time, and the
    // in-flight work unit runs to completion.
    const exit = await child.exited;
    if (deps.stop.requested) return exit;
  }
}
