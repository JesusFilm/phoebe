// The **alert** — the message the relay sends out when a deployment or one of
// its pipelines crosses into or out of a named condition (#515, amended by #524
// §1, map #497).
//
// This file is the whole edge rule, and it is a pure function because two
// readers run it and neither can import the other's code: the relay evaluates
// it over the links it holds and the reports they pushed (relay/alerts.ts), and
// the companion's main process runs the same rule over a local install's
// report, where there is no relay and no notion of darkness (#524 §3). One
// rule, so a desktop notification and a webhook post can never disagree about
// whether something is wrong.
//
// **An alert is a transition, not a record** (#515 §6). There is no list, no
// acknowledge and no history: the fleet row already says what is true now, and
// what this file computes is the moment the answer changed. The caller keeps
// the last state it notified per (deployment, condition) and hands it back in;
// everything else falls out of comparing that against the facts.
//
// Three rules shape the comparison, and each exists because of a 3 a.m. page
// nobody should get.
//
// **Unseen is silent.** A link with no completed handshake behind it is setup
// in progress, not an incident (#515 §3).
//
// **Darkness waits five minutes.** The console says "dark" at the 60 s mark
// because that is when the relay stops believing the socket; the alert waits
// until {@link ALERT_DARK_AFTER_MS}, so a container restart or a flapping
// uplink never wakes anyone (#515 §4).
//
// **A dark deployment's other conditions are frozen.** Its reports are stale,
// so `wedged`, `crash-looping` and `doctor-fail` hold at their last notified
// state — no raise and, more to the point, no clear — until it reconnects and
// reports, at which moment each is re-evaluated against fresh facts (#515 §11).
//
// A condition can also be **silent** for a duller reason: there is nothing to
// read. No report means no verdict on the three report-borne conditions, and a
// doctor run that timed out says `unknown`, which is not a pass.

import type { RelayConnectionState } from "./relay-routes.ts";

/** The `schema` integer every alert body carries. Versioned like the report. */
export const ALERT_SCHEMA = 1;

/**
 * How long after the last heartbeat a deployment's silence becomes an alert
 * (#515 §4). Five minutes, and a constant rather than a setting for the same
 * reason the heartbeat is one: an operator who tuned it would be making the
 * alert disagree with the console.
 *
 * Deliberately longer than `RELAY_DARK_AFTER_MS`. The console says "dark since"
 * from the 60 s mark and the alert waits out the next four minutes, so the most
 * common cause of darkness — a deployment being restarted — is usually over
 * before anything is sent.
 */
export const ALERT_DARK_AFTER_MS = 5 * 60_000;

/**
 * The five conditions, in the order #515 §3 lists them. Two are the relay's own
 * — `dark` and `replaced` are read off connection facts — and three come off a
 * pushed report, which is why a companion watching a local install raises only
 * the latter three.
 */
export const ALERT_CONDITIONS = [
  "dark",
  "wedged",
  "crash-looping",
  "doctor-fail",
  "replaced",
] as const;

/** One named condition. */
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

/** Which way an edge went. Every raise has a matching clear (#515 §3). */
export type AlertState = "raised" | "cleared";

/**
 * Doctor's overall verdict, as the edge rule reads it. Three words, not four:
 * the report's per-check `warn` is a console's business, and `unknown` — a run
 * that timed out or crashed — neither raises nor clears, because "we could not
 * ask" is not an answer either way (#515 §10).
 */
export type DoctorVerdict = "ok" | "fail" | "unknown";

/** One pipeline's two report-borne conditions, with a line each for `detail`. */
export type PipelineAlertFacts = {
  /** What the payload's `pipeline` field says, e.g. `acme-site/sentry`. */
  pipeline: string;
  wedged: boolean;
  /** Why, in one line — `no pass for 17 min`. Read on both edges. */
  wedgedDetail: string;
  crashLooping: boolean;
  crashLoopDetail: string;
};

/**
 * The last report a reader holds, projected onto what the rule reads. A
 * projection rather than the `DeploymentReport` itself, so this file stays
 * indifferent to every section of that report it has no opinion about — and so
 * a caller with a differently-shaped source (a local install's file, a relay's
 * stored report) has one small mapping to write rather than a schema to meet.
 */
export type ReportAlertFacts = {
  /** When the report was taken — the `since` a report-borne raise carries. */
  at: string;
  doctor: DoctorVerdict;
  /** The failing checks, named, for a `doctor-fail` body's `detail`. */
  doctorDetail: string;
  /** Every pipeline the report describes. One absent from it is not wedged. */
  pipelines: PipelineAlertFacts[];
};

