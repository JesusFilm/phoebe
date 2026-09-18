// Synchronous retry-with-backoff for the engine's child-process calls.
//
// The engine's transport seams (`gh` via github-client.ts, git via
// git-model.ts) are deliberately synchronous — see
// docs/research/engine-runtime-seam.md — so the sleep between attempts must be
// synchronous too. The engine is a single-purpose daemon whose calls already
// block on `execFileSync`, so blocking a further few seconds costs nothing it
// was not already paying.
//
// One thing here is not synchronous: `jitteredBackoffMs` at the foot of the
// file, the delay rule for a connection that reconnects on a timer rather than
// a call that returns. It sits beside the sync driver because the two are one
// retry rulebook — same ladder, same reason for the jitter — and a second file
// would let them drift.

export type SleepSync = (ms: number) => void;

/** Block the thread for `ms` — `Atomics.wait` on a throwaway buffer, the one
 * spin-free way to sleep synchronously in Node. */
export const defaultSleepSync: SleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Run `fn`, retrying each failure `isRetryable` accepts after sleeping the next
 * entry of `scheduleMs`. Total attempts = `scheduleMs.length + 1`; the error
 * that exhausts the schedule (or that `isRetryable` rejects) propagates
 * unchanged, so callers' classification and enrichment see the original.
 *
 * `onRetry` fires before each sleep with the error, the delay, and the
 * 1-based retry number — the caller owns the log line.
 */
export function withBackoffSync<T>(
  fn: () => T,
  opts: {
    scheduleMs: readonly number[];
    isRetryable: (error: unknown) => boolean;
    onRetry: (error: unknown, delayMs: number, retry: number) => void;
    sleepSync?: SleepSync;
  },
): T {
  const sleep = opts.sleepSync ?? defaultSleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const delayMs = opts.scheduleMs[attempt];
      if (delayMs === undefined || !opts.isRetryable(error)) {
        throw error;
      }
      opts.onRetry(error, delayMs, attempt + 1);
      sleep(delayMs);
    }
  }
}

/**
 * The delay before retry `attempt` (0-based) of something that reconnects
 * rather than returns: full jitter under a ceiling that doubles from `firstMs`
 * and stops at `capMs`.
 *
 * Three ways this differs from {@link withBackoffSync}, and each one is why the
 * relay link (bootstrap/relay-link.ts) needs its own delay rather than a
 * schedule:
 *
 *  - **Async.** A socket's retry is a timer, not a blocked thread; the link is
 *    in the supervisor's event loop and must not stop it.
 *  - **No terminal attempt.** The top rung repeats forever. A relay that has
 *    been down for an hour is worth a knock every half-minute, and the
 *    deployment is the side with nothing better to do.
 *  - **Jittered.** Uniform over `[0, ceiling]` rather than the ceiling itself
 *    (RFC 6455 §7.2.3): fifty deployments whose relay just restarted come back
 *    spread across the window instead of in one thundering reconnect.
 */
export function jitteredBackoffMs(
  attempt: number,
  opts: { firstMs: number; capMs: number; random?: () => number },
): number {
  const rungs = Math.max(Math.trunc(attempt), 0);
  const ceiling = Math.min(opts.firstMs * 2 ** rungs, opts.capMs);
  return Math.round((opts.random ?? Math.random)() * ceiling);
}
