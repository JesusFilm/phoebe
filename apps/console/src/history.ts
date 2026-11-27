// Unit history as the History tab reads it (#931, decided in #918 and #919).
//
// Arm-neutral, like tabs.ts. A deployment page hands the tab one
// `HistoryReader`; a local install's asks the companion to exec `phoebe
// history --json` in its container, and a remote's asks `GET /api/history`.
// Both answer the same `HistoryPage` (#930), and both say "too old" the same
// way, so the tab never knows which arm it is drawing.
//
// Every filter goes into the query. The tab never narrows a page it already
// holds, because a page is the newest fifty of what matched and narrowing it
// would hide every older unit the filter should have found.
//
// The rest is how one record reads: its cost, its tokens, its GitHub link.
// Cost follows #919: dollars for API spend, dollars and "est." for Claude's
// subscription estimate, a dash when nothing was reported, each with a line
// that says which it is. API spend and an estimate are never added together.

import type {
  AgentRunRecord,
  DesktopBridge,
  HistoryExportFormat,
  HistoryPage,
  HistoryQuery,
  HistoryRecord,
  UnitRecordOutcome,
} from "phoebe-agent/contracts";
import {
  HISTORY_MAX_LIMIT,
  historyExportHead,
  historyExportLines,
  REMOTE_ROUTES,
} from "phoebe-agent/contracts";

/** What one ask for a page came to. */
export type HistoryFetch =
  | { kind: "page"; page: HistoryPage }
  /** The deployment's engine predates unit history, so it has none to give. */
  | { kind: "too-old" };

/** How a deployment page reads its history. Rejects when the deployment could not be asked. */
export type HistoryReader = (query: HistoryQuery) => Promise<HistoryFetch>;

/** A local install's reader: one exec in its container per page. */
export function localHistory(bridge: DesktopBridge, dir: string): HistoryReader {
  return async (query) => {
    const page = await bridge.installs.history(dir, query);
    return page === null ? { kind: "too-old" } : { kind: "page", page };
  };
}

/** `/api/history` with the query in its query string. */
export function historyPath(query: HistoryQuery): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const search = params.toString();
  return search.length === 0 ? REMOTE_ROUTES.history : `${REMOTE_ROUTES.history}?${search}`;
}

/** Every outcome a record can carry, in the order the filter lists them. */
export const HISTORY_OUTCOMES: readonly UnitRecordOutcome[] = [
  "completed",
  "failed",
  "timed-out",
  "abandoned",
];

/** What the tab's four selects hold. An absent field is "every". */
export type HistoryFilters = {
  cell?: string;
  kind?: string;
  outcome?: UnitRecordOutcome;
  model?: string;
};

/** The query for the filters, and for the page after `before` when there is one. */
export function historyQueryOf(filters: HistoryFilters, before?: string): HistoryQuery {
  const query: HistoryQuery = {};
  if (filters.cell !== undefined) query.cell = filters.cell;
  if (filters.kind !== undefined) query.kind = filters.kind;
  if (filters.outcome !== undefined) query.outcome = filters.outcome;
  if (filters.model !== undefined) query.model = filters.model;
  if (before !== undefined) query.before = before;
  return query;
}

/** The kinds and models a select offers, sorted. */
export type FilterChoices = { kinds: string[]; models: string[] };

export const NO_CHOICES: FilterChoices = { kinds: [], models: [] };

/**
 * The choices with every kind and model on these records added. Nothing in
 * the report lists them, so the selects offer what the pages so far have
 * shown, and keep it when a filter replaces the page it came from.
 */
export function withChoicesOf(
  choices: FilterChoices,
  records: readonly HistoryRecord[],
): FilterChoices {
  const kinds = new Set(choices.kinds);
  const models = new Set(choices.models);
  for (const record of records) {
    kinds.add(record.unit.kind);
    if (record.model !== null) models.add(record.model);
  }
  return { kinds: [...kinds].sort(), models: [...models].sort() };
}

/** The choices with the selected kind and model in them, so a select never loses its own value. */
export function filterChoices(choices: FilterChoices, filters: HistoryFilters): FilterChoices {
  const kinds = new Set(choices.kinds);
  const models = new Set(choices.models);
  if (filters.kind !== undefined) kinds.add(filters.kind);
  if (filters.model !== undefined) models.add(filters.model);
  return { kinds: [...kinds].sort(), models: [...models].sort() };
}

// ───────────────────────────── export ─────────────────────────────

/** The export formats, as the tab's choice names them. */
export const EXPORT_FORMATS: readonly { format: HistoryExportFormat; label: string }[] = [
  { format: "csv", label: "CSV" },
  { format: "jsonl", label: "JSON Lines" },
];

/** A file an export hands to whatever saves it. */
export type ExportFile = { name: string; type: string; text: string };

