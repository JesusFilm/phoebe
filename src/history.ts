// The history read (#930, decided in #918): one query over the unit histories
// on the data volume, shared by `phoebe history` and `GET /api/history`, so the
// two return the same page for the same filters.
//
// It reads the files directly. Each cell's history is its pipeline's
// `units.jsonl` and the rotated `units.1.jsonl` beside it (src/unit-record.ts),
// so the read works while the bootstrapper is down, and nothing is cached: a
// page is built from what is on disk when it is asked for.
//
// A line this reader cannot use is skipped, never fatal. That covers a record
// version it does not know (one rotated file can span an engine upgrade), a
// line cut short by a crash mid-append, and anything else that will not parse.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentReport } from "./contracts/deployment.ts";
import type {
  HistoryPage,
  HistoryQuery,
  HistoryRecord,
  HistoryTotals,
} from "./contracts/history.ts";
import {
  UNIT_RECORD_VERSION,
  type UnitRecord,
  type UnitRecordOutcome,
} from "./contracts/unit-record.ts";
import { derivePaths } from "./paths.ts";
import { UNITS_FILE, UNITS_ROTATED_FILE } from "./unit-record.ts";

/** Records on a page when the query names no limit. */
export const HISTORY_DEFAULT_LIMIT = 50;

/** The most records one page holds; a larger limit is clamped to this. */
export const HISTORY_MAX_LIMIT = 200;

/** Every outcome a record can carry, in the order a summary lists them. */
export const UNIT_RECORD_OUTCOMES: readonly UnitRecordOutcome[] = [
  "completed",
  "failed",
  "timed-out",
  "abandoned",
];

/** Separates the parts of a cursor: `<startedAt>~<kind>~<id>`. */
const CURSOR_SEPARATOR = "~";

/** One cell's history on disk: the cell's id and its pipeline's dir under `state/`. */
export type HistorySource = { cell: string; dir: string };

/** Reads a file's text; throwing means the file is not there. */
export type ReadText = (path: string) => string;

const readText: ReadText = (path) => readFileSync(path, "utf8");

/**
 * The cells whose history this deployment holds, from its report. A cell whose
 * tenant has no slug has no data directory, so it has no history either.
 */
export function historySourcesOf(
  report: DeploymentReport | null,
  dataBase: string,
): HistorySource[] {
  if (report === null) return [];
  const sources: HistorySource[] = [];
  for (const cell of report.fleet.cells) {
    if (cell.tenant.slug === null) continue;
    sources.push({
      cell: cell.id,
      dir: join(derivePaths(cell.tenant.slug, dataBase).stateDir, cell.pipeline),
    });
  }
  return sources;
}

/** One line of a history file as a record, or `null` when this reader cannot use it. */
export function parseUnitLine(line: string): UnitRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["v"] !== UNIT_RECORD_VERSION) return null;
  if (typeof record["startedAt"] !== "string") return null;
  const unit = record["unit"];
  if (typeof unit !== "object" || unit === null) return null;
  const runs = record["agentRuns"];
  if (!Array.isArray(runs)) return null;
  for (const run of runs) {
    if (typeof run !== "object" || run === null) return null;
  }
  return value as UnitRecord;
}

/**
 * Every record one pipeline's history holds, the rotated generation first. A
 * missing file is an empty one.
 */
export function readUnitHistory(dir: string, read: ReadText = readText): UnitRecord[] {
  const records: UnitRecord[] = [];
  for (const name of [UNITS_ROTATED_FILE, UNITS_FILE]) {
    let text: string;
    try {
      text = read(join(dir, name));
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const record = parseUnitLine(line);
      if (record !== null) records.push(record);
    }
  }
  return records;
}

/** Totals with nothing counted yet. */
export function emptyHistoryTotals(): HistoryTotals {
  return {
    units: 0,
    byOutcome: { completed: 0, failed: 0, "timed-out": 0, abandoned: 0 },
    quarantined: 0,
    costUsd: { api: 0, subscriptionEstimate: 0 },
    unitsWithoutCost: 0,
    unitsWithPartialUsage: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * Count and sum a set of records. Each agent run's cost goes to the total for
 * its own basis, so API spend and a subscription estimate never meet.
 */
export function summarizeHistory(records: readonly UnitRecord[]): HistoryTotals {
  const totals = emptyHistoryTotals();
  for (const record of records) {
    totals.units += 1;
    if (record.outcome in totals.byOutcome) totals.byOutcome[record.outcome] += 1;
    if (record.quarantined) totals.quarantined += 1;
    let costed = false;
    let partial = false;
    for (const run of record.agentRuns) {
      if (run.costUsd !== null) {
        costed = true;
        if (run.costBasis === "subscription-estimate") {
          totals.costUsd.subscriptionEstimate += run.costUsd;
        } else {
          totals.costUsd.api += run.costUsd;
        }
      }
      if (!run.usageComplete) partial = true;
      totals.tokens.input += run.inputTokens ?? 0;
      totals.tokens.output += run.outputTokens ?? 0;
      totals.tokens.cacheRead += run.cacheReadTokens ?? 0;
      totals.tokens.cacheWrite += run.cacheWriteTokens ?? 0;
    }
    if (!costed) totals.unitsWithoutCost += 1;
    if (partial) totals.unitsWithPartialUsage += 1;
  }
  return totals;
}

/**
 * Where a record sits in the newest-first order, as a cursor: `startedAt`, then
 * the unit and its cell, so two units that started in the same millisecond still have an
 * order, and the order does not move when a file rotates.
 */
export function historyCursorOf(record: HistoryRecord): string {
  return [record.startedAt, record.unit.kind, record.unit.id, record.cell].join(CURSOR_SEPARATOR);
}

/** The limit a page actually uses: the default when absent, never above the cap. */
export function clampHistoryLimit(limit: number | undefined): number {
  if (limit === undefined) return HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), HISTORY_MAX_LIMIT);
}

