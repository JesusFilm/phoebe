// Pure self-update + crash-loop decisions. The container's shell supervisor
// stays dumb; these functions are the tested specification it mirrors.
//
//   - shouldSelfUpdate / shouldExitForSelfUpdate — after each cycle's fetch,
//     did Phoebe's own code move on the default branch? If so the orchestrator
//     exits with SELF_UPDATE_EXIT_CODE and the supervisor reinstalls + re-execs.
//   - chooseRunSha / recordRun — the daemon's last-good crash-loop fallback:
//     if a freshly-pulled SHA keeps dying on startup, pin to the last SHA that
//     ran healthily until the default branch advances past the bad one.
//
// The supervisor mirrors this logic in POSIX sh (container/supervisor.sh)
// rather than calling it, so the fallback survives the very failure it guards
// against — a bad pull that makes this TypeScript itself fail to run. Keep the
// two in sync; the tests here are the reference semantics.

/** Deliberate "I need a reinstall + re-exec" exit code, watched by container/supervisor.sh. */
export const SELF_UPDATE_EXIT_CODE = 42;

/** Consecutive fast crashes of a freshly-pulled SHA before the daemon falls
 *  back to the last SHA that ran healthily. Mirrored in container/supervisor.sh. */
export const CRASH_LOOP_THRESHOLD = 3;

/** Seconds an orchestrator run must survive to count as healthy: a startup
 *  crash from a bad pull dies well within this, a transient runtime error does
 *  not. Mirrored in container/supervisor.sh. */
export const HEALTHY_RUN_SECONDS = 60;

/**
 * Whether any changed file means Phoebe's own code (or the lockfile behind its
 * dependencies) moved. `selfUpdatePaths` entries ending in `/` match as
 * directory prefixes; other entries match exactly.
 */
export function shouldSelfUpdate(
  changedFiles: readonly string[],
  selfUpdatePaths: readonly string[],
): boolean {
  return changedFiles.some((file) =>
    selfUpdatePaths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)),
  );
}

/**
 * Whether the orchestrator should exit for a supervisor self-update. Same as
 * {@link shouldSelfUpdate}, except a run pinned to the last-good SHA (the
 * supervisor passes the crash-looping SHA it is quarantining) must not
 * self-update back into that quarantined commit: while `origin/<branch>` still
 * points at it, stay on the good code.
 */
export function shouldExitForSelfUpdate(opts: {
  changedFiles: readonly string[];
  selfUpdatePaths: readonly string[];
  /** Current `origin/<defaultBranch>` SHA. */
  originSha: string;
  /** The crash-looping SHA the supervisor is avoiding, if any. */
  quarantinedSha?: string | null;
}): boolean {
  if (opts.quarantinedSha && opts.originSha === opts.quarantinedSha) return false;
  return shouldSelfUpdate(opts.changedFiles, opts.selfUpdatePaths);
}

/** Crash-loop bookkeeping, persisted across container restarts on /data/state. */
export type CrashLoopState = {
  /** SHA that last ran healthily — the fallback target. */
  lastGoodSha: string | null;
  /** SHA currently accumulating fast-crash counts (or quarantined as bad). */
  failingSha: string | null;
  /** Consecutive fast crashes recorded for `failingSha`. */
  failureCount: number;
};

export const INITIAL_CRASH_LOOP_STATE: CrashLoopState = {
  lastGoodSha: null,
  failingSha: null,
  failureCount: 0,
};

/**
 * Whether the supervisor should abandon `target` and re-run the last known-good
 * SHA — true only once `target` has fast-crashed `threshold` times and a
 * *different* good SHA exists to fall back to (if the good SHA is `target`
 * itself, falling back changes nothing, so we keep retrying `target`).
 */
export function shouldFallBack(
  target: string,
  state: CrashLoopState,
  threshold: number = CRASH_LOOP_THRESHOLD,
): boolean {
  return (
    state.failingSha === target &&
    state.failureCount >= threshold &&
    state.lastGoodSha !== null &&
    state.lastGoodSha !== target
  );
}

/** The SHA the supervisor should check out and run this iteration. */
export function chooseRunSha(
  target: string,
  state: CrashLoopState,
  threshold: number = CRASH_LOOP_THRESHOLD,
): string {
  return shouldFallBack(target, state, threshold) ? (state.lastGoodSha as string) : target;
}

export type RunOutcome = {
  /** SHA that was run. */
  sha: string;
  /** Orchestrator exit code. */
  exitCode: number;
  /** Seconds the run survived before exiting. */
  elapsedSeconds: number;
};

/**
 * A run is healthy — its code booted and worked — if it self-updated, exited
 * cleanly, or survived the healthy window before exiting. Only a fast non-zero,
 * non-self-update exit is a crash that counts toward the fallback threshold.
 */
export function isHealthyRun(
  outcome: RunOutcome,
  healthySeconds: number = HEALTHY_RUN_SECONDS,
): boolean {
  return (
    outcome.exitCode === SELF_UPDATE_EXIT_CODE ||
    outcome.exitCode === 0 ||
    outcome.elapsedSeconds >= healthySeconds
  );
}

/**
 * Fold a completed run into the crash-loop state. A healthy run becomes the new
 * last-good, but a quarantine of a *different* crash-looping SHA is preserved
 * (a fallback run of the good SHA must not clear the bad SHA's record). A fast
 * crash increments the count for its SHA, resetting when the failing SHA moves.
 */
export function recordRun(
  state: CrashLoopState,
  outcome: RunOutcome,
  healthySeconds: number = HEALTHY_RUN_SECONDS,
): CrashLoopState {
  if (isHealthyRun(outcome, healthySeconds)) {
    const stillQuarantining = state.failingSha !== null && state.failingSha !== outcome.sha;
    return {
      lastGoodSha: outcome.sha,
      failingSha: stillQuarantining ? state.failingSha : null,
      failureCount: stillQuarantining ? state.failureCount : 0,
    };
  }
  if (state.failingSha === outcome.sha) {
    return { ...state, failureCount: state.failureCount + 1 };
  }
  return { lastGoodSha: state.lastGoodSha, failingSha: outcome.sha, failureCount: 1 };
}
