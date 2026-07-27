// Crash-loop fallback for `phoebe boot` — the guard on a bad engine ref.
//
// The reconcile watch (reconcile.ts) will happily follow the tracked branch onto
// any commit someone pushes, including one that dies on startup. Without a guard
// that is an unattended container crash-looping on an unattended repo. So boot
// keeps a small record of which engine commits actually *ran*: a SHA that dies
// fast, repeatedly, is quarantined, and boot pins back to the last SHA that ran
// healthily until the tracked branch moves past the bad one.
//
// This module is that record and the decisions over it — pure folds plus a JSON
// file — so the whole ladder (first crash → threshold → fallback → recovery) is
// tested without spawning an engine. The wiring (when a run ends, what to
// materialize, what to log) lives in boot.ts; the loop that calls it is
// reconcile.ts.
//
// The record lives in the engine's state dir (`paths.stateDir`, default
// `/data/state` — a named volume) rather than beside the engine clone, so a
// quarantine survives a container restart *and* a wiped engine volume: the whole
// point is to remember across the restart the crash itself causes.
//
// Only a github source with a moving branch is guarded. A local mount has no
// commit to pin, and a pinned ref means pinning — boot must not silently serve
// different code than the operator asked for (see boot.ts's eligibility check).
//
// This is the only crash-loop policy there is: the engine's own self-update and
// the shell supervisor that mirrored a copy of these decisions are gone (#44).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Consecutive fast crashes of one engine SHA before boot pins back to the
 * last-good one. Three is enough to rule out a one-off (a flaky network on the
 * engine's first fetch, a busy host) while still recovering in minutes.
 */
export const CRASH_LOOP_THRESHOLD = 3;

/**
 * How long an engine run must survive to count as healthy. A commit that cannot
 * boot dies well inside this; a long-lived engine that later hits a runtime
 * error does not, and pinning to older code would not help it.
 */
export const HEALTHY_RUN_MS = 60_000;

/** State dir used when the mounted config names none (matches the engine's default). */
export const DEFAULT_STATE_DIR = "/data/state";

/** Filename of the crash-loop record inside the state dir. */
export const CRASH_LOOP_STATE_FILE = "engine-crash-loop.json";

/** Crash-loop bookkeeping, persisted across container restarts on the state volume. */
export type CrashLoopState = {
  /** SHA that last ran healthily — the fallback target. */
  lastGoodSha: string | null;
  /** SHA currently accumulating fast-crash counts (or quarantined as bad). */
  failingSha: string | null;
  /** Consecutive fast crashes recorded for `failingSha`. */
  failureCount: number;
};

/** Nothing known yet: no proven commit, no quarantine. */
export const INITIAL_CRASH_LOOP_STATE: CrashLoopState = {
  lastGoodSha: null,
  failingSha: null,
  failureCount: 0,
};

/** A finished engine run, as the fallback policy sees it. */
export type RunOutcome = {
  /** The engine commit that was running. */
  sha: string;
  /** Its exit code; null when a signal killed it. */
  exitCode: number | null;
  /** How long it lived. */
  elapsedMs: number;
  /**
   * Whether boot ended this run — a reconcile drain or a container stop — rather
   * than the engine exiting of its own accord. Load-bearing: a run boot cut
   * short proves nothing either way.
   */
  requestedStop: boolean;
};

/** What a finished run proved about the commit it was running. */
export type RunVerdict =
  /** The commit works — it lived past the healthy window, or finished its own work. */
  | "healthy"
  /** The commit dies on startup: the thing the fallback exists to catch. */
  | "crash"
  /** Nothing was proved, so the record must not move. */
  | "inconclusive";

/**
 * Judge a finished run. The three-way answer matters: a run that neither proved
 * nor disproved its commit has to leave the record alone, and reading it as
 * "healthy" would be the worse mistake — a container stop landing mid-crash-loop
 * would promote the crashing commit to last-good and disarm the fallback for
 * good.
 */
export function judgeRun(run: RunOutcome, healthyMs: number = HEALTHY_RUN_MS): RunVerdict {
  // Living past the window proves the commit boots, however the run then ended.
  if (run.elapsedMs >= healthyMs) return "healthy";
  // Boot pulled the plug before the window was up: no verdict either way.
  if (run.requestedStop) return "inconclusive";
  // Exiting 0 unprompted means the engine finished what it was asked to do
  // (`--run-once`), which it could only do by booting.
  if (run.exitCode === 0) return "healthy";
  // A signal from outside — an OOM kill, a `docker kill` — says nothing about
  // the code either.
  if (run.exitCode === null) return "inconclusive";
  return "crash";
}

/**
 * Fold a finished run into the record. A healthy run becomes the new last-good,
 * but a quarantine on a *different* SHA is preserved — the healthy run is
 * usually the fallback itself, and clearing the record there would send the next
 * launch straight back into the commit it is avoiding. A fast crash counts
 * against its own SHA, starting over whenever the failing SHA moves — except
 * against an *active* quarantine, which outlives it.
 */
export function recordRun(
  state: CrashLoopState,
  run: RunOutcome,
  opts: { healthyMs?: number; threshold?: number } = {},
): CrashLoopState {
  const threshold = opts.threshold ?? CRASH_LOOP_THRESHOLD;
  switch (judgeRun(run, opts.healthyMs ?? HEALTHY_RUN_MS)) {
    case "inconclusive":
      return state;
    case "healthy": {
      const stillQuarantining = state.failingSha !== null && state.failingSha !== run.sha;
      return {
        lastGoodSha: run.sha,
        failingSha: stillQuarantining ? state.failingSha : null,
        failureCount: stillQuarantining ? state.failureCount : 0,
      };
    }
    case "crash": {
      if (state.failingSha === run.sha) return { ...state, failureCount: state.failureCount + 1 };
      // The fallback crashing too does not exonerate the commit it is standing
      // in for: the quarantine has to hold until the tracked ref moves past the
      // bad SHA, so a crash of some other commit must not overwrite it.
      if (state.failingSha !== null && state.failureCount >= threshold) return state;
      return { lastGoodSha: state.lastGoodSha, failingSha: run.sha, failureCount: 1 };
    }
  }
}

/**
 * Is there a better commit to relaunch onto than the one that just crashed?
 * Answers boot's question after a fast crash: retry (the fallback is reachable,
 * even if the threshold is not met yet) or give up and let the container exit.
 * Without this, a first-ever bad ref — or a fallback that crashes too — would
 * relaunch forever instead of failing where an operator can see it.
 */
export function hasFallbackTarget(state: CrashLoopState, crashedSha: string): boolean {
  return state.lastGoodSha !== null && state.lastGoodSha !== crashedSha;
}

/**
 * The commit to run *instead of* `targetSha` (the tracked ref's current tip), or
 * null to run the target as normal. Non-null only once the target has
 * fast-crashed `threshold` times and a different known-good commit exists — so
 * the fallback lapses by itself the moment the branch advances past the bad SHA,
 * which is exactly "fallback persists until the ref moves on".
 */
export function fallbackSha(
  targetSha: string,
  state: CrashLoopState,
  threshold: number = CRASH_LOOP_THRESHOLD,
): string | null {
  if (state.failingSha !== targetSha || state.failureCount < threshold) return null;
  return hasFallbackTarget(state, targetSha) ? state.lastGoodSha : null;
}

/**
 * Where the engine keeps its persistent state, read straight from the mounted
 * config. The bootstrapper resolves this itself — it writes the record before
 * the engine (which owns the config schema) has even been materialized — so a
 * missing or malformed `paths.stateDir` falls back to the engine's own default
 * rather than being trusted or rejected.
 */
export function readStateDir(config: Record<string, unknown>): string {
  const paths = config["paths"];
  if (paths === null || typeof paths !== "object") return DEFAULT_STATE_DIR;
  const stateDir = (paths as Record<string, unknown>)["stateDir"];
  return typeof stateDir === "string" && stateDir.length > 0 ? stateDir : DEFAULT_STATE_DIR;
}

/** The crash-loop record's path inside a state dir. */
export function crashLoopStatePath(stateDir: string): string {
  return join(stateDir, CRASH_LOOP_STATE_FILE);
}

function isCrashLoopState(value: unknown): value is CrashLoopState {
  if (value === null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    (state["lastGoodSha"] === null || typeof state["lastGoodSha"] === "string") &&
    (state["failingSha"] === null || typeof state["failingSha"] === "string") &&
    typeof state["failureCount"] === "number"
  );
}

/**
 * Read the record, or start fresh. Anything unreadable — no file yet, a
 * half-written one from a container killed mid-write, a hand-edited mess —
 * degrades to "nothing known" rather than failing boot: the cost is losing one
 * fallback target, and the alternative is a bootstrapper that a bad file bricks.
 */
export function readCrashLoopState(path: string): CrashLoopState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isCrashLoopState(parsed)) return INITIAL_CRASH_LOOP_STATE;
    return {
      lastGoodSha: parsed.lastGoodSha,
      failingSha: parsed.failingSha,
      failureCount: parsed.failureCount,
    };
  } catch {
    return INITIAL_CRASH_LOOP_STATE;
  }
}

