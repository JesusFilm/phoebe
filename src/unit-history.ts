// Reading a unit history back (#929, decisions in #918): the records a
// pipeline's writer (src/unit-record.ts) left on disk, and the summary the
// deployment report carries of them.
//
// The summary is a pure function of the records and a clock. The bootstrapper
// runs it — at boot, when a pipeline reports a new record, and hourly so a quiet
// pipeline's windows still slide — and writes the answer into the report. No
// reader runs it again, so `phoebe status`, the console and the companion
// cannot disagree about what a week cost.
//
// It counts and sums and never averages. Cost stays split by basis, because an
// API bill and a subscription's list-price estimate are different kinds of
// number and their sum means nothing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  UNIT_RECORD_VERSION,
  type HistorySummary,
  type HistoryWindow,
  type UnitRecord,
} from "./contracts/unit-record.ts";
import { UNITS_FILE, UNITS_ROTATED_FILE } from "./unit-record.ts";

/** The shorter window: the last day. */
export const HISTORY_DAY_MS = 24 * 60 * 60 * 1000;

/** The longer window, and the most history the report ever summarizes. */
export const HISTORY_WEEK_MS = 7 * HISTORY_DAY_MS;

/**
 * One line of a history file as a record, or null for anything that is not a
 * record this reader knows: a torn line, another version, a shape it cannot sum.
 */
export function parseUnitLine(line: string): UnitRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<UnitRecord>;
  if (record.v !== UNIT_RECORD_VERSION) return null;
  if (typeof record.startedAt !== "string" || typeof record.outcome !== "string") return null;
  if (!Array.isArray(record.agentRuns)) return null;
  return record as UnitRecord;
}

/**
 * Every record one pipeline holds, both generations, oldest first. A missing or
 * unreadable file holds nothing; a pipeline that has never settled a unit is the
 * ordinary case, not a fault.
 */
export function readUnitHistory(
  stateDir: string,
  pipeline: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): UnitRecord[] {
  const records: UnitRecord[] = [];
  for (const file of [UNITS_ROTATED_FILE, UNITS_FILE]) {
    let text: string;
    try {
      text = read(join(stateDir, pipeline, file));
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const record = parseUnitLine(line);
      if (record !== null) records.push(record);
    }
  }
  return records;
}

/** A window with nothing in it. */
export function emptyHistoryWindow(): HistoryWindow {
  return {
    units: 0,
    outcomes: { completed: 0, failed: 0, "timed-out": 0, abandoned: 0 },
    quarantined: 0,
    costUsd: { api: 0, subscriptionEstimate: 0 },
    unitsWithoutCost: 0,
    unitsWithPartialUsage: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** Float sums of cents drift; a millionth of a dollar is finer than any bill. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Count and sum every record handed in. Which records belong is the caller's call. */
export function summarizeWindow(records: readonly UnitRecord[]): HistoryWindow {
  const window = emptyHistoryWindow();
  let api = 0;
  let estimate = 0;
  for (const record of records) {
    window.units += 1;
    if (record.outcome in window.outcomes) window.outcomes[record.outcome] += 1;
    if (record.quarantined) window.quarantined += 1;
    let costed = false;
    let partial = false;
    for (const run of record.agentRuns) {
      if (!run.usageComplete) partial = true;
      window.tokens.input += run.inputTokens ?? 0;
      window.tokens.output += run.outputTokens ?? 0;
      window.tokens.cacheRead += run.cacheReadTokens ?? 0;
      window.tokens.cacheWrite += run.cacheWriteTokens ?? 0;
      // A figure with no basis cannot go in either total, and adding it to one
      // would be guessing which money it was.
      if (run.costUsd === null) continue;
      if (run.costBasis === "api") {
        api += run.costUsd;
        costed = true;
      } else if (run.costBasis === "subscription-estimate") {
        estimate += run.costUsd;
        costed = true;
      }
    }
    if (!costed) window.unitsWithoutCost += 1;
    if (partial) window.unitsWithPartialUsage += 1;
  }
  window.costUsd = { api: roundUsd(api), subscriptionEstimate: roundUsd(estimate) };
  return window;
}

/**
 * The summary as of `now`: the units that started inside each window. By start
 * rather than settle, because an abandoned unit never settled and the history
 * read pages by start too.
 */
export function summarizeHistory(records: readonly UnitRecord[], now: number): HistorySummary {
  const inside = (windowMs: number): UnitRecord[] =>
    records.filter((record) => {
      const at = Date.parse(record.startedAt);
      return Number.isFinite(at) && at > now - windowMs;
    });
  return {
    asOf: new Date(now).toISOString(),
    last24h: summarizeWindow(inside(HISTORY_DAY_MS)),
    last7d: summarizeWindow(inside(HISTORY_WEEK_MS)),
  };
}