/** The connection half of one deployment's facts: the relay's two clocks. */
export type ConnectionAlertFacts = {
  fingerprint: string;
  /** What the deployment calls itself; the subject of every alert's `text`. */
  name: string;
  /**
   * Where the relay holds it (#507 §1), or **null for a reader with no relay**
   * — a companion watching a local install, which has no darkness to observe
   * and no link to be replaced (#524 §3). Null evaluates the report-borne
   * conditions and nothing else.
   */
  connection: RelayConnectionState | null;
  /**
   * Silence since the last heartbeat, in ms — the clock
   * {@link ALERT_DARK_AFTER_MS} is measured against. Null while there is a live
   * socket, and null for a link nothing has ever been heard from.
   */
  quietForMs: number | null;
  /** When that silence started, ISO 8601 — the `since` on a dark raise. */
  quietSince: string | null;
  /** A newer link shares this dark link's name (#505 §5). */
  maybeReplaced: boolean;
};

/** Everything the rule reads about one deployment. */
export type DeploymentAlertFacts = ConnectionAlertFacts & {
  report: ReportAlertFacts | null;
};

/**
 * One entry of the caller's last-notified state — what `alerts.json` holds per
 * (deployment, condition) on the relay, and what the companion keeps in memory.
 * `at` is when the send was **attempted**, which is what the console's "last
 * alert" line reads (#515 §13).
 */
export type NotifiedAlert = {
  state: AlertState;
  at: string;
  /** The `since` that went out with it, kept so a console can date the edge. */
  since: string;
};

/** One deployment's notified state, keyed by {@link alertKeyOf}. */
export type NotifiedAlerts = Record<string, NotifiedAlert>;

/**
 * The key a notified state is recorded under. `wedged` and `crash-looping` are
 * per pipeline and so carry one; the other three are per deployment and do not.
 * A colon is safe as the separator because no condition contains one.
 */
export function alertKeyOf(condition: AlertCondition, pipeline?: string | null): string {
  return pipeline === undefined || pipeline === null ? condition : `${condition}:${pipeline}`;
}

/** One edge the caller should send, and record after attempting. */
export type AlertEdge = {
  /** {@link alertKeyOf} for this condition and pipeline. */
  key: string;
  condition: AlertCondition;
  state: AlertState;
  /** Set on `wedged` and `crash-looping` only (#515 §9). */
  pipeline: string | null;
  since: string;
  detail: string;
};

/**
 * What the rule concluded about one condition. `silent` is not a third state of
 * the world — it is the rule declining to have an opinion, which leaves the
 * caller's last notified state exactly where it was. A clear carries no `since`
 * because the only moment a caller can date it to is now.
 */
type Observation =
  | { state: "raised"; since: string; detail: string }
  | { state: "cleared"; detail: string }
  | { state: "silent" };

const SILENT: Observation = { state: "silent" };

/** The two conditions that belong to a pipeline rather than a deployment. */
const PIPELINE_CONDITIONS = ["wedged", "crash-looping"] as const;

/**
 * **The edge rule.** Everything that has crossed a condition boundary since the
 * caller last notified, as a list of messages to send — empty on the ordinary
 * pass where nothing moved, which is almost every pass.
 *
 * An unchanged observation produces nothing, so a relay restart re-evaluates
 * the whole fleet and stays quiet about the parts of it that are still true
 * (#515 §5). A clear for a condition that was never raised produces nothing
 * either: the first thing an operator hears about a deployment is never that it
 * has stopped doing something they were never told it was doing.
 */
export function alertEdges(input: {
  facts: DeploymentAlertFacts;
  /** What the caller last sent for this deployment. `{}` for a new one. */
  notified: NotifiedAlerts;
  /** ISO 8601. The rule takes the clock as an argument rather than reading one. */
  now: string;
  /**
   * The dark debounce, a parameter only so a test can watch five minutes pass
   * in five milliseconds. Production has one threshold and it is
   * {@link ALERT_DARK_AFTER_MS}; there is no way to set it from outside the
   * process.
   */
  darkAfterMs?: number;
}): AlertEdge[] {
  const { facts, notified } = input;
  const edges: AlertEdge[] = [];

  const consider = (
    condition: AlertCondition,
    pipeline: string | null,
    observation: Observation,
  ): void => {
    if (observation.state === "silent") return;
    const key = alertKeyOf(condition, pipeline);
    const last = notified[key];
    if (last !== undefined && last.state === observation.state) return;
    // Nothing was ever raised, so there is nothing to clear.
    if (last === undefined && observation.state === "cleared") return;
    edges.push({
      key,
      condition,
      state: observation.state,
      pipeline,
      // A raise dates from when the condition started; a clear dates from now,
      // the only moment the caller knows it has stopped.
      since: observation.state === "raised" ? observation.since : input.now,
      detail: observation.detail,
    });
  };

  consider("dark", null, darkness(facts, input.darkAfterMs ?? ALERT_DARK_AFTER_MS));
  consider("replaced", null, replacement(facts));

  // The three that read a report, and the states that freeze them: unseen,
  // dark, or no report to read.
  if (facts.connection === "dark" || facts.connection === "unseen") return edges;
  const report = facts.report;
  if (report === null) return edges;

  consider("doctor-fail", null, doctorFailure(report));
  for (const pipeline of report.pipelines) {
    consider("wedged", pipeline.pipeline, wedging(pipeline, report.at));
    consider("crash-looping", pipeline.pipeline, crashLooping(pipeline, report.at));
  }
  // A pipeline that has left the report — a tenant removed, a pipeline renamed
  // — is not wedged and not crash-looping. Clearing it is both honest and the
  // only thing that keeps the notified state from growing forever.
  for (const key of Object.keys(notified)) {
    const gone = departed(key, report.pipelines);
    if (gone === null) continue;
    consider(gone.condition, gone.pipeline, {
      state: "cleared",
      detail: "the pipeline is no longer in the report",
    });
  }

  return edges;
}

