// Per-run execution timeout (#72) — a whole-unit wall-clock budget.
//
// Under the #59 concurrency broker (default cap 1) a single hung work unit holds
// its slot forever and starves every other repo. This module bounds it: the
// engine races its unit against a deadline and, on expiry, aborts — killing the
// agent subprocess (`runAgent` respects the `AbortSignal`) so the `finally` that
// owns worktree cleanup and slot release runs within a known ceiling, no matter
// which phase hangs. The engine stays alive and continues its loop; the
// supervisor is never told (Decision 3), so a unit timeout is not an engine exit
// and never trips the crash-loop guard (#60 orthogonality).
//
// The existing inner sub-timeouts (gh/git `CHILD_PROCESS_TIMEOUT_MS`, shell
// `SHELL_COMMAND_TIMEOUT_MS`) stay as fast-fail bounds; this is the outer
// guarantee. Synchronous phases (install/test via `execSync`) can only observe
// the abort at the next async boundary — the agent phase, where hangs actually
// happen and the `AbortSignal` is actionable.

/** 45 minutes — the shipped default whole-unit budget (config `runTimeoutMs`). */
export const DEFAULT_RUN_TIMEOUT_MS = 2_700_000;

/** Thrown when a unit exceeds its wall-clock budget. */
export class RunTimeoutError extends Error {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(`Work unit exceeded its ${elapsedMs}ms wall-clock budget and was aborted.`);
    this.name = "RunTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Resolve the run timeout: `PHOEBE_RUN_TIMEOUT_MS` (a positive integer) wins,
 * else the config field, else the shipped default. Mirrors how the engine reads
 * `PHOEBE_POLL_INTERVAL_MS` — a direct env read, not the config overlay.
 */
export function resolveRunTimeoutMs(
  env: NodeJS.ProcessEnv,
  configValue: number = DEFAULT_RUN_TIMEOUT_MS,
): number {
  const raw = Number(env["PHOEBE_RUN_TIMEOUT_MS"]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return configValue > 0 ? configValue : DEFAULT_RUN_TIMEOUT_MS;
}

type Timers = {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

const realTimers: Timers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Run `work` under a wall-clock deadline. `work` receives an `AbortSignal` that
 * fires when the budget expires; it must wire that signal to whatever it spawns
 * (the agent child) so the abort actually kills the hung process. If the
 * deadline wins the race, this rejects with `RunTimeoutError` after signalling
 * the abort; otherwise it resolves/rejects with `work`'s own result and the
 * timer is always cleared.
 */
export async function runWithDeadline<T>(opts: {
  ms: number;
  work: (signal: AbortSignal) => Promise<T>;
  timers?: Timers;
}): Promise<T> {
  const timers = opts.timers ?? realTimers;
  const controller = new AbortController();
  let timedOut = false;
  let handle: unknown;

  // Settle the timeout leg without rejecting, and wrap `work` so a late
  // rejection after the abort never escapes as an unhandled rejection. The
  // winner of the race is decided by `timedOut`, not by which promise settled
  // first — so a killed child that resolves `work` "successfully" during the
  // abort still surfaces as a timeout (#72: post-abort settle is a symptom).
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    handle = timers.setTimer(() => {
      timedOut = true;
      controller.abort();
      resolve({ kind: "timeout" });
    }, opts.ms);
  });
  const settled = opts.work(controller.signal).then(
    (value) => ({ kind: "ok" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  try {
    const outcome = await Promise.race([settled, timeout]);
    if (timedOut || outcome.kind === "timeout") throw new RunTimeoutError(opts.ms);
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  } finally {
    timers.clearTimer(handle);
  }
}
