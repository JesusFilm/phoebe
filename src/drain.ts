// Graceful-drain coordination for the persistent engine loop.
//
// `phoebe boot` (the bootstrapper) runs the engine as a long-lived child and
// stops it with SIGTERM — on container shutdown, and on a config/ref change the
// reconcile watch relaunches for (bootstrap/reconcile.ts). A hard SIGTERM would
// kill the engine mid-work-unit, abandoning a half-finished agent run (a dirty
// worktree, maybe a partially pushed branch). Instead the engine treats SIGTERM
// as a *drain* request: finish the unit in flight, start no new one, exit 0.
//
// This module is that one-way latch — a boolean that flips on the first signal,
// plus an interruptible wait so an idle poll-sleep wakes immediately instead of
// stalling shutdown for a whole poll interval. It takes the emitter and signal
// names as arguments (defaulting to `process` / `SIGTERM`) so the latch logic is
// unit-tested without sending real process signals.
//
// Both poll loops use it, for the same reason: the engine's work loop drains on
// it (src/main.ts), and the bootstrapper's supervision loop takes it as the
// container's stop request (bootstrap/supervise-fleet.ts) so a shutdown wakes the
// watch instead of waiting out a poll interval — and so boot survives the moment
// between draining one engine and spawning its replacement.

export interface DrainSignal {
  /** True once a drain has been requested; never flips back. */
  readonly requested: boolean;
  /**
   * Resolve after `ms`, or immediately once a drain is requested — whichever
   * comes first. A drain arriving mid-wait wakes it so the loop stops promptly
   * rather than sleeping out the full poll interval.
   *
   * Several waits may be outstanding at once. The engine loop races this
   * against its in-flight units settling (#422), so a wait it stopped caring
   * about is still pending when the next one starts — and a wait that keeps a
   * single shared waker slot would have the abandoned timer clear the live
   * one's, leaving a later SIGTERM with nothing to wake.
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
  // Resolvers for the waits currently outstanding, so a drain wakes every one
  // of them early. Each removes its own entry as it settles, so an abandoned
  // wait cannot cancel a live one.
  const wakers = new Set<() => void>();

  const onSignal = () => {
    requested = true;
    for (const wake of wakers) wake();
  };
  for (const signal of signals) emitter.on(signal, onSignal);

  return {
    get requested() {
      return requested;
    },
    wait(ms: number): Promise<void> {
      if (requested) return Promise.resolve();
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const settle = (): void => {
          clearTimeout(timer);
          wakers.delete(settle);
          resolve();
        };
        timer = setTimeout(settle, ms);
        wakers.add(settle);
      });
    },
    dispose() {
      for (const signal of signals) emitter.off(signal, onSignal);
      for (const wake of wakers) wake();
    },
  };
}
