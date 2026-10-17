// What main knows about alerts (#524, map #497; the remote arm from map #690).
//
// Two arms end here, and main runs the one edge rule over both. A local
// install's report comes off the read loop (#556) with no socket behind it, so
// `connection` is null and only the three report-borne conditions apply. A
// remote's report comes off its supervisor's stream (remote-supervisor.ts),
// and the companion holds the clocks the relay used to: `connection` is the
// derived reachability, `quietForMs` is measured from the last thing heard,
// and `maybeReplaced` is whether the descriptor's id moved. One rule for both,
// imported from `phoebe-agent/contracts`, which is the whole point of that file
// being pure (#524 §3): two readers can never disagree about whether something
// is wrong.
//
// **The first read of a subject seeds and says nothing** (#524 §3). A
// companion that relaunches onto a fleet that was already wedged must not
// re-fire everything; the seeding read records what it found as already
// notified, so the next read only produces what has moved since. A local
// install's notified map lives here for the process; a remote's is persisted on
// its record (remotes.ts), so a relaunch dates darkness from real last contact,
// re-fires nothing already notified, and can still clear what it raised.
//
// **Blocked is never evaluated** (#697). Blocked means unknown — the pairing
// no longer works — so nothing is raised, nothing is cleared, and the badge
// does not count it; the row's warning tone is the whole of it.
//
// **The raised set is per subject, not per edge.** The badge is the count of
// subjects in any raised condition (#524 §4), so what is kept here is a set of
// condition keys per subject and what is answered is how many of those sets
// are non-empty. Three wedged pipelines on one deployment are one badge. A
// subject is a **route** (#699): a deployment reachable as a folder on this
// machine and as a remote is two subjects, counted twice while both see it.
//
// Nothing here touches Electron, and nothing here shows anything. Raising the
// notification is the renderer's (#524 §2); setting the badge is main's, from
// the count this answers.

import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts";
import type {
  AlertMessage,
  ChildLiveness,
  DeploymentReport,
  FleetCell,
  LocalAlertEvent,
  LocalReportEvent,
  NotifiedAlerts,
  PipelineAlertFacts,
  Reachability,
  RemoteAlertEvent,
  ReportAlertFacts,
  StoredReport,
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

/** One remote as the rule reads it: the record's clocks and the supervisor's reading. */
export type RemoteAlertInput = {
  deploymentId: string;
  name: string;
  reachability: Reachability;
  /** The last thing heard, ISO, or null before anything was. */
  lastHeardAt: string | null;
  /** The descriptor's id moved under the stored one. */
  maybeReplaced: boolean;
  report: StoredReport | null;
  /** The map as persisted on the record. */
  notified: NotifiedAlerts;
  /** Has a first evaluation already seeded the map? */
  seeded: boolean;
};

/** What a remote evaluation hands back: the alerts to raise, and the map to persist. */
export type RemoteAlertOutcome = {
  alerts: RemoteAlertEvent[];
  notified: NotifiedAlerts;
  seeded: boolean;
};

export type CompanionAlerts = {
  /**
   * One finished local read. Returns the alerts to raise — empty on the read
   * that seeded this install, and empty on every read where nothing moved,
   * which is almost all of them.
   */
  local: (event: LocalReportEvent) => LocalAlertEvent[];
  /**
   * One remote, re-evaluated: on every supervisor emission, and on the clock
   * that carries a dark remote past the five-minute mark. The map comes in off
   * the record and goes back out to be persisted; a blocked remote is handed
   * straight back with nothing raised.
   */
  remote: (input: RemoteAlertInput) => RemoteAlertOutcome;
  /** Forget one install: a removed folder must not leave a count behind. */
  forgetInstall: (dir: string) => void;
  /** Forget one remote: a signed-out or forgotten record must not leave a count behind. */
  forgetRemote: (deploymentId: string) => void;
  /** Subjects — local installs and remote routes — in any raised condition (#524 §4). */
  badge: () => number;
};

/** The conditions each subject has raised, by subject. */
type Raised = Map<string, Set<string>>;

/** Where the `url` on a remote's alert points: the remote route's page. */
export function remoteAlertUrl(deploymentId: string): string {
  return `${COMPANION_ORIGIN}/#/r/${encodeURIComponent(deploymentId)}`;
}

export function createCompanionAlerts(options: CompanionAlertsOptions = {}): CompanionAlerts {
  const clock = options.clock ?? (() => new Date());
  /** Last notified per install, keyed by directory — the local `alerts.json`. */
  const notified = new Map<string, NotifiedAlerts>();
  const raisedLocal: Raised = new Map();
  /** Raised per remote route, keyed by deployment id. Rebuilt from the persisted map on first sight. */
  const raisedRemote: Raised = new Map();

  return {
    remote(input) {
      if (input.reachability === "blocked") {
        return { alerts: [], notified: input.notified, seeded: input.seeded };
      }
      const held: NotifiedAlerts = { ...input.notified };
      // The persisted map says what was raised before this process started; the
      // badge has to count it from the first evaluation, not from the next edge.
      if (!raisedRemote.has(input.deploymentId)) {
        for (const [key, entry] of Object.entries(held)) {
          mark(raisedRemote, input.deploymentId, key, entry.state);
        }
      }
      const at = clock().toISOString();
      const heardAt = input.lastHeardAt === null ? null : Date.parse(input.lastHeardAt);
      const quiet =
        heardAt === null || !Number.isFinite(heardAt)
          ? null
          : Math.max(0, clock().getTime() - heardAt);
      const edges = alertEdges({
        facts: {
          fingerprint: input.deploymentId,
          name: input.name,
          connection: input.reachability,
          quietForMs: input.reachability === "connected" ? null : quiet,
          quietSince:
            input.reachability === "connected" || heardAt === null ? null : input.lastHeardAt,
          maybeReplaced: input.maybeReplaced,
          report: reportFactsOf(input.report),
        },
        notified: held,
        now: at,
      });
      for (const edge of edges) {
        held[edge.key] = { state: edge.state, at, since: edge.since };
        mark(raisedRemote, input.deploymentId, edge.key, edge.state);
      }
      if (!input.seeded) return { alerts: [], notified: held, seeded: true };
      return {
        seeded: true,
        notified: held,
        alerts: edges.map((edge) => ({
          type: "alert",
          deploymentId: input.deploymentId,
          at,
          alert: {
            schema: ALERT_SCHEMA,
            kind: "alert",
            condition: edge.condition,
            state: edge.state,
            deployment: { name: input.name, keyFingerprint: input.deploymentId },
            ...(edge.pipeline !== null ? { pipeline: edge.pipeline } : {}),
            since: edge.since,
            detail: edge.detail,
            text: alertText({ name: input.name, edge }),
            url: remoteAlertUrl(input.deploymentId),
          } satisfies AlertMessage,
        })),
      };
    },

    forgetRemote(deploymentId) {
      raisedRemote.delete(deploymentId);
    },

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
        type: "alert",
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

    forgetInstall(dir) {
      notified.delete(dir);
      raisedLocal.delete(dir);
    },

    badge: () => raisedLocal.size + raisedRemote.size,
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
  return reportFactsOf(event.report);
}

/** The same projection off a stored report alone, which is all a remote has. */
export function reportFactsOf(stored: StoredReport | null): ReportAlertFacts | null {
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