/** Dark: five minutes unheard, cleared by the next completed handshake. */
function darkness(facts: ConnectionAlertFacts, darkAfterMs: number): Observation {
  if (facts.connection === null || facts.connection === "unseen") return SILENT;
  if (facts.connection === "connected") return { state: "cleared", detail: "connected" };
  if (facts.quietForMs === null || facts.quietForMs < darkAfterMs) return SILENT;
  return {
    state: "raised",
    since: facts.quietSince ?? "",
    detail: `no heartbeat for ${minutesOf(facts.quietForMs)}`,
  };
}

/**
 * Replaced: a newer link has taken a dark link's name, which is what a wiped
 * data volume looks like from the relay (#505 §5). The clear is the other
 * reading coming true — the old deployment turned up again, so it was never
 * replaced. Forgetting it clears nothing, because forgetting drops its entries
 * altogether (#515 §5).
 */
function replacement(facts: ConnectionAlertFacts): Observation {
  if (facts.connection === null || facts.connection === "unseen") return SILENT;
  if (!facts.maybeReplaced) {
    return { state: "cleared", detail: "no newer link shares this name" };
  }
  return {
    state: "raised",
    since: facts.quietSince ?? "",
    detail: "a newer link shares this name",
  };
}

/** Doctor-fail: one condition per deployment, on the report's overall verdict. */
function doctorFailure(report: ReportAlertFacts): Observation {
  if (report.doctor === "unknown") return SILENT;
  return report.doctor === "fail"
    ? { state: "raised", since: report.at, detail: report.doctorDetail }
    : { state: "cleared", detail: report.doctorDetail };
}

function wedging(pipeline: PipelineAlertFacts, at: string): Observation {
  return pipeline.wedged
    ? { state: "raised", since: at, detail: pipeline.wedgedDetail }
    : { state: "cleared", detail: pipeline.wedgedDetail };
}

function crashLooping(pipeline: PipelineAlertFacts, at: string): Observation {
  return pipeline.crashLooping
    ? { state: "raised", since: at, detail: pipeline.crashLoopDetail }
    : { state: "cleared", detail: pipeline.crashLoopDetail };
}

/**
 * A notified key whose pipeline the report no longer mentions, split back into
 * its condition and its pipeline. Null for every key that is not a per-pipeline
 * condition and for every pipeline that is still there.
 */
function departed(
  key: string,
  pipelines: readonly PipelineAlertFacts[],
): { condition: AlertCondition; pipeline: string } | null {
  for (const condition of PIPELINE_CONDITIONS) {
    const prefix = `${condition}:`;
    if (!key.startsWith(prefix)) continue;
    const pipeline = key.slice(prefix.length);
    if (pipelines.some((entry) => entry.pipeline === pipeline)) return null;
    return { condition, pipeline };
  }
  return null;
}

/** `no heartbeat for 5 min` — whole minutes, floored, never `0 min`. */
function minutesOf(ms: number): string {
  return `${Math.max(Math.floor(ms / 60_000), 1)} min`;
}

/**
 * The webhook body and the SSE `alert` event's data, which are the same object
 * by decision (#524 §1): two sinks of one edge rule, so a chat channel and a
 * desktop notification say the same sentence.
 *
 * `text` is what a generic incoming webhook renders without being taught
 * anything — the field name every such product already reads, chosen so the
 * zero-integration case works. A real integration reads the fields beside it.
 */
export type AlertMessage = {
  schema: number;
  kind: "alert";
  condition: AlertCondition;
  state: AlertState;
  deployment: { name: string; keyFingerprint: string };
  /** Only on `wedged` and `crash-looping`. */
  pipeline?: string;
  since: string;
  detail: string;
  text: string;
  /** Deep link to the deployment's page on the console. */
  url: string;
};

