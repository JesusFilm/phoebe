// Unit history across every deployment the console knows (#933, decided in
// #918 and #919): the totals the rail's stats button shows on hover, and what
// the fleet stats page draws.
//
// Totals come from each deployment's report, which carries its history summary
// (#929). The console adds those summaries up and never recomputes one. A
// deployment whose report has no summary runs an engine from before unit
// history: it is listed as too old and left out of the totals, because
// counting it as zero would say it ran nothing.
//
// What a summary cannot answer — the most expensive units, the split by model,
// the units on each day — is read on demand: every record in the window, page
// by page, from each deployment that reports history.
//
// API spend and the subscription estimate stay apart everywhere here. One is
// money a key was billed, the other a list price nobody paid.

import type {
  HistoryRecord,
  HistoryWindow,
  LocalInstall,
  LocalReportEvent,
  RemoteRecord,
} from "phoebe-agent/contracts";
import { unitCost, unitTokens, type HistoryFetch, type HistoryReader } from "./history.ts";
import { hostnameOf } from "./reachability.ts";
import { readReport } from "./report.ts";

/** The two windows every summary carries. */
export type StatsRange = "last24h" | "last7d";

export const RANGE_MS: Record<StatsRange, number> = {
  last24h: 24 * 60 * 60 * 1000,
  last7d: 7 * 24 * 60 * 60 * 1000,
};

/** Where one deployment is reached from this console. */
export type StatsArm = { kind: "local"; dir: string } | { kind: "remote"; deploymentId: string };

/** What one deployment's report says about its unit history. */
export type StatsHistory =
  | { kind: "summary"; windows: Record<StatsRange, HistoryWindow>; asOf: string }
  /** A report this console reads, from an engine that predates unit history. */
  | { kind: "too-old" }
  /** No report this console can read, so nothing is known either way. */
  | { kind: "unknown"; why: string };

/** One deployment as the stats see it. */
export type StatsDeployment = {
  /** Stable across renders: the arm and its key. */
  key: string;
  name: string;
  /** Where it runs, for the line under its name. */
  where: string;
  arm: StatsArm;
  history: StatsHistory;
};

/**
 * Every deployment the console knows, locals first. A paired record whose
 * deployment is also a folder here is the same deployment, so it is listed
 * once, as the folder.
 */
export function statsDeployments(
  installs: readonly LocalInstall[],
  reports: Readonly<Record<string, LocalReportEvent>>,
  remotes: readonly RemoteRecord[],
  joined: Readonly<Record<string, unknown>> = {},
): StatsDeployment[] {
  const locals = installs.map((install): StatsDeployment => {
    const event = reports[install.dir] ?? null;
    return {
      key: `local:${install.dir}`,
      name: install.name,
      where: install.wsl === undefined ? "this machine" : "this machine (WSL)",
      arm: { kind: "local", dir: install.dir },
      history:
        event === null
          ? { kind: "unknown", why: "no report read yet" }
          : historyOf(event.report, event.reason ?? "not running, so no report"),
    };
  });
  const paired = remotes
    .filter((record) => joined[record.deploymentId] === undefined)
    .map((record): StatsDeployment => ({
      key: `remote:${record.deploymentId}`,
      name: record.name,
      where: hostnameOf(record.url),
      arm: { kind: "remote", deploymentId: record.deploymentId },
      history: historyOf(record.lastReport, "nothing heard from it yet"),
    }));
  return [...locals, ...paired];
}

function historyOf(stored: LocalReportEvent["report"], absent: string): StatsHistory {
  const reading = readReport(stored);
  if (reading.kind === "none") return { kind: "unknown", why: absent };
  if (reading.kind === "unreadable") {
    return {
      kind: "unknown",
      why: `report schema ${reading.schema}, which this console cannot read`,
    };
  }
  const fleet = reading.report.fleet as { history?: unknown } | undefined;
  const summary = fleet?.history;
  if (!isSummary(summary)) return { kind: "too-old" };
  return {
    kind: "summary",
    windows: { last24h: summary.last24h, last7d: summary.last7d },
    asOf: summary.asOf,
  };
}

