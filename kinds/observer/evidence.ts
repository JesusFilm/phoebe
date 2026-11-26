// What the observer reads out of unit history (#934): the schedule gate over
// its own pipeline's records, and the flags and coverage over everyone else's.
// All of it is code, never the agent. The grouping run sees only what this
// file flagged.

import { createHash } from "node:crypto";
import type { UnitRecord } from "../../src/contracts/unit-record.ts";

/**
 * Why a unit is evidence. Today these come from the record alone; the signals
 * from what became of a unit's pull request join them with PR mode.
 */
export const UNIT_FLAGS = ["failed", "timed-out", "abandoned", "quarantined"] as const;
export type UnitFlag = (typeof UNIT_FLAGS)[number];

/** One pipeline's unit history, as read off disk. */
export type PipelineHistory = { pipeline: string; records: readonly UnitRecord[] };

/** One unit the observer counts as evidence. */
export type FlaggedUnit = {
  /** Stable across runs: what a proposal lists so a later run can tell what is new. */
  key: string;
  pipeline: string;
  record: UnitRecord;
  flags: UnitFlag[];
};

/** The flags one record earns. A quarantine rides on the timeout that caused it. */
export function flagsOf(record: UnitRecord): UnitFlag[] {
  const flags: UnitFlag[] = [];
  if (record.outcome === "failed") flags.push("failed");
  if (record.outcome === "timed-out") flags.push("timed-out");
  if (record.outcome === "abandoned") flags.push("abandoned");
  if (record.quarantined) flags.push("quarantined");
  return flags;
}

/**
 * A short, stable name for one unit run: its pipeline, kind, ref and start.
 * Hashed because a ref is kind-owned and may hold anything, and the key has to
 * sit inside an HTML comment.
 */
export function unitKeyOf(pipeline: string, record: UnitRecord): string {
  return createHash("sha256")
    .update([pipeline, record.unit.kind, record.unit.id, record.startedAt].join("\0"))
    .digest("hex")
    .slice(0, 12);
}

/** Every unit started at or after `since` that earned a flag, newest first. */
export function flagUnits(histories: readonly PipelineHistory[], since: Date): FlaggedUnit[] {
  const cut = since.getTime();
  const flagged: FlaggedUnit[] = [];
  for (const { pipeline, records } of histories) {
    for (const record of records) {
      const started = Date.parse(record.startedAt);
      if (Number.isNaN(started) || started < cut) continue;
      const flags = flagsOf(record);
      if (flags.length === 0) continue;
      flagged.push({ key: unitKeyOf(pipeline, record), pipeline, record, flags });
    }
  }
  return flagged.sort((a, b) => Date.parse(b.record.startedAt) - Date.parse(a.record.startedAt));
}

/** How far back one pipeline's history reaches inside the lookback. */
export type Coverage = {
  pipeline: string;
  /** `null` when the pipeline has no history at all. */
  coveredMs: number | null;
  /** The history reaches back the whole lookback. */
  full: boolean;
};

export function coverageOf(history: PipelineHistory, now: Date, lookbackMs: number): Coverage {
  let oldest = Number.POSITIVE_INFINITY;
  for (const record of history.records) {
    const started = Date.parse(record.startedAt);
    if (!Number.isNaN(started) && started < oldest) oldest = started;
  }
  if (oldest === Number.POSITIVE_INFINITY) {
    return { pipeline: history.pipeline, coveredMs: null, full: false };
  }
  const reach = Math.max(0, now.getTime() - oldest);
  return {
    pipeline: history.pipeline,
    coveredMs: Math.min(reach, lookbackMs),
    full: reach >= lookbackMs,
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A coverage as the summary says it: the lookback when full, else whole days or hours. */
export function formatCoverage(coverage: Coverage, lookback: string): string {
  if (coverage.full) return lookback;
  if (coverage.coveredMs === null) return "none";
  if (coverage.coveredMs >= DAY_MS) return `${Math.floor(coverage.coveredMs / DAY_MS)}d`;
  if (coverage.coveredMs >= HOUR_MS) return `${Math.floor(coverage.coveredMs / HOUR_MS)}h`;
  return "<1h";
}

/** `coverage work 14d, intake 9d`, or `coverage none` when there is nothing else to read. */
export function renderCoverage(coverages: readonly Coverage[], lookback: string): string {
  if (coverages.length === 0) return "coverage none (no other pipeline)";
  return `coverage ${coverages
    .map((coverage) => `${coverage.pipeline} ${formatCoverage(coverage, lookback)}`)
    .join(", ")}`;
}

/**
 * How long a failed or timed-out run holds off the next attempt, at most. A
 * failure is retried sooner than a whole `every` window, but not on every
 * poll: a run that fails the same way each time would otherwise spend an
 * agent run every few minutes.
 */
export const RETRY_AFTER_FAILURE_MS = HOUR_MS;

export type GateDecision =
  | { due: true; lastCompletedAt: string | null }
  | { due: false; nextAt: Date };

function settledAt(record: UnitRecord): number {
  return Date.parse(record.settledAt ?? record.startedAt);
}

/**
 * Is the observer due? `ownRecords` is its own pipeline's history, which is on
 * disk and so survives a restart: a restart inside the window finds the last
 * completed run and waits. Never run, it is due at once. An abandoned run (the
 * process died under it) holds nothing off.
 */
export function observerGate(
  ownRecords: readonly UnitRecord[],
  kind: string,
  everyMsValue: number,
  now: Date,
): GateDecision {
  let lastCompleted: UnitRecord | null = null;
  for (const record of ownRecords) {
    if (record.unit.kind !== kind || record.outcome !== "completed") continue;
    if (lastCompleted === null || settledAt(record) > settledAt(lastCompleted)) {
      lastCompleted = record;
    }
  }
  const completedAt = lastCompleted === null ? null : settledAt(lastCompleted);
  let lastFailedAt: number | null = null;
  for (const record of ownRecords) {
    if (record.unit.kind !== kind) continue;
    if (record.outcome !== "failed" && record.outcome !== "timed-out") continue;
    const at = settledAt(record);
    if (completedAt !== null && at <= completedAt) continue;
    if (lastFailedAt === null || at > lastFailedAt) lastFailedAt = at;
  }

  const holds: number[] = [];
  if (completedAt !== null) holds.push(completedAt + everyMsValue);
  if (lastFailedAt !== null) {
    holds.push(lastFailedAt + Math.min(everyMsValue, RETRY_AFTER_FAILURE_MS));
  }
  const nextAt = Math.max(Number.NEGATIVE_INFINITY, ...holds);
  if (now.getTime() < nextAt) return { due: false, nextAt: new Date(nextAt) };
  return {
    due: true,
    lastCompletedAt: lastCompleted === null ? null : (lastCompleted.settledAt ?? null),
  };
}
