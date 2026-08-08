// Run-timeout tests (#72): the deadline race. `runTimeoutMs` resolution
// (config default + `PHOEBE_RUN_TIMEOUT_MS` overlay) moved to the config
// layer (#56) — see src/load-config.test.ts.

import { describe, expect, test } from "vite-plus/test";
import { RunTimeoutError, runWithDeadline } from "./run-timeout.ts";

/** A manual clock: `setTimer` records the fn; `fire()` runs the armed one. */
function fakeTimers() {
  let armed: (() => void) | null = null;
  let cleared = false;
  return {
    setTimer: (fn: () => void) => {
      armed = fn;
      return 1;
    },
    clearTimer: () => {
      cleared = true;
    },
    fire: () => armed?.(),
    get cleared() {
      return cleared;
    },
  };
}

describe("runWithDeadline", () => {
  test("resolves with the work result when it finishes in time", async () => {
    const timers = fakeTimers();
    const result = await runWithDeadline({
      ms: 1000,
      work: async () => "done",
      timers,
    });
    expect(result).toBe("done");
    expect(timers.cleared).toBe(true);
  });

  test("aborts the signal and rejects with RunTimeoutError on expiry", async () => {
    const timers = fakeTimers();
    let sawAbort = false;
    const pending = runWithDeadline({
      ms: 1000,
      work: (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve("late"); // the killed child would settle here
          });
        }),
      timers,
    });
    timers.fire();
    await expect(pending).rejects.toBeInstanceOf(RunTimeoutError);
    expect(sawAbort).toBe(true);
    expect(timers.cleared).toBe(true);
  });

  test("a post-timeout rejection from work still surfaces as RunTimeoutError", async () => {
    const timers = fakeTimers();
    const pending = runWithDeadline({
      ms: 1000,
      work: (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("child killed")));
        }),
      timers,
    });
    timers.fire();
    await expect(pending).rejects.toBeInstanceOf(RunTimeoutError);
  });

  test("propagates work's own error when it fails before the deadline", async () => {
    const timers = fakeTimers();
    await expect(
      runWithDeadline({ ms: 1000, work: async () => Promise.reject(new Error("boom")), timers }),
    ).rejects.toThrow("boom");
  });
});
