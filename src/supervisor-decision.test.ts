import { describe, expect, test } from "vite-plus/test";
import {
  CRASH_LOOP_THRESHOLD,
  HEALTHY_RUN_SECONDS,
  INITIAL_CRASH_LOOP_STATE,
  SELF_UPDATE_EXIT_CODE,
  chooseRunSha,
  isHealthyRun,
  recordRun,
  shouldExitForSelfUpdate,
  shouldFallBack,
  shouldSelfUpdate,
  type CrashLoopState,
} from "./supervisor-decision.ts";

const selfPaths = ["apps/agent-pkg/", "pnpm-lock.yaml"] as const;

describe("shouldSelfUpdate", () => {
  test("true when a file under the package directory changed", () => {
    expect(shouldSelfUpdate(["apps/agent-pkg/src/main.ts"], selfPaths)).toBe(true);
    expect(shouldSelfUpdate(["docs/x.md", "apps/agent-pkg/Dockerfile"], selfPaths)).toBe(true);
  });

  test("true when the lockfile changed", () => {
    expect(shouldSelfUpdate(["pnpm-lock.yaml"], selfPaths)).toBe(true);
  });

  test("false for unrelated changes", () => {
    expect(shouldSelfUpdate(["apps/other/src/a.ts", "README.md"], selfPaths)).toBe(false);
    expect(shouldSelfUpdate([], selfPaths)).toBe(false);
  });

  test("non-directory entries match exactly, not as prefixes", () => {
    expect(shouldSelfUpdate(["pnpm-lock.yaml.bak"], selfPaths)).toBe(false);
    expect(shouldSelfUpdate(["apps/agent-pkg-two/src/a.ts"], selfPaths)).toBe(false);
  });

  test("exit code is stable — container/supervisor.sh watches for it", () => {
    expect(SELF_UPDATE_EXIT_CODE).toBe(42);
  });
});

describe("shouldExitForSelfUpdate", () => {
  const base = { selfUpdatePaths: selfPaths, originSha: "aaa" };

  test("matches shouldSelfUpdate when nothing is quarantined", () => {
    expect(shouldExitForSelfUpdate({ ...base, changedFiles: ["apps/agent-pkg/src/main.ts"] })).toBe(
      true,
    );
    expect(shouldExitForSelfUpdate({ ...base, changedFiles: ["README.md"] })).toBe(false);
  });

  test("stays put when origin still points at the quarantined crash-looping SHA", () => {
    expect(
      shouldExitForSelfUpdate({
        ...base,
        changedFiles: ["apps/agent-pkg/src/main.ts"],
        originSha: "bad",
        quarantinedSha: "bad",
      }),
    ).toBe(false);
  });

  test("resumes self-update once origin advances past the quarantined SHA", () => {
    expect(
      shouldExitForSelfUpdate({
        ...base,
        changedFiles: ["apps/agent-pkg/src/main.ts"],
        originSha: "fixed",
        quarantinedSha: "bad",
      }),
    ).toBe(true);
  });

  test("an empty/absent quarantine SHA is ignored", () => {
    expect(
      shouldExitForSelfUpdate({
        ...base,
        changedFiles: ["apps/agent-pkg/src/main.ts"],
        quarantinedSha: "",
      }),
    ).toBe(true);
    expect(
      shouldExitForSelfUpdate({
        ...base,
        changedFiles: ["apps/agent-pkg/src/main.ts"],
        quarantinedSha: null,
      }),
    ).toBe(true);
  });
});

describe("isHealthyRun", () => {
  test("self-update and clean exits are healthy regardless of runtime", () => {
    expect(isHealthyRun({ sha: "a", exitCode: SELF_UPDATE_EXIT_CODE, elapsedSeconds: 0 })).toBe(
      true,
    );
    expect(isHealthyRun({ sha: "a", exitCode: 0, elapsedSeconds: 0 })).toBe(true);
  });

  test("a crash after the healthy window is a transient, not a startup failure", () => {
    expect(isHealthyRun({ sha: "a", exitCode: 1, elapsedSeconds: HEALTHY_RUN_SECONDS })).toBe(true);
  });

  test("a fast non-zero exit is a crash", () => {
    expect(isHealthyRun({ sha: "a", exitCode: 1, elapsedSeconds: 3 })).toBe(false);
    expect(isHealthyRun({ sha: "a", exitCode: 137, elapsedSeconds: 0 })).toBe(false);
  });
});