/** How the tab saves a file: the browser's download, unless a test hands its own. */
export type SaveFile = (file: ExportFile) => void;

/**
 * Every record the filters match, as one file in `format`: the pages walked
 * from the newest until the cursor runs out, not just the ones the tab has
 * drawn. The mapping is the contracts' (#992), so the file matches what
 * `phoebe history --export` writes. `progress` hears the count after each
 * page, with the total the filters match. Rejects when a page could not be
 * read, so a part of the history never saves as if it were all of it.
 */
export async function exportHistory(
  reader: HistoryReader,
  filters: HistoryFilters,
  format: HistoryExportFormat,
  progress?: (written: number, total: number) => void,
): Promise<{ text: string; count: number }> {
  const parts = [historyExportHead(format)];
  let count = 0;
  let before: string | undefined;
  for (;;) {
    const fetched = await reader({ ...historyQueryOf(filters, before), limit: HISTORY_MAX_LIMIT });
    if (fetched.kind === "too-old") {
      throw new Error("this deployment is too old to keep unit history");
    }
    const { records, nextBefore, summary } = fetched.page;
    parts.push(historyExportLines(format, records));
    count += records.length;
    progress?.(count, summary.units);
    if (nextBefore === null || records.length === 0) return { text: parts.join(""), count };
    before = nextBefore;
  }
}

/** `phoebe-history-2026-11-27.csv`: the day it was saved, and the format's own extension. */
export function exportFileOf(format: HistoryExportFormat, text: string, at: Date): ExportFile {
  const day = at.toISOString().slice(0, 10);
  return format === "csv"
    ? { name: `phoebe-history-${day}.csv`, type: "text/csv", text }
    : { name: `phoebe-history-${day}.jsonl`, type: "application/x-ndjson", text };
}