/**
 * What the **Send test alert** button posts (#515 §13). A separate `kind` so
 * nothing downstream mistakes a test for an incident, and fleet-wide because
 * the question it answers is about the webhook, not about any deployment.
 */
export type AlertTestMessage = {
  schema: number;
  kind: "test";
  /** The address that pressed the button. */
  by: string;
  at: string;
  text: string;
  /** The console's own origin — where the operator just came from. */
  url: string;
};

/** Anything the relay hands a sink. */
export type AlertBody = AlertMessage | AlertTestMessage;

/** One edge as a body, ready for a webhook and for the stream (#515 §9). */
export function alertMessage(input: {
  edge: AlertEdge;
  deployment: { name: string; fingerprint: string };
  /** The console's origin, e.g. `https://relay.example`. */
  consoleOrigin: string;
}): AlertMessage {
  const { edge, deployment } = input;
  return {
    schema: ALERT_SCHEMA,
    kind: "alert",
    condition: edge.condition,
    state: edge.state,
    deployment: { name: deployment.name, keyFingerprint: deployment.fingerprint },
    ...(edge.pipeline !== null ? { pipeline: edge.pipeline } : {}),
    since: edge.since,
    detail: edge.detail,
    text: alertText({ name: deployment.name, edge }),
    url: alertUrl(input.consoleOrigin, deployment.fingerprint),
  };
}

/** The test body. */
export function alertTestMessage(input: {
  by: string;
  at: string;
  consoleOrigin: string;
}): AlertTestMessage {
  return {
    schema: ALERT_SCHEMA,
    kind: "test",
    by: input.by,
    at: input.at,
    text: `Phoebe relay test alert, sent by ${input.by}. Alerting is configured.`,
    url: `${trimSlash(input.consoleOrigin)}/`,
  };
}

/**
 * The one-line sentence, in the shape #515 §9's example fixes:
 * `acme-site: pipeline sentry wedged (no pass for 17 min)`. A clear is the
 * same sentence with `no longer` in it, so the two read as one thread on a
 * notification the OS folds by tag (#524 §5).
 */
export function alertText(input: { name: string; edge: AlertEdge }): string {
  const { edge } = input;
  const subject = edge.pipeline === null ? "" : `pipeline ${leafOf(edge.pipeline)} `;
  const word = CONDITION_WORD[edge.condition];
  const verdict = edge.state === "raised" ? word : `no longer ${word}`;
  const why = edge.detail === "" ? "" : ` (${edge.detail})`;
  return `${input.name}: ${subject}${verdict}${why}`;
}

/** The deployment page a body deep-links to (#515 §9). */
export function alertUrl(consoleOrigin: string, fingerprint: string): string {
  return `${trimSlash(consoleOrigin)}/#/d/${fingerprint}`;
}

/**
 * How each condition reads in a sentence. `doctor-fail` and `replaced` are the
 * two that cannot be their own adjective, so they get one.
 */
const CONDITION_WORD: Record<AlertCondition, string> = {
  dark: "dark",
  wedged: "wedged",
  "crash-looping": "crash-looping",
  "doctor-fail": "failing doctor's checks",
  replaced: "probably replaced",
};

/** `acme-site/sentry` → `sentry`: the pipeline's own name in a sentence. */
function leafOf(pipeline: string): string {
  const slash = pipeline.lastIndexOf("/");
  return slash === -1 ? pipeline : pipeline.slice(slash + 1);
}

function trimSlash(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

/**
 * The most recent alert the relay attempted for one deployment — the console's
 * "last alert: dark raised 3 h ago" line (#515 §13). One entry, not a list: an
 * alert history stays rejected, and this is the deployment's current edge
 * bookkeeping read out loud rather than a log.
 */
export type LastAlert = {
  condition: AlertCondition;
  state: AlertState;
  /** Set when the condition was a pipeline's. */
  pipeline: string | null;
  /** When the send was attempted, ISO 8601. The console renders the age. */
  at: string;
};

/**
 * What the connection panel shows about alerting (#515 §13). Fleet-wide,
 * because alerting is configured on the relay and not per deployment: one
 * `webhook` flag for the whole panel, and one `last` entry per deployment.
 *
 * `webhook: false` is not "alerting is off" — the relay still evaluates every
 * edge and still emits the `alert` event; what is absent is the webhook (#524
 * §1). The panel's wording is the console's business; the fact is this.
 */
export type RelayAlertFacts = {
  webhook: boolean;
  /** Keyed by the deployment's fingerprint. Absent means nothing yet. */
  last: Record<string, LastAlert>;
};
