// Graceful-drain coordination for the persistent engine loop.
//
// `phoebe boot` (the bootstrapper) runs the engine as a long-lived child and
// stops it with SIGTERM — on container shutdown today, and on a config/ref
// change once the respawn logic lands. A hard SIGTERM would kill the engine
// mid-work-unit, abandoning a half-finished agent run (a dirty worktree, maybe a
// partially pushed branch). Instead the engine treats SIGTERM as a *drain*
// request: finish the unit in flight, start no new one, exit 0.
//
// This module is that one-way latch — a boolean that flips on the first signal,
// plus an interruptible wait so an idle poll-sleep wakes immediately instead of
// stalling shutdown for a whole poll interval. It takes the emitter and signal
// names as arguments (defaulting to `process` / `SIGTERM`) so the latch logic is
// unit-tested without sending real process signals.

export interface DrainSignal {
  /** True once a drain has been requested; never flips back. */
  readonly requested: boolean;
  /**
   * Resolve after `ms`, or immediately once a drain is requested — whichever
   * comes first. A drain arriving mid-wait wakes it so the loop stops promptly
   * rather than sleeping out the full poll interval. Single-waiter: the loop
   * awaits one wait() at a time.
   */
  wait(ms: number): Promise<void>;
  /** Remove the signal listeners and cancel any pending wait. Idempotent. */
  dispose(): void;
}

export function installDrainSignal(
  emitter: NodeJS.EventEmitter = process,
  signals: readonly NodeJS.Signals[] = ["SIGTERM"],
): DrainSignal {
  let requested = false;
  // Resolver for an in-flight wait(), so a drain can wake it early. Cleared once
  // it fires (or the wait times out) so we never resolve a stale promise.
  let wake: (() => void) | undefined;

  const onSignal = () => {
    requested = true;
    wake?.();
  };
  for (const signal of signals) emitter.on(signal, onSignal);

  return {
    get requested() {
      return requested;
    },
    wait(ms: number): Promise<void> {
      if (requested) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    },
    dispose() {
      for (const signal of signals) emitter.off(signal, onSignal);
      wake?.();
    },
  };
}
