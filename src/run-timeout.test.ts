// Run-timeout tests (#72): env/config resolution and the deadline race.

import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  RunTimeoutError,
  resolveRunTimeoutMs,
  resolveRunTimeoutMsForKind,
  runWithDeadline,
} from "./run-timeout.ts";
import type { WorkKindsField } from "./config-schema.ts";

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

describe("resolveRunTimeoutMs", () => {
  test("defaults to 45 minutes", () => {
    expect(resolveRunTimeoutMs({})).toBe(DEFAULT_RUN_TIMEOUT_MS);
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(2_700_000);
  });
  test("config value is used when env is unset", () => {
    expect(resolveRunTimeoutMs({}, 60_000)).toBe(60_000);
  });
  test("PHOEBE_RUN_TIMEOUT_MS overrides the config value", () => {
    expect(resolveRunTimeoutMs({ PHOEBE_RUN_TIMEOUT_MS: "90000" }, 60_000)).toBe(90_000);
  });
  test("a non-positive or garbage env value falls back to the config value", () => {
    expect(resolveRunTimeoutMs({ PHOEBE_RUN_TIMEOUT_MS: "0" }, 60_000)).toBe(60_000);
    expect(resolveRunTimeoutMs({ PHOEBE_RUN_TIMEOUT_MS: "nope" }, 60_000)).toBe(60_000);
  });
});

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

describe("resolveRunTimeoutMsForKind (#415)", () => {
  const resolve = (
    env: NodeJS.ProcessEnv,
    workKinds: WorkKindsField = {},
    configValue = 2_700_000,
  ) => resolveRunTimeoutMsForKind({ kind: "issues", env, workKinds, configValue });

  test("the kind block outranks the tenant field", () => {
    expect(resolve({}, { issues: { runTimeoutMs: 60_000 } })).toBe(60_000);
  });

  test("the kind block outranks the global env var", () => {
    expect(resolve({ PHOEBE_RUN_TIMEOUT_MS: "900000" }, { issues: { runTimeoutMs: 60_000 } })).toBe(
      60_000,
    );
  });

  test("the per-kind env var outranks the kind block", () => {
    expect(
      resolve({ PHOEBE_ISSUES_RUN_TIMEOUT_MS: "5000" }, { issues: { runTimeoutMs: 60_000 } }),
    ).toBe(5_000);
  });

  test("a kind with no block falls through to the tenant ladder", () => {
    expect(resolve({}, { reviews: { runTimeoutMs: 1 } })).toBe(2_700_000);
    expect(resolve({ PHOEBE_RUN_TIMEOUT_MS: "900000" })).toBe(900_000);
    expect(resolve({}, {}, 0)).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  test("a hyphenated custom kind maps to an underscored env var", () => {
    expect(
      resolveRunTimeoutMsForKind({
        kind: "stale-pr-nudger",
        env: { PHOEBE_STALE_PR_NUDGER_RUN_TIMEOUT_MS: "7000" },
        workKinds: {},
      }),
    ).toBe(7_000);
  });
});
