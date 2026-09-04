// The reconcile vocabulary — what `phoebe boot` watches, and how it reads a sample.
//
// `boot` is the container's long-lived main process (#40): it resolves the
// engine source and execs the engine as a long-running child. For the rest of
// the container's life it polls the two things that decide *which* engine should
// be running, and reconciles when they diverge:
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
// Following a branch means eventually following it onto a commit that does not
// boot, so a finished run is reported and a self-exit is judged. The policy
// behind those hooks — count fast crashes, pin back to the last-good commit — is
// bootstrap/crash-loop.ts; all the watch knows is that a launch may be avoiding a
// quarantined commit, which the ref-watch must then stop treating as a change.
//
// The loop that acts on all of this is bootstrap/supervise-fleet.ts, and since
// #416 it is the only one: solo is a one-tenant fleet. This module holds what
// both the loop and boot need to agree on — the launched-engine shape, the
// sample, and `detectChange`.

import { statSync } from "node:fs";
import { type ResolvedEngineSource } from "./engine-source.ts";
import type { RowEnumerator } from "./pipeline-rows.ts";

/** How often the watch samples the config and the tracked ref. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/**
 * How long boot waits before relaunching an engine that crashed. Long enough
 * that a commit dying instantly cannot spin the loop, short enough that the
 * crash-loop guard reaches its verdict in well under a minute. Deliberately not
 * the poll interval: a consumer who slows their reconcile poll down to a
 * quarter-hour should not thereby wait an hour for a fallback.
 */
export const CRASH_BACKOFF_MS = 10_000;

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
  /** The resolved engine source at launch — compared on a stat-only config move. */
  source: ResolvedEngineSource;
  /**
   * Re-read the mounted config and return its resolved engine source. Stat is the
   * cheap poll trigger; this load runs only when the fingerprint moved (#138).
   */
  confirmEngineSource?: () => Promise<ResolvedEngineSource>;
  /** Sample the watched inputs now, bound to the source this engine came from. */
  sample: () => WatchState;
  /**
   * The crash-looping commit this launch is avoiding, when it is a crash-loop
   * fallback (bootstrap/crash-loop.ts) — the tracked branch still points there,
   * and the watch must not read that as a change to chase. Null normally.
   */
  quarantinedSha: string | null;
  /**
   * Whether the crash-loop guard covers this launch — true only for a github
   * source tracking a moving branch. The loop only carries it through to the
   * exit hooks; boot.ts is what decides with it.
   */
  guarded: boolean;
  /**
   * This checkout's row enumerator (#417), probed once at materialization. Its
   * home is the launch because capability is a property of the engine commit:
   * an upgrade may legitimately report a different row set for the same config,
   * so the answer never outlives the checkout it came from.
   */
  rows?: RowEnumerator;
};

export type EngineExit = { code: number | null; signal: NodeJS.Signals | null };

/** A finished engine run: what was running, how it ended, and how long it lived. */
export type EngineRun = {
  engine: LaunchedEngine;
  exit: EngineExit;
  elapsedMs: number;
  /**
   * Whether boot ended this run (a reconcile drain, or a container stop) rather
   * than the engine exiting of its own accord — the difference between evidence
   * about the engine commit and evidence about nothing.
   */
  requestedStop: boolean;
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
 *
 * One tip is deliberately ignored: the quarantined commit a crash-loop fallback
 * is running away from (bootstrap/crash-loop.ts). While the branch still points
 * there, "the running engine is not on the tip" is the intended state, not a
 * change — reading it as one would relaunch straight back into the bad commit.
 */
export function detectChange(opts: {
  launched: { config: string | null; sha: string | null; quarantinedSha?: string | null };
  current: WatchState;
}): ReconcileReason | null {
  const { launched, current } = opts;
  // Config first: re-reading it can change which ref is even tracked.
  if (launched.config !== null && current.config !== null && current.config !== launched.config) {
    return "config";
  }
  if (launched.sha !== null && current.remoteSha !== null && current.remoteSha !== launched.sha) {
    return current.remoteSha === launched.quarantinedSha ? null : "ref";
  }
  return null;
}
