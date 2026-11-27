// @ts-check
// Unit history as a file (#992, decided in #979): the CSV columns and the JSON
// Lines shape that `phoebe history --export` and the console's History tab
// both write, so the two produce the same file for the same records.
//
// A `.mjs` rather than a `.ts`, because the console loads it at runtime
// through `phoebe-agent/contracts`, whose `import` condition is index.mjs, and
// Node will not type-strip a `.ts` under node_modules. Both index.ts and
// index.mjs re-export this one file, so there is one implementation; the JSDoc
// is what types the re-export.
//
// CSV is one row per unit, its usage summed across its agent runs. A token
// count no run reported is an empty cell, never a 0. API spend and Claude's
// subscription estimate are separate columns and never added together: one is
// money a key was billed, the other a list price nobody paid. `detail` and
// `branch` stay out, since they hold free text; JSON Lines keeps every field,
// one full `HistoryRecord` per line.

/** @import { HistoryRecord } from "./history.ts" */

/**
 * The most records one history page holds; a larger limit is clamped to this.
 * Here rather than in src/history.ts, which re-exports it, because an export
 * asks for pages this size and the console has to know it at runtime.
 */
export const HISTORY_MAX_LIMIT = 200;

/** The formats an export writes. */
export const HISTORY_EXPORT_FORMATS = /** @type {const} */ (["csv", "jsonl"]);

/** @typedef {(typeof HISTORY_EXPORT_FORMATS)[number]} HistoryExportFormat */

/** The CSV header, in column order. */
export const HISTORY_CSV_COLUMNS = /** @type {const} */ ([
  "cell",
  "kind",
  "unit",
  "outcome",
  "quarantined",
  "started",
  "ended",
  "provider",
  "model",
  "agent_runs",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "partial_usage",
  "api_cost_usd",
  "estimated_cost_usd",
  "pr_link",
]);

/**
 * One CSV field, quoted when it holds a comma, a quote or a line break.
 * @param {string} value
 * @returns {string}
 */
function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * A sum over the runs that reported a figure, or `null` when none did.
 * @param {readonly (number | null)[]} values
 * @returns {number | null}
 */
function sumReported(values) {
  /** @type {number | null} */
  let total = null;
  for (const value of values) {
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

/**
 * A number as a cell: empty for `null`. Rounded to a millionth, so summed
 * floats read `0.3`, not `0.30000000000000004`.
 * @param {number | null} value
 * @returns {string}
 */
function numberCell(value) {
  return value === null ? "" : String(Math.round(value * 1e6) / 1e6);
}

/**
 * The unit's pull request on GitHub, or empty when it has none or its tenant
 * is not `owner/repo`.
 * @param {HistoryRecord} record
 * @returns {string}
 */
function prLink(record) {
  if (record.prNumber === null) return "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(record.tenant)) return "";
  return `https://github.com/${record.tenant}/pull/${record.prNumber}`;
}

/**
 * One unit's CSV fields, in {@link HISTORY_CSV_COLUMNS} order, unquoted.
 * @param {HistoryRecord} record
 * @returns {string[]}
 */
export function historyCsvFields(record) {
  const runs = record.agentRuns;
  const costOf = (/** @type {boolean} */ estimate) =>
    sumReported(
      runs
        .filter((run) => (run.costBasis === "subscription-estimate") === estimate)
        .map((run) => run.costUsd),
    );
  return [
    record.cell,
    record.unit.kind,
    record.unit.id,
    record.outcome,
    String(record.quarantined),
    record.startedAt,
    record.settledAt ?? "",
    record.provider ?? "",
    record.model ?? "",
    String(runs.length),
    numberCell(sumReported(runs.map((run) => run.inputTokens))),
    numberCell(sumReported(runs.map((run) => run.outputTokens))),
    numberCell(sumReported(runs.map((run) => run.cacheReadTokens))),
    numberCell(sumReported(runs.map((run) => run.cacheWriteTokens))),
    String(runs.some((run) => !run.usageComplete)),
    numberCell(costOf(false)),
    numberCell(costOf(true)),
    prLink(record),
  ];
}

/**
 * What an export file starts with: the header line for CSV, nothing for JSON Lines.
 * @param {HistoryExportFormat} format
 * @returns {string}
 */
export function historyExportHead(format) {
  return format === "csv" ? `${HISTORY_CSV_COLUMNS.join(",")}\n` : "";
}

/**
 * The lines for these records, each ending in a newline. Concatenate the head
 * and the lines of every page, in order, and the file is whole.
 * @param {HistoryExportFormat} format
 * @param {readonly HistoryRecord[]} records
 * @returns {string}
 */
export function historyExportLines(format, records) {
  let text = "";
  for (const record of records) {
    text +=
      format === "csv"
        ? `${historyCsvFields(record).map(csvField).join(",")}\n`
        : `${JSON.stringify(record)}\n`;
  }
  return text;
}
