// Reading the report the relay carried but never opened.
//
// The relay stores and forwards `state/deployment.json` as an opaque body and
// hoists only its `schema` integer (relay-routes.ts, #542). So the console is the
// first thing in the chain to look inside, and it is looking at bytes written by
// a deployment that may be running a different engine than the relay or the
// console expects. Two consequences shape this module.
//
// **The schema decides, not the fields.** `schema` moves when a field's meaning
// changes in a way an older reader would misread (deployment.ts). A report
// stamped with a schema this console does not know is not read at all: the fleet
// page says so and shows the relay's own connection facts, which are never in the
// report. Guessing would be worse than a blank cell.
//
// **A known schema is still checked.** The body arrived from a process this one
// does not control, so every section is narrowed before it is indexed. Anything
// missing reads as absent rather than throwing — one malformed report must not
// take the fleet page down with it.
//
// One narrowing for both arms. The local read loop emits the same triple over
// the desktop bridge that the relay stores (`StoredReport`, #556), so a page
// reading a local install and a page reading a remote deployment reach the same
// verdicts about the same bytes.

import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts";
import type {
  ChildLiveness,
  DeploymentReport,
  FleetCell,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