/**
 * Persist the record, creating the state dir if the volume is empty. Throws on a
 * genuinely unwritable state dir; the guard turns that into an event, since
 * losing the fallback is better than refusing to run the engine.
 */
export function writeCrashLoopState(path: string, state: CrashLoopState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Everything the guard decides that is worth telling an operator about. Emitted
 * rather than logged so the policy stays testable and boot.ts owns the wording —
 * a container silently serving older code than its config asks for is exactly
 * the confusing situation these lines exist to prevent.
 */
export type CrashGuardEvent =
  | {
      kind: "crash";
      sha: string;
      exitCode: number | null;
      elapsedMs: number;
      failureCount: number;
      threshold: number;
    }
  /** A run proved its commit; it is now the fallback target. */
  | { kind: "last-good"; sha: string }
  /** This launch is pinned to `lastGoodSha` instead of the tracked ref's tip. */
  | { kind: "fallback"; quarantinedSha: string; lastGoodSha: string; failureCount: number }
  /** The fallback crashed too. The quarantine holds; boot is out of options. */
  | {
      kind: "fallback-crashed";
      sha: string;
      quarantinedSha: string;
      exitCode: number | null;
      elapsedMs: number;
    }
  /** The tracked ref moved past the quarantined commit; the pin lapses. */
  | { kind: "recovered"; quarantinedSha: string; sha: string }
  | { kind: "persist-failed"; path: string; error: unknown };

/**
 * The crash-loop guard boot supervises with: the persisted record, held in
 * memory for the life of the container and written through on every change.
 */
export type CrashGuard = {
  /**
   * The commit to run instead of `targetSha` (the tracked ref's tip), or null to
   * run the target. Called once per launch, before the engine is spawned.
   */
  fallbackFor: (targetSha: string) => string | null;
  /** Fold a finished run into the record and persist it. */
  record: (run: RunOutcome) => void;
  /**
   * A commit is still running, and has been for `elapsedMs`. Once that passes
   * the healthy window the commit has proved itself, so it is banked as the
   * fallback target *while it runs* — an engine that has been up for a month and
   * is then killed by a host reboot would otherwise have left no record at all,
   * and the bad commit waiting on the branch would have nothing to fall back to.
   */
  noteAlive: (sha: string, elapsedMs: number) => void;
  /**
   * Is relaunching after this run worth it? Only for a crash, and only when a
   * *different* known-good commit exists to end up on — otherwise boot lets the
   * container exit rather than loop on the same broken commit forever. The
   * answer does not depend on whether `record` ran first: folding a crash in
   * never changes which commit is last-good.
   */
  shouldRetry: (run: RunOutcome) => boolean;
};

export function createCrashGuard(deps: {
  /** The record's path, resolved from the mounted config at boot. */
  statePath: string;
  onEvent?: (event: CrashGuardEvent) => void;
  threshold?: number;
  healthyMs?: number;
}): CrashGuard {
  const threshold = deps.threshold ?? CRASH_LOOP_THRESHOLD;
  const healthyMs = deps.healthyMs ?? HEALTHY_RUN_MS;
  const options = { threshold, healthyMs };
  const emit = (event: CrashGuardEvent) => deps.onEvent?.(event);
  let state = readCrashLoopState(deps.statePath);

  const persist = (next: CrashLoopState) => {
    state = next;
    try {
      writeCrashLoopState(deps.statePath, next);
    } catch (error) {
      // In-memory bookkeeping still guards this container's life; only the
      // across-restart half is lost.
      emit({ kind: "persist-failed", path: deps.statePath, error });
    }
  };

  return {
    fallbackFor(targetSha) {
      const pin = fallbackSha(targetSha, state, threshold);
      if (pin !== null) {
        emit({
          kind: "fallback",
          quarantinedSha: targetSha,
          lastGoodSha: pin,
          failureCount: state.failureCount,
        });
        return pin;
      }
      if (state.failingSha !== null && state.failingSha !== targetSha) {
        // The tracked ref has moved on, so whatever we knew about the old commit
        // is history. Dropping it here (rather than leaving it for the next
        // crash to overwrite) is what makes the fallback lapse exactly once.
        const quarantinedSha = state.failingSha;
        const wasQuarantined = state.failureCount >= threshold;
        persist({ lastGoodSha: state.lastGoodSha, failingSha: null, failureCount: 0 });
        if (wasQuarantined) emit({ kind: "recovered", quarantinedSha, sha: targetSha });
      }
      return null;
    },

    record(run) {
      const before = state;
      const verdict = judgeRun(run, healthyMs);
      persist(recordRun(before, run, options));

      if (verdict === "inconclusive") return;
      if (verdict === "healthy") {
        if (state.lastGoodSha !== before.lastGoodSha) emit({ kind: "last-good", sha: run.sha });
        return;
      }
      if (
        before.failingSha !== null &&
        before.failingSha !== run.sha &&
        before.failureCount >= threshold
      ) {
        // A crash the quarantine swallowed — this is the fallback itself dying,
        // which reads very differently in a log to the tracked ref dying.
        emit({
          kind: "fallback-crashed",
          sha: run.sha,
          quarantinedSha: before.failingSha,
          exitCode: run.exitCode,
          elapsedMs: run.elapsedMs,
        });
        return;
      }
      emit({
        kind: "crash",
        sha: run.sha,
        exitCode: run.exitCode,
        elapsedMs: run.elapsedMs,
        failureCount: state.failureCount,
        threshold,
      });
    },

    noteAlive(sha, elapsedMs) {
      if (elapsedMs < healthyMs || state.lastGoodSha === sha) return;
      persist(recordRun(state, { sha, exitCode: null, elapsedMs, requestedStop: false }, options));
      emit({ kind: "last-good", sha });
    },

    shouldRetry(run) {
      return judgeRun(run, healthyMs) === "crash" && hasFallbackTarget(state, run.sha);
    },
  };
}
