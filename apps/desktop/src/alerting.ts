// What main knows about alerts (#524, map #497).
//
// Two arms end here for two different reasons. The relay's alerts are already
// decided by the time main sees them — the relay ran the edge rule over the
// links it holds and sent what crossed, and main only passes them on. A local
// install has no relay, so main runs the same rule itself, over the report the
// read loop just finished (#556). One rule for both, imported from
// `phoebe-agent/contracts`, which is the whole point of that file being pure
// (#524 §3): a notification and a webhook can never disagree about whether
// something is wrong.
//
// **The first read of an install seeds and says nothing** (#524 §3). A
// companion that relaunches onto a fleet that was already wedged must not
// re-fire everything; the seeding read records what it found as already
// notified, so the next read only produces what has moved since. That mirrors
// the relay's own `alerts.json`, which exists for the same restart (#515 §5).
//
// **The raised set is per subject, not per edge.** The badge is the count of
// deployments and local installs in any raised condition (#524 §4), so what is
// kept here is a set of condition keys per subject and what is answered is how
// many of those sets are non-empty. Three wedged pipelines on one deployment are
// one badge.
//
// Nothing here touches Electron, and nothing here shows anything. Raising the
// notification is the renderer's (#524 §2); setting the badge is main's, from
// the count this answers.

import { DEPLOYMENT_SCHEMA, RELAY_EVENTS } from "phoebe-agent/contracts";
import type {
  AlertBody,
  AlertMessage,
  ChildLiveness,
  DeploymentReport,
  FleetCell,
  LocalAlertEvent,
  LocalReportEvent,
  NotifiedAlerts,
  PipelineAlertFacts,
  ReportAlertFacts,
} from "phoebe-agent/contracts";
// The rule and its sentence, from the file itself rather than from the
// package's entry. `index.mjs` is mirrored by hand and deliberately does not
// carry these: a hand-written copy of the edge rule is the one thing #524 §3
// exists to prevent, so both readers import this module directly.
import { alertEdges, alertText, ALERT_SCHEMA } from "../../../src/contracts/alerts.ts";

/** Where the `url` on a local install's alert points: this companion's own page. */
export const COMPANION_ORIGIN = "phoebe://console";

export type CompanionAlertsOptions = {
  /** Injected so a test does not race a clock. */
  clock?: () => Date;
};

export type CompanionAlerts = {
  /**
   * One finished local read. Returns the alerts to raise — empty on the read
   * that seeded this install, and empty on every read where nothing moved,
   * which is almost all of them.
   */
  local: (event: LocalReportEvent) => LocalAlertEvent[];
  /**
   * One alert off the relay's stream. Main forwards it to the window either
   * way; what this does is keep the badge's half of the picture, because the
   * renderer cannot set a badge and main is not the one drawing the alert.
   */
  relay: (body: AlertBody) => void;
  /** Forget one install: a removed folder must not leave a count behind. */
  forgetInstall: (dir: string) => void;
  /** Drop everything the relay contributed. What signing out means for a badge. */
  forgetRelay: () => void;
  /** Deployments and local installs in any raised condition (#524 §4). */
  badge: () => number;
};

/** The state one subject accumulates. Two maps, so signing out drops one. */
type Raised = Map<string, Set<string>>;

export function createCompanionAlerts(options: CompanionAlertsOptions = {}): CompanionAlerts {
  const clock = options.clock ?? (() => new Date());
  /** Last notified per install, keyed by directory — the local `alerts.json`. */
  const notified = new Map<string, NotifiedAlerts>();
  const raisedLocal: Raised = new Map();
  const raisedRelay: Raised = new Map();

  return {
    local(event) {
      const seeding = !notified.has(event.install);
      const held = notified.get(event.install) ?? {};
      const at = clock().toISOString();
      const edges = alertEdges({
        facts: {
          fingerprint: event.install,
          name: event.facts.name,
          // Null is the local arm's whole difference (#524 §3): no socket, so
          // no darkness to observe and no link to have been replaced.
          connection: null,
          quietForMs: null,
          quietSince: null,
          maybeReplaced: false,
          report: reportAlertFacts(event),
        },
        notified: held,
        now: at,
      });
      for (const edge of edges) {
        held[edge.key] = { state: edge.state, at, since: edge.since };
        mark(raisedLocal, event.install, edge.key, edge.state);
      }
      notified.set(event.install, held);
      if (seeding) return [];
      return edges.map((edge) => ({
        type: RELAY_EVENTS.alert,
        install: event.install,
        at,
        alert: {
          schema: ALERT_SCHEMA,
          kind: "alert",
          condition: edge.condition,
          state: edge.state,
          deployment: { name: event.facts.name, keyFingerprint: event.install },
          ...(edge.pipeline !== null ? { pipeline: edge.pipeline } : {}),
          since: edge.since,
          detail: edge.detail,
          text: alertText({ name: event.facts.name, edge }),
          url: `${COMPANION_ORIGIN}/#/d/${encodeURIComponent(event.install)}`,
        } satisfies AlertMessage,
      }));
    },

    relay(body) {
      // The test button's probe is a message about the relay, not about any
      // deployment, so it raises nothing and clears nothing.
      if (body.kind !== "alert") return;
      const key =
        body.pipeline === undefined ? body.condition : `${body.condition}:${body.pipeline}`;
      mark(raisedRelay, body.deployment.keyFingerprint, key, body.state);
    },

    forgetInstall(dir) {
      notified.delete(dir);
      raisedLocal.delete(dir);
    },

    forgetRelay: () => raisedRelay.clear(),

    badge: () => raisedLocal.size + raisedRelay.size,
  };
}

