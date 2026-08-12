import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  hourBucket,
  pushBudgetExhausted,
  pushesThisHour,
  PUSH_RATE_LIMIT_FILE,
  pushRateLimitPath,
  recordPush,
} from "./push-rate-limit.ts";

const roots: string[] = [];

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "phoebe-push-rate-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HOUR_ONE = new Date("2026-08-12T04:15:00.000Z");
const SAME_HOUR_LATER = new Date("2026-08-12T04:55:00.000Z");
const NEXT_HOUR = new Date("2026-08-12T05:01:00.000Z");

describe("push rate limit counter", () => {
  test("starts at zero with no persisted state", () => {
    const dir = stateDir();
    expect(pushesThisHour(dir, HOUR_ONE)).toBe(0);
    expect(pushBudgetExhausted(dir, 1, HOUR_ONE)).toBe(false);
  });

  test("counts pushes within the same wall-clock hour", () => {
    const dir = stateDir();
    expect(recordPush(dir, HOUR_ONE)).toBe(1);
    expect(recordPush(dir, SAME_HOUR_LATER)).toBe(2);
    expect(pushesThisHour(dir, HOUR_ONE)).toBe(2);
  });

  test("rolls over to a fresh bucket on the hour boundary", () => {
    const dir = stateDir();
    recordPush(dir, HOUR_ONE);
    recordPush(dir, HOUR_ONE);
    expect(pushesThisHour(dir, NEXT_HOUR)).toBe(0);
    expect(recordPush(dir, NEXT_HOUR)).toBe(1);
    expect(pushesThisHour(dir, NEXT_HOUR)).toBe(1);
  });

  test("reports the budget exhausted once the count meets the max", () => {
    const dir = stateDir();
    recordPush(dir, HOUR_ONE);
    recordPush(dir, HOUR_ONE);
    expect(pushBudgetExhausted(dir, 2, HOUR_ONE)).toBe(true);
    expect(pushBudgetExhausted(dir, 3, HOUR_ONE)).toBe(false);
  });

  test("a corrupt or unreadable file reads as no history rather than throwing", () => {
    const dir = stateDir();
    writeFileSync(pushRateLimitPath(dir), "not json");
    expect(pushesThisHour(dir, HOUR_ONE)).toBe(0);
    expect(recordPush(dir, HOUR_ONE)).toBe(1);
  });

  test("persists via one atomic rename, leaving no temp debris", () => {
    const dir = stateDir();
    const calls: string[] = [];
    recordPush(dir, HOUR_ONE, {
      exists: () => false,
      mkdir: () => undefined,
      write: (path) => calls.push(`write:${String(path)}`),
      rename: (from, to) => calls.push(`rename:${String(from)}:${String(to)}`),
      read: () => "",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/write:.*push-rate-v1\.json\.tmp-/);
    expect(calls[1]).toMatch(/rename:.*push-rate-v1\.json\.tmp-.*:.*push-rate-v1\.json/);

    recordPush(dir, HOUR_ONE);
    expect(readdirSync(dir)).toEqual([PUSH_RATE_LIMIT_FILE]);
    expect(JSON.parse(readFileSync(pushRateLimitPath(dir), "utf8"))).toEqual({
      hourBucket: hourBucket(HOUR_ONE),
      count: 1,
    });
  });
});
