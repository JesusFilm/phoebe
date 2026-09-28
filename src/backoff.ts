// Synchronous retry-with-backoff for the engine's child-process calls.
//
// The engine's transport seams (`gh` via github-client.ts, git via
// git-model.ts) are deliberately synchronous — see
// docs/research/engine-runtime-seam.md — so the sleep between attempts must be
// synchronous too. The engine is a single-purpose daemon whose calls already
// block on `execFileSync`, so blocking a further few seconds costs nothing it
// was not already paying.

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
