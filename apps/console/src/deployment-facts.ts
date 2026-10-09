// One deployment, as the three tabs read it (#507 §2, §7, §8; #509 variant C).
//
// The fleet page counts; this page reads out. Same rule holds either way: the
// deployment derived every state and every `wedged?` verdict once and wrote them
// down (#501), and nothing here decides anything a report already answered. The
// one piece of arithmetic left is `k/N` — how many units a snapshot carries
// against the pipeline's declared concurrency — which is display detail, not a
// second opinion, and `phoebe status` does exactly the same (src/status.ts).
//
// The wording is deliberately `phoebe status`'s. An operator who reads one line
// in a terminal and the same line in a browser should not have to translate;
// two vocabularies for one fact is two facts as far as a reader is concerned.
//
// Pure, and apart from the components, so the tabs are a render of these values
// and the tests drive the values directly.

import type {
  ChildLiveness,
  DeploymentReport,
  FleetCell,
  TenantFacts,
} from "phoebe-agent/contracts";
import { age, duration, type RowFacts } from "./facts.ts";
import { cellsOf, childrenOf, tenantsOf } from "./report.ts";

/** One line of the pipelines tab: a cell, its child, and its tenant. */
export type PipelineRow = {
  /** `<tenantId>#<pipeline>`. */
  id: string;
  cell: FleetCell;
  /** The bootstrapper's child for this cell, or undefined when it supervises none. */
  child: ChildLiveness | undefined;
};

/** One tenant with its pipelines under it, in report order. */
export type TenantRow = {
  tenant: TenantFacts;
  pipelines: PipelineRow[];
};

/**
 * Every tenant the report lists, each with its own cells. Tenants come first and
 * cells hang off them, because a tenant held before its config was ever readable
 * fills no cell and is exactly the tenant an operator needs to see (#501).
 *
 * Unlike the fleet bar, this keeps the cells the fleet page drops: a `stale`
 * directory with no pipeline behind it is not a segment of the bar, but it is
 * something on this deployment's disk and the pipelines tab is where you would
 * go to find it.
 */
export function tenantRows(report: DeploymentReport): TenantRow[] {
  const children = childrenOf(report);
  const cells = allCells(report);
  return tenantsOf(report).map((tenant) => ({
    tenant,
    pipelines: cells
      .filter((cell) => cell.tenant?.id === tenant.id)
      .map((cell) => ({ id: cell.id, cell, child: children.get(cell.id) })),
  }));
}

/** The enumerated cells, in report order — the pipelines the overview lists. */
export function enumeratedRows(report: DeploymentReport): PipelineRow[] {
  const children = childrenOf(report);
  return cellsOf(report).map((cell) => ({ id: cell.id, cell, child: children.get(cell.id) }));
}

/**
 * The **process line**: is there a child for this pipeline, since when, and what
 * it has been doing to itself (#507 §2). A cell with no child entry is not
 * supervised by this bootstrapper at all, which is the honest thing to say about
 * a stale or on-disk cell rather than dressing it up as a stopped one.
 */
export function processLine(child: ChildLiveness | undefined, now: Date): string {
  if (child === undefined) return "not supervised";
  const parts: string[] = [];
  if (child.state === "exited") {
    const exit = child.lastExit;
    const how =
      exit === null
        ? "exited"
        : exit.signal !== null
          ? `exited on ${exit.signal}`
          : `exited (code ${exit.code ?? "unknown"})`;
    parts.push(`${how} ${age(child.since, now)} ago`);
  } else {
    // Still in this state, so the clock is a duration and not an "ago".
    parts.push(`${child.state} ${age(child.since, now)}`);
  }
  if (child.restarts > 0) {
    parts.push(`${child.restarts} restart${child.restarts === 1 ? "" : "s"}`);
  }
  if (child.crashLooping) parts.push("crash-looping");
  return parts.join(", ");
}

/**
 * The **state line**: what this pipeline's own snapshot last said, as the report
 * derived it. `working k/N` counts the snapshot's in-flight units against the
 * declared concurrency; every other state is one word, because it is.
 */
export function stateLine(cell: FleetCell): string {
  if (cell.state !== "working") return cell.state;
  const units = unitsOf(cell);
  return cell.concurrency !== null
    ? `working ${units.length}/${cell.concurrency}`
    : `working ${units.length}`;
}

/** One unit in flight, with how long it has been against the budget it was given. */
export type UnitLine = {
  /** `<kind> <id>` — the unit as its own events name it. */
  ref: string;
  /** How long it has been running. */
  running: string;
  /** Its whole-run budget, or null when the kind declares none. */
  budget: string | null;
  /** It has been running longer than the budget it was given. */
  overBudget: boolean;
};

