// Per-run execution timeout (#72) — a wall-clock budget on the agent phase.
//
// Under the #59 concurrency broker (default cap 1) a single hung work unit holds
// its slot forever and starves every other repo. This module bounds the phase
// where a hang is both likely and actionable — the agent run: the engine races
// `runAgent` against a deadline and, on expiry, aborts, killing the agent
// subprocess (`runAgent` respects the `AbortSignal`) so the `finally` that owns
// worktree cleanup and slot release runs within a known ceiling. The engine
// stays alive and continues its loop; the supervisor is never told (Decision 3),
// so a unit timeout is not an engine exit and never trips the crash-loop guard
// (#60 orthogonality).
//
// Scope, precisely: this deadline wraps the agent call only. The synchronous
// install/test/push phases (`execSync`) run outside it — an `AbortSignal` cannot
// interrupt a blocked `execSync` anyway, so they rely on their own fast-fail
// sub-timeouts (gh/git `CHILD_PROCESS_TIMEOUT_MS`, shell `SHELL_COMMAND_TIMEOUT_MS`).
// Extending one budget across the *whole* unit (install→push) is a tracked #72
// follow-up; today the budget covers the agent phase, where real hangs happen.

import { workKindOverride, type WorkKindsField } from "./config-schema.ts";
import { workKindEnvVar } from "./provider-selection.ts";

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

/**
 * One kind's run timeout (#415), on the same ladder the provider knobs use:
 *
 *   1. per-kind env    (`PHOEBE_ISSUES_RUN_TIMEOUT_MS`)
 *   2. per-kind config (`kinds.issues.runTimeoutMs`)
 *   3. global env      (`PHOEBE_RUN_TIMEOUT_MS`)
 *   4. the tenant's    `runTimeoutMs`, else the shipped default
 *
 * Per-kind config outranks the global env var for the reason it does there: a
 * kind's block is durable policy, and only the kind-specific var pushes it
 * aside. An intake sweep that should die after two minutes and an
 * implementation kind that legitimately runs an hour no longer have to agree.
 */
export function resolveRunTimeoutMsForKind(opts: {
  kind: string;
  env: NodeJS.ProcessEnv;
  workKinds: WorkKindsField;
  configValue?: number;
}): number {
  const { kind, env, workKinds } = opts;
  const perKind = Number(env[workKindEnvVar(kind, "RUN_TIMEOUT_MS")]);
  if (Number.isFinite(perKind) && perKind > 0) return perKind;
  const declared = workKindOverride(workKinds, kind)?.runTimeoutMs;
  if (declared !== undefined && declared > 0) return declared;
  return resolveRunTimeoutMs(env, opts.configValue);
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
