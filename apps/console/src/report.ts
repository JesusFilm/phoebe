// Reading the report a deployment wrote.
//
// The companion's read loop hands over `state/deployment.json` as an opaque body
// with its `schema` integer hoisted (#556). So the console is the first thing in
// the chain to look inside, and it is looking at bytes written by a deployment
// that may be running a different engine than this console expects. Two
// consequences shape this module.
//
// **The schema decides, not the fields.** `schema` moves when a field's meaning
// changes in a way an older reader would misread (deployment.ts). A report
// stamped with a schema this console does not know is not read at all. Guessing
// would be worse than a blank tab.
//
// **A known schema is still checked.** The body arrived from a process this one
// does not control, so every section is narrowed before it is indexed. Anything
// missing reads as absent rather than throwing.

import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts";
import type {
  ChildLiveness,
  DeploymentReport,
  FleetCell,
  HistorySummary,
  StoredReport,
  TenantFacts,
} from "phoebe-agent/contracts";

/**
 * What the console managed to make of one stored report. `kind` is the whole
 * story a cell needs: there is no report yet, there is one this console cannot
 * read, or there is one it can.
 */
export type ReportReading =
  | { kind: "none" }
  | { kind: "unreadable"; schema: number }
  | { kind: "read"; receivedAt: string; report: DeploymentReport };

/** Narrow one stored report, or say why not. */
export function readReport(stored: StoredReport | null): ReportReading {
  if (stored === null) return { kind: "none" };
  if (stored.schema !== DEPLOYMENT_SCHEMA) return { kind: "unreadable", schema: stored.schema };
  const body = stored.report;
  if (!isRecord(body)) return { kind: "unreadable", schema: stored.schema };
  return {
    kind: "read",
    receivedAt: stored.receivedAt,
    report: body as unknown as DeploymentReport,
  };
}

/** The engine ref, running SHA and quarantine, or null when there is no section. */
export function bootstrapperOf(report: DeploymentReport): DeploymentReport["bootstrapper"] | null {
  return isRecord(report.bootstrapper) ? report.bootstrapper : null;
}

/** Every enumerated tenant the report lists. */
export function tenantsOf(report: DeploymentReport): TenantFacts[] {
  const fleet = report.fleet;
  if (!isRecord(fleet) || !Array.isArray(fleet.tenants)) return [];
  return fleet.tenants.filter(isRecord) as TenantFacts[];
}

/**
 * The (tenant × pipeline) cells, which is what a bar segment is one of. Cells
 * whose pipeline was not enumerated are dropped: a stale `state/` directory with
 * no pipeline behind it is a doctor warning, not a segment of the fleet bar.
 */
export function cellsOf(report: DeploymentReport): FleetCell[] {
  const fleet = report.fleet;
  if (!isRecord(fleet) || !Array.isArray(fleet.cells)) return [];
  return (fleet.cells.filter(isRecord) as FleetCell[]).filter(
    (cell) => cell.source === "enumerated",
  );
}

/** Child liveness by cell id, so a cell's process line is one lookup away. */
export function childrenOf(report: DeploymentReport): Map<string, ChildLiveness> {
  const bootstrapper = bootstrapperOf(report);
  const children =
    bootstrapper !== null && Array.isArray(bootstrapper.children)
      ? (bootstrapper.children.filter(isRecord) as ChildLiveness[])
      : [];
  return new Map(children.map((child) => [child.id, child]));
}

/**
 * A unit history summary (#929): the fleet's total, or one cell's. Null when
 * the report has none, as one from a bootstrapper that predates the field does,
 * which says nothing about how many units ran.
 */
export function historyOf(of: { history?: unknown } | null | undefined): HistorySummary | null {
  const history = of?.history;
  if (!isRecord(history) || typeof history.asOf !== "string") return null;
  return isWindow(history.last24h) && isWindow(history.last7d)
    ? (history as unknown as HistorySummary)
    : null;
}

/** The fleet's unit history summed as one, or null when the report has none. */
export function fleetHistoryOf(report: DeploymentReport): HistorySummary | null {
  return isRecord(report.fleet) ? historyOf(report.fleet) : null;
}

function isWindow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.units === "number" &&
    isRecord(value.outcomes) &&
    isRecord(value.costUsd) &&
    isRecord(value.tokens)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
