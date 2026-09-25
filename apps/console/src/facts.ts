// The fleet row, as facts (#507 §9).
//
// "Rolls up facts, not a score" is the decision this module is: every number here
// is a count of something an operator can go and look at, and there is no health
// index, no weighting, and no "needs attention" word on screen. What the rollup
// does buy is the **sort** — dark first, then anything wedged or crash-looping,
// then by name — which is a reading order, not a ranking of severity.
//
// It is pure and lives apart from the components for the reason every derivation
// in Phoebe does: two readers of the same report must not be able to disagree
// about what it says. The deployment derives a pipeline's state and its `wedged?`
// verdict once and writes them down (#501); this file only counts them.

import type {
  ChildLiveness,
  DoctorAttempt,
  DoctorCheck,
  DoctorSection,
  DoctorTrigger,
  FleetCell,
  PipelineState,
  RelayDeploymentRow,
  RelayStoredReport,
  DeploymentIdentity,
  HostPlatform,
} from "phoebe-agent/contracts";
import {
  bootstrapperOf,
  cellsOf,
  childrenOf,
  doctorOf,
  readReport,
  tenantsOf,
  type ReportReading,
} from "./report.ts";

/**
 * Doctor, as the fleet row and the doctor tab both read it (#507 §7, §9).
 *
 * Counting is the only arithmetic. Every check already carries its own verdict,
 * and `ok` is the report's one derived answer; this tallies the four states so a
 * row can say "2 fail, 1 warn" without a second opinion about any of them.
 *
 * `report: null` is the console's **never**, and it covers two deployments that
 * look the same from here: one that has not run doctor yet, and one running an
 * engine older than the section itself. Neither of them is a pass.
 */
export type DoctorFacts = {
  /** The last report doctor produced, or null for never. */
  report: DoctorSection["report"];
  /** When that report was taken. Null alongside a null report. */
  at: string | null;
  /** Why that run happened. */
  trigger: DoctorTrigger | null;
  /** Who asked, when a person did. */
  by: string | null;
  fail: number;
  warn: number;
  unknown: number;
  /** A run in flight right now — shown instead of the age, not beside it. */
  running: { since: string; trigger: DoctorTrigger } | null;
  /** The last run that produced nothing. The report above is still the older one. */
  lastAttempt: DoctorAttempt | null;
};

/** Every check in a report, deployment-level and per-tenant, in one list. */
export function allChecks(section: DoctorFacts): DoctorCheck[] {
  if (section.report === null) return [];
  return [...section.report.checks, ...section.report.tenants.flatMap((row) => row.checks)];
}

/** Read the report's doctor section, or the "never" that stands in for it. */
export function doctorFacts(section: DoctorSection | null): DoctorFacts {
  const facts: DoctorFacts = {
    report: section?.report ?? null,
    at: section?.at ?? null,
    trigger: section?.trigger ?? null,
    by: section?.by ?? null,
    fail: 0,
    warn: 0,
    unknown: 0,
    running: section?.running ?? null,
    lastAttempt: section?.lastAttempt ?? null,
  };
  for (const check of allChecks(facts)) {
    if (check.state === "fail") facts.fail += 1;
    else if (check.state === "warn") facts.warn += 1;
    else if (check.state === "unknown") facts.unknown += 1;
  }
  return facts;
}

const NO_DOCTOR: DoctorFacts = doctorFacts(null);

/**
 * Doctor in one clause: what the last run found and how long ago, or that a run
 * is in flight, or that there has never been one (#507 §9). A run in flight
 * replaces the age rather than sitting beside it — an operator watching a run
 * wants to know it is moving, and the age it is about to replace is noise.
 *
 * "healthy" is the report's own `ok` restated: the absence of a fail and a warn,
 * not a verdict this file reached on its own.
 */