/**
 * The units in flight, against their budgets. Oldest admission first, as the
 * snapshot writes them (#422).
 *
 * `overBudget` is not the `wedged?` verdict and must not be read as one: wedged
 * asks whether the *loop* should have reaped the unit, which is budget plus a
 * poll interval and is the deployment's call (#507 §2). This is the plain
 * comparison an operator would make by eye, and it is here so they do not have
 * to make it by eye.
 */
export function unitLines(cell: FleetCell, now: Date): UnitLine[] {
  return unitsOf(cell).map((unit) => {
    const started = Date.parse(unit.startedAt);
    const elapsed = Number.isNaN(started) ? null : Math.max(0, now.getTime() - started);
    return {
      ref: `${unit.unit.kind} ${unit.unit.id}`,
      running: age(unit.startedAt, now),
      budget: unit.runBudgetMs === null ? null : duration(unit.runBudgetMs),
      overBudget:
        elapsed !== null && unit.runBudgetMs !== null ? elapsed > unit.runBudgetMs : false,
    };
  });
}

/**
 * Why this pipeline is wedged, or null when it is not (#507 §2). The clause is
 * named, because the two mean different things to whoever goes and looks: a unit
 * past its budget is a unit to go and find, and no pass in three poll intervals
 * is a loop that has stopped turning.
 *
 * The pass clause quotes the silence the report stamped, never `lastPassAt` as
 * an age — between two reports that field is deliberately stale on a perfectly
 * healthy idle pipeline (#507 §3).
 */
export function wedgedLine(cell: FleetCell): string | null {
  if (cell.wedged?.wedged !== true) return null;
  return cell.wedged.reason === "unit-overdue"
    ? "wedged? a unit is past its budget"
    : `wedged? no pass for ${duration(cell.wedged.noPassForMs)}`;
}

/** The engine this deployment is running, and whether it is the one it wanted. */
export function engineLine(facts: RowFacts): string {
  const parts = [[facts.engineRef ?? "engine unset", facts.engineSha ?? "no sha"].join(" → ")];
  if (facts.quarantinedSha !== null) parts.push(`quarantined ${facts.quarantinedSha}`);
  return parts.join(" · ");
}

/** Reconcile in words: idle since, or relaunching and why (#501). */
export function reconcileLine(report: DeploymentReport, now: Date): string {
  const reconcile = report.bootstrapper?.reconcile;
  if (reconcile === undefined) return "unknown";
  return reconcile.phase === "reconciling"
    ? `reconciling (${reconcile.reason}) for ${age(reconcile.since, now)}`
    : `idle for ${age(reconcile.since, now)}`;
}

/**
 * The broker's numbers (#407): the cap, what is against it, and the over-cap
 * grants outstanding. `overGranted` is named only when it is not zero — the slot
 * floor's breach is bounded and rare, and a permanent "0 over cap" on screen
 * would teach an operator to stop reading the line.
 */
export function slotsLine(report: DeploymentReport): string {
  const slots = report.bootstrapper?.slots;
  if (slots === undefined) return "unknown";
  const parts = [`${slots.inUse}/${slots.capacity} in use`];
  if (slots.waiting > 0) parts.push(`${slots.waiting} waiting`);
  if (slots.overGranted > 0) parts.push(`${slots.overGranted} over cap`);
  return parts.join(", ");
}

/** The crash-loop guard's record, or null when it has nothing to report. */
export function crashLoopLine(report: DeploymentReport): string | null {
  const record = report.bootstrapper?.crashLoop;
  if (record === undefined || record.failingSha === null) return null;
  const times = record.failureCount === 1 ? "once" : `${record.failureCount} times`;
  const good = record.lastGoodSha === null ? "no known-good commit" : record.lastGoodSha;
  return `${record.failingSha} failed ${times}; running ${good}`;
}

/** Every cell, enumerated or not — the pipelines tab shows what is on disk too. */
function allCells(report: DeploymentReport): FleetCell[] {
  const fleet = report.fleet;
  if (fleet === undefined || !Array.isArray(fleet.cells)) return [];
  return fleet.cells.filter((cell): cell is FleetCell => typeof cell === "object" && cell !== null);
}

function unitsOf(cell: FleetCell): NonNullable<FleetCell["snapshot"]>["currentUnits"] {
  const units = cell.snapshot?.currentUnits;
  return Array.isArray(units) ? units : [];
}