/** Record or drop one condition, and drop the subject once nothing is left. */
function mark(raised: Raised, subject: string, key: string, state: "raised" | "cleared"): void {
  const conditions = raised.get(subject) ?? new Set<string>();
  if (state === "raised") conditions.add(key);
  else conditions.delete(key);
  if (conditions.size === 0) raised.delete(subject);
  else raised.set(subject, conditions);
}

/**
 * One local read, projected onto what the edge rule reads — or null when there
 * is nothing to read, which leaves all three conditions exactly where they were.
 *
 * A report stamped with a schema this build does not know is the same answer as
 * no report. Guessing at fields whose meaning moved is how a companion ends up
 * waking someone at 3 a.m. about a pipeline that is fine.
 */
export function reportAlertFacts(event: LocalReportEvent): ReportAlertFacts | null {
  const stored = event.report;
  if (stored === null || stored.schema !== DEPLOYMENT_SCHEMA) return null;
  const body = stored.report;
  if (!isRecord(body)) return null;
  const report = body as unknown as DeploymentReport;

  const children = new Map<string, ChildLiveness>(
    childrenOf(report).map((child) => [child.id, child]),
  );

  return {
    at: stored.receivedAt,
    // The report carries no doctor section yet (#534 lands it). `unknown` is
    // the word the rule has for "we could not ask", and it neither raises nor
    // clears — which is the only honest reading of a section that is not there.
    doctor: "unknown",
    doctorDetail: "",
    pipelines: cellsOf(report).map((cell) => pipelineAlertFacts(cell, children.get(cell.id))),
  };
}

/** One cell and its child, in the vocabulary the rule reads. */
function pipelineAlertFacts(cell: FleetCell, child: ChildLiveness | undefined): PipelineAlertFacts {
  const wedged = cell.wedged?.wedged === true;
  const crashLooping = child?.crashLooping === true;
  return {
    // `acme-site/sentry`, the name #515 §9's own example uses — the tenant's
    // display path and the pipeline within it, not the `<tenantId>#<pipeline>`
    // key the report indexes by. It is what a person reads in the banner and
    // what the notified state is keyed on, so it has to be the readable one.
    pipeline: pipelineName(cell),
    wedged,
    wedgedDetail: wedged ? wedgedDetail(cell) : "",
    crashLooping,
    crashLoopDetail: crashLooping ? `${child?.restarts ?? 0} restart(s)` : "",
  };
}

/** `acme-site/sentry`, falling back to the report's own key when unreadable. */
function pipelineName(cell: FleetCell): string {
  const tenant = cell.tenant?.path ?? cell.tenant?.id ?? null;
  return tenant === null ? cell.id : `${tenant}/${cell.pipeline}`;
}

/** `no pass for 17 min`, or the unit's own word. Read on both edges (#515 §9). */
function wedgedDetail(cell: FleetCell): string {
  const verdict = cell.wedged;
  if (verdict.wedged !== true) return "";
  if (verdict.reason === "no-pass") {
    return `no pass for ${Math.max(Math.floor(verdict.noPassForMs / 60_000), 1)} min`;
  }
  return "a unit is overdue";
}

/** Every enumerated cell the report lists. Anything else is not a pipeline. */
function cellsOf(report: DeploymentReport): FleetCell[] {
  const fleet = report.fleet;
  if (!isRecord(fleet) || !Array.isArray(fleet.cells)) return [];
  return (fleet.cells.filter(isRecord) as FleetCell[]).filter(
    (cell) => cell.source === "enumerated",
  );
}

/** The bootstrapper's children, which is where crash-looping is written down. */
function childrenOf(report: DeploymentReport): ChildLiveness[] {
  const bootstrapper = report.bootstrapper;
  if (!isRecord(bootstrapper) || !Array.isArray(bootstrapper.children)) return [];
  return bootstrapper.children.filter(isRecord) as ChildLiveness[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