export function doctorLine(facts: DoctorFacts, now: Date): string {
  if (facts.running !== null) {
    return `doctor running ${age(facts.running.since, now)} (${facts.running.trigger})`;
  }
  if (facts.report === null || facts.at === null) return "doctor never run";
  const counted =
    facts.fail === 0 && facts.warn === 0 ? "healthy" : `${facts.fail} fail, ${facts.warn} warn`;
  const trigger = facts.trigger === null ? "" : ` (${facts.trigger})`;
  return `doctor ${counted} — ${age(facts.at, now)} ago${trigger}`;
}

/** One pipeline, flattened to what a bar segment and a tooltip need. */
export type PipelineFacts = {
  /** `<tenantId>#<pipeline>`. */
  id: string;
  /** The tenant's display path, for the tooltip. */
  tenant: string;
  pipeline: string;
  state: PipelineState;
  wedged: boolean;
  crashLooping: boolean;
  disabled: boolean;
};

/** Everything the rail's sub-line and one grid cell read off a deployment. */
export type RowFacts = {
  row: RelayDeploymentRow;
  reading: ReportReading;
  /** Enumerated pipelines, in report order. Empty when there is no readable report. */
  pipelines: PipelineFacts[];
  /** How many pipelines sit in each state. Absent states are absent, not zero. */
  counts: Partial<Record<PipelineState, number>>;
  wedged: number;
  crashLooping: number;
  /** Tenants discovery would skip now — they run nothing new (#501). */
  held: number;
  /** Where the deployment runs, when its bootstrapper says (contracts/deployment.ts). */
  host: HostPlatform | null;
  engineRef: string | null;
  engineSha: string | null;
  quarantinedSha: string | null;
  /** The reason the bootstrapper is relaunching the fleet, or null when it is not. */
  reconciling: "config" | "ref" | null;
  /** The last doctor run, counted. "Never" for a row with no readable report. */
  doctor: DoctorFacts;
  /**
   * Something on this row is worth walking over to: a wedged pipeline, a
   * crash-looping child, or a failing doctor check (#507 §9). Three counts of
   * three different things — still not a score, and still no word for it on
   * screen.
   */
  attention: boolean;
};

/** Roll one deployment up. */
export function rowFacts(row: RelayDeploymentRow, stored: RelayStoredReport | null): RowFacts {
  const reading = readReport(stored);
  if (reading.kind !== "read") {
    return {
      row,
      reading,
      pipelines: [],
      counts: {},
      wedged: 0,
      crashLooping: 0,
      held: 0,
      host: null,
      engineRef: null,
      engineSha: null,
      quarantinedSha: null,
      reconciling: null,
      doctor: NO_DOCTOR,
      attention: false,
    };
  }

  const children = childrenOf(reading.report);
  const pipelines = cellsOf(reading.report).map((cell) =>
    pipelineFacts(cell, children.get(cell.id)),
  );
  const counts: Partial<Record<PipelineState, number>> = {};
  for (const pipeline of pipelines) counts[pipeline.state] = (counts[pipeline.state] ?? 0) + 1;

  const bootstrapper = bootstrapperOf(reading.report);
  const reconcile = bootstrapper?.reconcile;
  const wedged = pipelines.filter((pipeline) => pipeline.wedged).length;
  const crashLooping = pipelines.filter((pipeline) => pipeline.crashLooping).length;
  const doctor = doctorFacts(doctorOf(reading.report));

  return {
    row,
    reading,
    pipelines,
    counts,
    wedged,
    crashLooping,
    held: tenantsOf(reading.report).filter((tenant) => tenant.held === true).length,
    // The identity section can be absent from a known-schema report, like any
    // other section (the test "sections missing… read as absent").
    host: (reading.report.identity as DeploymentIdentity | undefined)?.host ?? null,
    engineRef: bootstrapper?.engineRef ?? null,
    engineSha: bootstrapper?.engineSha ?? null,
    quarantinedSha: bootstrapper?.quarantinedSha ?? null,
    reconciling: reconcile?.phase === "reconciling" ? reconcile.reason : null,
    doctor,
    attention: wedged > 0 || crashLooping > 0 || doctor.fail > 0,
  };
}