/** Save through a download: the companion asks where, a browser saves to its folder. */
export const downloadFile: SaveFile = (file) => {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

// ───────────────────────────── one record ─────────────────────────────

/** How a cost reads: the figures by basis, or why there is none. */
export type CostView =
  | { kind: "cost"; api: number | null; estimate: number | null }
  | { kind: "none"; why: string };

/** The line under an API figure. */
export const API_COST_NOTE = "API spend, billed to the key the agent ran with.";

/** The line under a subscription estimate. */
export const ESTIMATE_NOTE =
  "Claude's list-price estimate. A subscription paid for this run, so nobody was billed this amount.";

function costOfRuns(runs: readonly AgentRunRecord[], provider: string | null): CostView {
  let api: number | null = null;
  let estimate: number | null = null;
  for (const run of runs) {
    if (run.costUsd === null) continue;
    if (run.costBasis === "subscription-estimate") estimate = (estimate ?? 0) + run.costUsd;
    else api = (api ?? 0) + run.costUsd;
  }
  if (api !== null || estimate !== null) return { kind: "cost", api, estimate };
  if (runs.length === 0) return { kind: "none", why: "No agent ran for this unit." };
  return {
    kind: "none",
    why: `${provider ?? "The provider"} reports tokens but no cost.`,
  };
}

/** A unit's cost across its agent runs. */
export function unitCost(record: HistoryRecord): CostView {
  return costOfRuns(record.agentRuns, record.provider);
}

/** One agent run's cost. */
export function runCost(record: HistoryRecord, run: AgentRunRecord): CostView {
  return costOfRuns([run], record.provider);
}

/** `$0.42`. A cost under a cent reads as one, so a real figure never reads as `$0.00`. */
export function usd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

/** `950`, `12.3k`, `4.5M`; a dash when the provider said nothing. */
export function compactCount(n: number | null): string {
  if (n === null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A unit's tokens: each side summed over the runs that reported it, `null` when none did. */
export function unitTokens(record: HistoryRecord): {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** At least one run's usage is a lower bound. */
  partial: boolean;
} {
  const sum = (pick: (run: AgentRunRecord) => number | null): number | null => {
    let total: number | null = null;
    for (const run of record.agentRuns) {
      const value = pick(run);
      if (value !== null) total = (total ?? 0) + value;
    }
    return total;
  };
  return {
    input: sum((run) => run.inputTokens),
    output: sum((run) => run.outputTokens),
    cacheRead: sum((run) => run.cacheReadTokens),
    cacheWrite: sum((run) => run.cacheWriteTokens),
    partial: record.agentRuns.some((run) => !run.usageComplete),
  };
}

/** The issue or PR number a unit id names: `issue:88`, `pr:21`, or a bare `88`. */
function numberedRef(id: string): { type: "issue" | "pr" | null; number: number } | null {
  const match = /^(?:(issue|pr):)?(\d+)$/.exec(id);
  if (match === null) return null;
  return { type: (match[1] as "issue" | "pr" | undefined) ?? null, number: Number(match[2]) };
}

/** The unit as a person names it: `issue #88`, `PR #21`, or its id as it stands. */
export function unitLabel(record: HistoryRecord): string {
  const ref = numberedRef(record.unit.id);
  if (ref === null) return record.unit.id;
  if (ref.type === "pr") return `PR #${ref.number}`;
  if (ref.type === "issue") return `issue #${ref.number}`;
  return `#${ref.number}`;
}

/**
 * The unit's page on GitHub: its PR when it has one, else what its id names.
 * A bare number goes to `/issues/`, which GitHub redirects for a PR. Null for
 * a unit whose id names neither, or a tenant that is not `owner/repo`.
 */
export function githubHref(record: HistoryRecord): string | null {
  const repo = repoOf(record);
  if (repo === null) return null;
  const base = `https://github.com/${repo}`;
  if (record.prNumber !== null) return `${base}/pull/${record.prNumber}`;
  const ref = numberedRef(record.unit.id);
  if (ref === null) return null;
  return `${base}/${ref.type === "pr" ? "pull" : "issues"}/${ref.number}`;
}

/** The record's tenant when it is `owner/repo`, the repo its links point into; else null. */
export function repoOf(record: HistoryRecord): string | null {
  return /^[^/\s]+\/[^/\s]+$/.test(record.tenant) ? record.tenant : null;
}

/** A stable key for one record: a unit runs more than once, so its start is part of it. */
export function recordKey(record: HistoryRecord): string {
  return `${record.cell}|${record.unit.kind}|${record.unit.id}|${record.startedAt}`;
}

/**
 * How far back the matched history reaches: the oldest `startedAt` any cell
 * still holds, or null when none holds any.
 */
export function retainedSince(page: Pick<HistoryPage, "retained">): string | null {
  let oldest: string | null = null;
  for (const since of Object.values(page.retained)) {
    if (since !== null && (oldest === null || since < oldest)) oldest = since;
  }
  return oldest;
}

// ───────────────────────────── summaries ─────────────────────────────

/** Units that did not complete: failed, timed out or abandoned. */
export function unfinishedOf(outcomes: Record<UnitRecordOutcome, number>): number {
  return outcomes.failed + outcomes["timed-out"] + outcomes.abandoned;
}

/** The part of a summary window or a page's totals a cost reads off. */
type Summed = {
  units: number;
  unitsWithoutCost: number;
  costUsd: { api: number; subscriptionEstimate: number };
};

/**
 * How a summed cost reads (#919): the figures by basis; "tokens only" when
 * units ran and none of them reported a cost (a reported zero is a cost); nothing when no unit ran.
 */
export type SummaryCostView =
  | { kind: "cost"; api: number | null; estimate: number | null }
  | { kind: "tokens-only" }
  | { kind: "no-units" };

export function summaryCost(summed: Summed): SummaryCostView {
  if (summed.units === 0) return { kind: "no-units" };
  const { api, subscriptionEstimate } = summed.costUsd;
  if (summed.unitsWithoutCost >= summed.units) return { kind: "tokens-only" };
  return {
    kind: "cost",
    api: api > 0 || subscriptionEstimate <= 0 ? api : null,
    estimate: subscriptionEstimate > 0 ? subscriptionEstimate : null,
  };
}

/** The line under "tokens only". */
export const TOKENS_ONLY_NOTE = "None of these units reported a cost. Their tokens are counted.";

// ───────────────────────────── needs a look ─────────────────────────────

/** The outcomes the overview's "Needs a look" feed lists. */
export const NOT_COMPLETED: readonly UnitRecordOutcome[] = ["failed", "timed-out", "abandoned"];

/** How many units the feed lists at most. */
export const FEED_SIZE = 6;

/** What the feed's reads came to. */
export type NeedsALookFetch =
  | {
      kind: "units";
      /** The newest units that did not complete, at most {@link FEED_SIZE}. */
      records: HistoryRecord[];
      /** Every unit since then that did not complete, listed or not. */
      total: number;
    }
  | { kind: "too-old" };

/**
 * The newest units since `since` that did not complete. One read per outcome,
 * since a query takes one, each capped at the feed's size: the newest six of
 * the three together are among the newest six of each. The total is the three
 * pages' own totals, so "more in the History tab" counts what the deployment
 * holds, not what came back.
 */
export async function readNeedsALook(
  reader: HistoryReader,
  since: string,
): Promise<NeedsALookFetch> {
  const fetched = await Promise.all(
    NOT_COMPLETED.map((outcome) => reader({ outcome, since, limit: FEED_SIZE })),
  );
  const pages: HistoryPage[] = [];
  for (const one of fetched) {
    if (one.kind === "too-old") return { kind: "too-old" };
    pages.push(one.page);
  }
  const records = pages
    .flatMap((page) => page.records)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, FEED_SIZE);
  const total = pages.reduce((sum, page) => sum + page.summary.units, 0);
  return { kind: "units", records, total };
}
