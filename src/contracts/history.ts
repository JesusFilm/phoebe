// The history read (#930, decided in #918): one page of unit records, as
// `phoebe history --json` prints it and `GET /api/history` answers it. Both
// call one query (src/history.ts), so for the same filters they return the
// same bytes.
//
// Pure types, so the console can load them from `phoebe-agent/contracts`.

import type { UnitRecord, UnitRecordOutcome } from "./unit-record.ts";

/** A unit record as the history read returns it: the record, and the cell whose file held it. */
export type HistoryRecord = UnitRecord & {
  /** The report's `<tenantId>#<pipeline>`. */
  cell: string;
};

/**
 * Counts and sums over a set of unit records. No averages and no rates: a
 * renderer may divide two of these, but nothing here is derived from another.
 */
export type HistoryTotals = {
  units: number;
  byOutcome: Record<UnitRecordOutcome, number>;
  quarantined: number;
  /** Cost by basis, never added together: an estimate is not money anyone paid. */
  costUsd: { api: number; subscriptionEstimate: number };
  /** Units where no agent run reported a cost. */
  unitsWithoutCost: number;
  /** Units with at least one agent run whose usage is a lower bound. */
  unitsWithPartialUsage: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/** The filters a history read takes. Every one is optional, and they combine with AND. */
export type HistoryQuery = {
  /** One cell, by the report's `<tenantId>#<pipeline>`. */
  cell?: string;
  kind?: string;
  outcome?: UnitRecordOutcome;
  provider?: string;
  model?: string;
  /** ISO timestamp: records that started at or after it. */
  since?: string;
  /** A previous page's `nextBefore`, or an ISO timestamp: records that sort after it. */
  before?: string;
  /** Records on one page: 50 when absent, at most 200. */
  limit?: number;
};

/** One page of history, newest first by `startedAt`. */
export type HistoryPage = {
  records: HistoryRecord[];
  /** Totals over every record the filters match, not just this page. */
  summary: HistoryTotals;
  /** The cursor for the next page, or `null` when this page is the last. */
  nextBefore: string | null;
  /**
   * How far back each matched cell's history reaches: the `startedAt` of the
   * oldest record still on disk, or `null` for a cell with none. Older units
   * have rotated out, so an empty stretch before this is not a quiet one.
   */
  retained: Record<string, string | null>;
};