/**
 * Reading order for the fleet: dark first, then anything wedged, crash-looping
 * or failing a doctor check, then by name (#507 §9). Fingerprint breaks a name
 * tie, because two links may carry one name — that is the whole point of the "replaced?"
 * flag (#505 §5) — and a list that reordered itself between two renders would
 * move the row under the pointer.
 */
export function sortFleet(facts: RowFacts[]): RowFacts[] {
  return [...facts].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.row.name.localeCompare(right.row.name) ||
      left.row.fingerprint.localeCompare(right.row.fingerprint),
  );
}

function rank(facts: RowFacts): number {
  if (facts.row.state === "dark") return 0;
  return facts.attention ? 1 : 2;
}

/**
 * The connection, in the four words the relay uses plus the duration each one
 * carries (#507 §1). `tone` is what the rail's dot and the cell's chip paint
 * themselves with; it is not a severity, it is which of the four words this is.
 *
 * `disconnected` is the one that reads as a duration rather than a state, so its
 * text carries the seconds the relay counted — "a fact, not a verdict".
 */
export type ConnectionTone = "connected" | "disconnected" | "dark" | "unseen";

export type ConnectionReading = {
  tone: ConnectionTone;
  /** The headline: `connected`, `disconnected 12 s`, `dark 2 d`, `unseen`. */
  text: string;
  /** The clause under it, or null when there is nothing more true to say. */
  detail: string | null;
  /** A newer link shares this dark one's name (#505 §5). */
  maybeReplaced: boolean;
};

export function connectionReading(row: RelayDeploymentRow, now: Date): ConnectionReading {
  const maybeReplaced = row.maybeReplaced;
  switch (row.state) {
    case "connected":
      return {
        tone: "connected",
        text: "connected",
        detail: row.connectedSince === null ? null : `since ${age(row.connectedSince, now)} ago`,
        maybeReplaced,
      };
    case "disconnected":
      return {
        tone: "disconnected",
        // The relay counts these seconds itself rather than leaving the console
        // to subtract two clocks it does not share.
        text: `disconnected ${duration((row.disconnectedForSeconds ?? 0) * 1000)}`,
        detail: closeDetail(row),
        maybeReplaced,
      };
    case "dark":
      return {
        tone: "dark",
        text: row.lastSeen === null ? "dark" : `dark ${age(row.lastSeen, now)}`,
        detail: closeDetail(row),
        maybeReplaced,
      };
    case "unseen":
      return {
        tone: "unseen",
        text: "unseen",
        // Not dark: nothing was lost, because nothing ever arrived. Saying when
        // the token was spent is what keeps the two apart on screen.
        detail: `paired ${age(row.firstSeen, now)} ago`,
        maybeReplaced,
      };
  }
}

function closeDetail(row: RelayDeploymentRow): string | null {
  if (row.lastClose === null) return null;
  const reason = row.lastClose.reason === "" ? "" : `: ${row.lastClose.reason}`;
  return `last close ${row.lastClose.code}${reason}`;
}

/**
 * An ISO instant as an age — `12 s`, `23 min`, `6 h`, `2 d`. Coarse on purpose:
 * the fleet page answers "is everything alive", and a second-precise age on a
 * row that has been dark for two days is noise that moves every render.
 */
export function age(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  return duration(Math.max(0, now.getTime() - then));
}

/**
 * A span in the same coarse words {@link age} prints, for the spans a report
 * hands over already measured — a wedged verdict's silence, a unit's budget.
 */
export function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function pipelineFacts(cell: FleetCell, child: ChildLiveness | undefined): PipelineFacts {
  return {
    id: cell.id,
    tenant: cell.tenant?.path ?? cell.tenant?.id ?? cell.id,
    pipeline: cell.pipeline,
    state: cell.state,
    wedged: cell.wedged?.wedged === true,
    crashLooping: child?.crashLooping === true,
    disabled: cell.disabled === true,
  };
}
