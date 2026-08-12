// Bound branch pushes per hour, not open PRs (#168): rebases and fix-pushes —
// not PR count — dominate CI cost, since every push to an existing PR branch
// is a full CI run. `git-model.ts`'s `pushBranch` is the single choke point
// every kind's push funnels through (see `main.ts#buildGitOps`), so this
// module owns exactly one thing: a wall-clock-hour counter of pushes made
// against it, persisted so a container restart cannot reset the budget mid
// hour. A wall-clock bucket (not a rolling window) matches Renovate's
// `commitHourlyLimit` — cheaper to maintain and adequate for a cost backstop.
//
// This module only counts and answers "is the budget spent" — the policy
// decision of what to do about it (skip a unit vs. fall through to a
// different kind) lives in `main.ts`, right before unit selection.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { join } from "node:path";

export const PUSH_RATE_LIMIT_FILE = "push-rate-v1.json";

export type PushRateLimitIo = {
  exists: (path: PathLike) => boolean;
  mkdir: (path: PathLike, options: { recursive: true }) => unknown;
  write: (path: PathLike, data: string, encoding: "utf8") => unknown;
  rename: (from: PathLike, to: PathLike) => unknown;
  read: (path: PathLike, encoding: "utf8") => string;
};

const DEFAULT_IO: PushRateLimitIo = {
  exists: existsSync,
  mkdir: mkdirSync,
  write: writeFileSync,
  rename: renameSync,
  read: readFileSync,
};

type PushRateCounter = { hourBucket: string; count: number };

export function pushRateLimitPath(stateDir: string): string {
  return join(stateDir, PUSH_RATE_LIMIT_FILE);
}

/** Wall-clock hour bucket, e.g. `2026-08-12T04` — a push in the same bucket counts toward the same budget. */
export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

function isPushRateCounter(value: unknown): value is PushRateCounter {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PushRateCounter).hourBucket === "string" &&
    typeof (value as PushRateCounter).count === "number"
  );
}

/** Malformed or unreadable state reads as "no history" — the counter simply starts a fresh bucket rather than failing the cycle. */
function readCounter(stateDir: string, io: PushRateLimitIo): PushRateCounter | null {
  const path = pushRateLimitPath(stateDir);
  if (!io.exists(path)) return null;
  try {
    const parsed: unknown = JSON.parse(io.read(path, "utf8"));
    return isPushRateCounter(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCounter(stateDir: string, counter: PushRateCounter, io: PushRateLimitIo): void {
  io.mkdir(stateDir, { recursive: true });
  const target = pushRateLimitPath(stateDir);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  io.write(temporary, `${JSON.stringify(counter)}\n`, "utf8");
  io.rename(temporary, target);
}

/** How many pushes this repo has made in `now`'s hour bucket — 0 for a fresh or stale (prior-hour) bucket. */
export function pushesThisHour(
  stateDir: string,
  now: Date,
  io: PushRateLimitIo = DEFAULT_IO,
): number {
  const counter = readCounter(stateDir, io);
  if (!counter || counter.hourBucket !== hourBucket(now)) return 0;
  return counter.count;
}

/** Record one push against `now`'s hour bucket, rolling over a stale bucket first. Returns the new count. */
export function recordPush(stateDir: string, now: Date, io: PushRateLimitIo = DEFAULT_IO): number {
  const bucket = hourBucket(now);
  const previous = readCounter(stateDir, io);
  const count = (previous && previous.hourBucket === bucket ? previous.count : 0) + 1;
  writeCounter(stateDir, { hourBucket: bucket, count }, io);
  return count;
}

/** Whether this repo has already spent its `maxPushesPerHour` budget for `now`'s hour. */
export function pushBudgetExhausted(
  stateDir: string,
  maxPushesPerHour: number,
  now: Date,
  io: PushRateLimitIo = DEFAULT_IO,
): boolean {
  return pushesThisHour(stateDir, now, io) >= maxPushesPerHour;
}
