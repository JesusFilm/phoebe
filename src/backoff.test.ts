// Synchronous retry-with-backoff (src/backoff.ts): schedule length bounds the
// attempts, non-retryable errors escape immediately, the original error is
// what propagates.

import { describe, expect, test } from "vite-plus/test";
import { jitteredBackoffMs, withBackoffSync } from "./backoff.ts";

/** A recording sleep so no test ever actually waits. */
function spySleep(): { sleepSync: (ms: number) => void; slept: number[] } {
  const slept: number[] = [];
  return { slept, sleepSync: (ms) => slept.push(ms) };
}

/** An fn failing `failures` times before answering `value`. */
function flaky<T>(failures: number, value: T): { fn: () => T; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    fn: () => {
      calls++;
      if (calls <= failures) throw new Error(`boom ${calls}`);
      return value;
    },
  };
}

describe("withBackoffSync", () => {
  test("a first-attempt success neither sleeps nor retries", () => {
    const { sleepSync, slept } = spySleep();
    const { fn, calls } = flaky(0, "ok");
    const out = withBackoffSync(fn, {
      scheduleMs: [2_000, 8_000],
      isRetryable: () => true,
      onRetry: () => {},
      sleepSync,
    });
    expect(out).toBe("ok");
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });

  test("retries through the schedule, sleeping each entry in order", () => {
    const { sleepSync, slept } = spySleep();
    const { fn, calls } = flaky(2, "ok");
    const retries: Array<{ delayMs: number; retry: number }> = [];
    const out = withBackoffSync(fn, {
      scheduleMs: [2_000, 8_000],
      isRetryable: () => true,
      onRetry: (_e, delayMs, retry) => retries.push({ delayMs, retry }),
      sleepSync,
    });
    expect(out).toBe("ok");
    expect(calls()).toBe(3);
    expect(slept).toEqual([2_000, 8_000]);
    expect(retries).toEqual([
      { delayMs: 2_000, retry: 1 },
      { delayMs: 8_000, retry: 2 },
    ]);
  });

  test("an exhausted schedule rethrows the final original error", () => {
    const { sleepSync, slept } = spySleep();
    const { fn, calls } = flaky(3, "never");
    expect(() =>
      withBackoffSync(fn, {
        scheduleMs: [2_000, 8_000],
        isRetryable: () => true,
        onRetry: () => {},
        sleepSync,
      }),
    ).toThrow("boom 3");
    expect(calls()).toBe(3);
    expect(slept).toEqual([2_000, 8_000]);
  });

  test("a non-retryable error escapes immediately, unslept", () => {
    const { sleepSync, slept } = spySleep();
    const { fn, calls } = flaky(1, "never");
    expect(() =>
      withBackoffSync(fn, {
        scheduleMs: [2_000, 8_000],
        isRetryable: () => false,
        onRetry: () => {},
        sleepSync,
      }),
    ).toThrow("boom 1");
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });

  test("an empty schedule means a single attempt", () => {
    const { sleepSync, slept } = spySleep();
    const { fn, calls } = flaky(1, "never");
    expect(() =>
      withBackoffSync(fn, {
        scheduleMs: [],
        isRetryable: () => true,
        onRetry: () => {},
        sleepSync,
      }),
    ).toThrow("boom 1");
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });
});

describe("jitteredBackoffMs", () => {
  const ladder = { firstMs: 5_000, capMs: 30_000 };

  test("the first delay is uniform over the first rung", () => {
    expect(jitteredBackoffMs(0, { ...ladder, random: () => 0 })).toBe(0);
    expect(jitteredBackoffMs(0, { ...ladder, random: () => 0.5 })).toBe(2_500);
    expect(jitteredBackoffMs(0, { ...ladder, random: () => 1 })).toBe(5_000);
  });

  test("the ceiling doubles each attempt until the cap, then stays there", () => {
    const ceilings = [0, 1, 2, 3, 4, 20].map((attempt) =>
      jitteredBackoffMs(attempt, { ...ladder, random: () => 1 }),
    );
    expect(ceilings).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
  });

  test("there is no terminal attempt — a caller may keep asking forever", () => {
    expect(jitteredBackoffMs(Number.MAX_SAFE_INTEGER, { ...ladder, random: () => 1 })).toBe(30_000);
  });

  test("a negative or fractional attempt reads as the first rung", () => {
    expect(jitteredBackoffMs(-3, { ...ladder, random: () => 1 })).toBe(5_000);
    expect(jitteredBackoffMs(0.9, { ...ladder, random: () => 1 })).toBe(5_000);
  });
});