describe("shouldFallBack / chooseRunSha", () => {
  test("runs the target until it has crashed threshold times", () => {
    const state: CrashLoopState = { lastGoodSha: "good", failingSha: "bad", failureCount: 2 };
    expect(shouldFallBack("bad", state)).toBe(false);
    expect(chooseRunSha("bad", state)).toBe("bad");
  });

  test("falls back to last-good once the target crash-loops past the threshold", () => {
    const state: CrashLoopState = {
      lastGoodSha: "good",
      failingSha: "bad",
      failureCount: CRASH_LOOP_THRESHOLD,
    };
    expect(shouldFallBack("bad", state)).toBe(true);
    expect(chooseRunSha("bad", state)).toBe("good");
  });

  test("does not fall back when there is no distinct good SHA to run", () => {
    expect(shouldFallBack("bad", { lastGoodSha: null, failingSha: "bad", failureCount: 9 })).toBe(
      false,
    );
    expect(shouldFallBack("bad", { lastGoodSha: "bad", failingSha: "bad", failureCount: 9 })).toBe(
      false,
    );
  });

  test("a crash-looping SHA stops being avoided once the branch moves on", () => {
    const state: CrashLoopState = {
      lastGoodSha: "good",
      failingSha: "bad",
      failureCount: CRASH_LOOP_THRESHOLD,
    };
    // origin advanced to a new SHA — run it fresh, quarantine no longer applies.
    expect(shouldFallBack("newer", state)).toBe(false);
    expect(chooseRunSha("newer", state)).toBe("newer");
  });
});

describe("recordRun", () => {
  test("a healthy run becomes the new last-good and clears its own failures", () => {
    const after = recordRun(
      { lastGoodSha: "old", failingSha: "sha", failureCount: 2 },
      { sha: "sha", exitCode: SELF_UPDATE_EXIT_CODE, elapsedSeconds: 0 },
    );
    expect(after).toEqual({ lastGoodSha: "sha", failingSha: null, failureCount: 0 });
  });

  test("a fallback run of the good SHA preserves the quarantine of the bad one", () => {
    // Pinned to "good" while "bad" is quarantined; the good run stays healthy.
    const after = recordRun(
      { lastGoodSha: "good", failingSha: "bad", failureCount: CRASH_LOOP_THRESHOLD },
      { sha: "good", exitCode: SELF_UPDATE_EXIT_CODE, elapsedSeconds: 0 },
    );
    expect(after).toEqual({
      lastGoodSha: "good",
      failingSha: "bad",
      failureCount: CRASH_LOOP_THRESHOLD,
    });
  });

  test("fast crashes accumulate for the same SHA", () => {
    let state = INITIAL_CRASH_LOOP_STATE;
    state = recordRun(state, { sha: "bad", exitCode: 1, elapsedSeconds: 2 });
    expect(state).toEqual({ lastGoodSha: null, failingSha: "bad", failureCount: 1 });
    state = recordRun(state, { sha: "bad", exitCode: 1, elapsedSeconds: 2 });
    expect(state.failureCount).toBe(2);
  });

  test("a fast crash of a new SHA resets the counter but keeps last-good", () => {
    const after = recordRun(
      { lastGoodSha: "good", failingSha: "bad", failureCount: 5 },
      { sha: "newer", exitCode: 1, elapsedSeconds: 1 },
    );
    expect(after).toEqual({ lastGoodSha: "good", failingSha: "newer", failureCount: 1 });
  });

  test("full crash-loop → fallback → recovery cycle", () => {
    // "good" self-updated cleanly (last-good recorded), then bad "B" lands.
    let state: CrashLoopState = { lastGoodSha: "good", failingSha: null, failureCount: 0 };
    let target = "B";

    // B crashes on startup THRESHOLD times.
    for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) {
      expect(chooseRunSha(target, state)).toBe("B");
      state = recordRun(state, { sha: "B", exitCode: 1, elapsedSeconds: 2 });
    }
    expect(state.failureCount).toBe(CRASH_LOOP_THRESHOLD);

    // Now the supervisor pins to "good"; running it stays healthy, quarantine held.
    expect(chooseRunSha(target, state)).toBe("good");
    state = recordRun(state, { sha: "good", exitCode: SELF_UPDATE_EXIT_CODE, elapsedSeconds: 120 });
    expect(state).toEqual({ lastGoodSha: "good", failingSha: "B", failureCount: 3 });
    expect(chooseRunSha(target, state)).toBe("good"); // still pinned while origin == B

    // A fix "F" lands; run it fresh and it stays healthy. "B"'s quarantine is
    // now stale (origin has moved past it) but harmless — recordRun can't see
    // the current target, and chooseRunSha only ever consults it when the target
    // *is* the failing SHA, which it no longer is.
    target = "F";
    expect(chooseRunSha(target, state)).toBe("F");
    state = recordRun(state, { sha: "F", exitCode: 0, elapsedSeconds: 300 });
    expect(state).toEqual({ lastGoodSha: "F", failingSha: "B", failureCount: 3 });
    expect(chooseRunSha("F", state)).toBe("F");
  });
});