function matches(record: HistoryRecord, query: HistoryQuery): boolean {
  return (
    (query.kind === undefined || record.unit.kind === query.kind) &&
    (query.outcome === undefined || record.outcome === query.outcome) &&
    (query.provider === undefined || record.provider === query.provider) &&
    (query.model === undefined || record.model === query.model) &&
    (query.since === undefined || record.startedAt >= query.since)
  );
}

/**
 * One page of history. The summary covers every record the filters match, so
 * it is the same on every page; `before` and `limit` only choose which of
 * those records this page shows.
 */
export function queryHistory(
  sources: readonly HistorySource[],
  query: HistoryQuery,
  read: ReadText = readText,
): HistoryPage {
  const limit = clampHistoryLimit(query.limit);
  const cells =
    query.cell === undefined ? sources : sources.filter((source) => source.cell === query.cell);

  const retained: Record<string, string | null> = {};
  const matched: HistoryRecord[] = [];
  for (const source of cells) {
    let oldest: string | null = null;
    for (const record of readUnitHistory(source.dir, read)) {
      if (oldest === null || record.startedAt < oldest) oldest = record.startedAt;
      const entry: HistoryRecord = { ...record, cell: source.cell };
      if (matches(entry, query)) matched.push(entry);
    }
    retained[source.cell] = oldest;
  }

  const keyed = matched.map((record) => ({ record, key: historyCursorOf(record) }));
  keyed.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const before = query.before;
  const after = before === undefined ? keyed : keyed.filter((entry) => entry.key < before);
  const page = after.slice(0, limit);
  const last = page.at(-1);

  return {
    records: page.map((entry) => entry.record),
    summary: summarizeHistory(matched),
    nextBefore: after.length > page.length && last !== undefined ? last.key : null,
    retained,
  };
}

/** The query's raw fields, as a query string or the CLI's flags hand them over. */
export type RawHistoryQuery = Partial<Record<keyof HistoryQuery, string>>;

/** A timestamp in the one form records carry, so string order is time order. */
function isoOf(text: string, what: string): string {
  const at = Date.parse(text);
  if (Number.isNaN(at)) {
    throw new Error(`${what} takes a date or an ISO timestamp (got \`${text}\`).`);
  }
  return new Date(at).toISOString();
}

/**
 * Check the raw fields and put them in the form {@link queryHistory} compares:
 * timestamps as ISO, `limit` as a number. An empty field is an absent one. A
 * limit above the cap is not an error; the query clamps it.
 */
export function parseHistoryQuery(raw: RawHistoryQuery): HistoryQuery {
  const query: HistoryQuery = {};
  const text = (name: keyof HistoryQuery): string | undefined => {
    const value = raw[name]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  };
  for (const name of ["cell", "kind", "provider", "model"] as const) {
    const value = text(name);
    if (value !== undefined) query[name] = value;
  }
  const outcome = text("outcome");
  if (outcome !== undefined) {
    if (!(UNIT_RECORD_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new Error(
        `\`outcome\` is one of ${UNIT_RECORD_OUTCOMES.join(", ")} (got \`${outcome}\`).`,
      );
    }
    query.outcome = outcome as UnitRecordOutcome;
  }
  const since = text("since");
  if (since !== undefined) query.since = isoOf(since, "`since`");
  const before = text("before");
  if (before !== undefined) {
    const cut = before.indexOf(CURSOR_SEPARATOR);
    query.before =
      cut === -1
        ? isoOf(before, "`before`")
        : `${isoOf(before.slice(0, cut), "`before`")}${before.slice(cut)}`;
  }
  const limit = text("limit");
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1) {
      throw new Error(`\`limit\` must be a positive whole number (got \`${limit}\`).`);
    }
    query.limit = Number(limit);
  }
  return query;
}