function isSummary(
  value: unknown,
): value is { asOf: string; last24h: HistoryWindow; last7d: HistoryWindow } {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.asOf === "string" && isWindow(summary.last24h) && isWindow(summary.last7d);
}

function isWindow(value: unknown): value is HistoryWindow {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Record<string, unknown>;
  return (
    typeof window.units === "number" &&
    typeof window.outcomes === "object" &&
    window.outcomes !== null &&
    typeof window.costUsd === "object" &&
    window.costUsd !== null &&
    typeof window.tokens === "object" &&
    window.tokens !== null
  );
}

/** One window's units that did not complete: failed, timed out or abandoned. */
export function didNotComplete(window: Pick<HistoryWindow, "outcomes">): number {
  return window.outcomes.failed + window.outcomes["timed-out"] + window.outcomes.abandoned;
}

/** The fleet's totals over one window, and which deployments they leave out. */
export type FleetTotals = {
  window: HistoryWindow;
  /** Deployments whose summary is in the totals. */
  counted: number;
  /** Deployments listed but left out: too old, or no report to read. */
  tooOld: number;
  unknown: number;
};

/** Every reporting deployment's summary for one window, added up count by count. */
export function fleetTotals(
  deployments: readonly StatsDeployment[],
  range: StatsRange,
): FleetTotals {
  const total: HistoryWindow = {
    units: 0,
    outcomes: { completed: 0, failed: 0, "timed-out": 0, abandoned: 0 },
    quarantined: 0,
    costUsd: { api: 0, subscriptionEstimate: 0 },
    unitsWithoutCost: 0,
    unitsWithPartialUsage: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let counted = 0;
  let tooOld = 0;
  let unknown = 0;
  for (const deployment of deployments) {
    if (deployment.history.kind === "too-old") tooOld += 1;
    if (deployment.history.kind === "unknown") unknown += 1;
    if (deployment.history.kind !== "summary") continue;
    counted += 1;
    const window = deployment.history.windows[range];
    total.units += window.units;
    for (const outcome of Object.keys(total.outcomes) as (keyof HistoryWindow["outcomes"])[]) {
      total.outcomes[outcome] += window.outcomes[outcome] ?? 0;
    }
    total.quarantined += window.quarantined ?? 0;
    total.costUsd.api += window.costUsd.api ?? 0;
    total.costUsd.subscriptionEstimate += window.costUsd.subscriptionEstimate ?? 0;
    total.unitsWithoutCost += window.unitsWithoutCost ?? 0;
    total.unitsWithPartialUsage += window.unitsWithPartialUsage ?? 0;
    total.tokens.input += window.tokens.input ?? 0;
    total.tokens.output += window.tokens.output ?? 0;
    total.tokens.cacheRead += window.tokens.cacheRead ?? 0;
    total.tokens.cacheWrite += window.tokens.cacheWrite ?? 0;
  }
  return { window: total, counted, tooOld, unknown };
}

/** The line a deployment left out of the totals reads as. */
export function leftOutNote(history: Exclude<StatsHistory, { kind: "summary" }>): string {
  return history.kind === "too-old"
    ? "too old to report history, so not counted"
    : `not counted: ${history.why}`;
}

// ───────────────────────── records, on demand ─────────────────────────

/** The most records read from one deployment for one window. */
export const RECORD_CAP = 1000;

/** The largest page the history read serves. */
const PAGE_LIMIT = 200;

/** What reading one deployment's window came to. */
export type WindowRead =
  | {
      kind: "records";
      records: HistoryRecord[];
      /** True when the deployment held more than {@link RECORD_CAP} and the rest went unread. */
      capped: boolean;
    }
  | { kind: "too-old" };

/** Every record that started inside the window, newest first, page after page. */
export async function readWindow(
  reader: HistoryReader,
  since: string,
  cap = RECORD_CAP,
): Promise<WindowRead> {
  const records: HistoryRecord[] = [];
  let before: string | undefined;
  for (;;) {
    const fetched: HistoryFetch = await reader({
      since,
      limit: Math.min(PAGE_LIMIT, cap - records.length),
      ...(before === undefined ? {} : { before }),
    });
    if (fetched.kind === "too-old") return { kind: "too-old" };
    records.push(...fetched.page.records);
    if (fetched.page.nextBefore === null) return { kind: "records", records, capped: false };
    if (records.length >= cap) return { kind: "records", records, capped: true };
    before = fetched.page.nextBefore;
  }
}

/**
 * What a unit is ranked by when ranking the most expensive: its dollar figure.
 * A unit's runs share one provider, so it has one basis; on the rare unit with
 * both, the larger figure ranks it, and the two are still never summed.
 */
export function rankingCost(record: HistoryRecord): number | null {
  const cost = unitCost(record);
  if (cost.kind === "none") return null;
  return Math.max(cost.api ?? 0, cost.estimate ?? 0);
}

/** The `count` units with the largest cost, largest first. Units with no cost are not ranked. */
export function priciest(records: readonly HistoryRecord[], count = 5): HistoryRecord[] {
  return records
    .flatMap((record) => {
      const cost = rankingCost(record);
      return cost === null ? [] : [{ record, cost }];
    })
    .sort((a, b) => b.cost - a.cost || b.record.startedAt.localeCompare(a.record.startedAt))
    .slice(0, count)
    .map((entry) => entry.record);
}

/** One model's units, counted and summed. */
export type ModelRow = {
  /** Null for units that never named a model. */
  model: string | null;
  units: number;
  didNotComplete: number;
  api: number;
  estimate: number;
  /** Units none of whose runs reported a cost. */
  withoutCost: number;
  input: number;
  output: number;
};

/** The records split by model, most units first. */
export function byModel(records: readonly HistoryRecord[]): ModelRow[] {
  const rows = new Map<string | null, ModelRow>();
  for (const record of records) {
    const row = rows.get(record.model) ?? {
      model: record.model,
      units: 0,
      didNotComplete: 0,
      api: 0,
      estimate: 0,
      withoutCost: 0,
      input: 0,
      output: 0,
    };
    row.units += 1;
    if (record.outcome !== "completed") row.didNotComplete += 1;
    const cost = unitCost(record);
    if (cost.kind === "none") row.withoutCost += 1;
    else {
      row.api += cost.api ?? 0;
      row.estimate += cost.estimate ?? 0;
    }
    const tokens = unitTokens(record);
    row.input += tokens.input ?? 0;
    row.output += tokens.output ?? 0;
    rows.set(record.model, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.units - a.units || (a.model ?? "").localeCompare(b.model ?? ""),
  );
}

/** One calendar day's units, split into those that completed and those that did not. */
export type DayCount = {
  /** Local midnight that starts the day, ISO. */
  day: string;
  completed: number;
  didNotComplete: number;
};

/** The units started on each of the last `days` local days, oldest first, today last. */
export function unitsPerDay(records: readonly HistoryRecord[], now: Date, days = 7): DayCount[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const counts: DayCount[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const start = new Date(today);
    start.setDate(today.getDate() - back);
    counts.push({ day: start.toISOString(), completed: 0, didNotComplete: 0 });
  }
  const starts = counts.map((count) => Date.parse(count.day));
  for (const record of records) {
    const at = Date.parse(record.startedAt);
    if (!Number.isFinite(at) || at < starts[0]!) continue;
    let index = starts.length - 1;
    while (index > 0 && at < starts[index]!) index -= 1;
    const count = counts[index]!;
    if (record.outcome === "completed") count.completed += 1;
    else count.didNotComplete += 1;
  }
  return counts;
}
