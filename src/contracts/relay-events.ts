// The relay's event stream — one SSE connection carrying everything a console
// would otherwise poll for (#542, decided in #506 §10).
//
// **One stream, not one per concern.** A console page shows the fleet and one
// deployment at once, and two streams would mean two reconnects, two backoffs
// and two chances to be half-subscribed. Everything the relay learns rides here
// and a reader ignores what it does not render.
//
// **An event is a fact that just became true, never a digest.** A `report`
// event carries the report that arrived, verbatim; a connection event carries
// the row as it now reads. Nothing here is a delta against what the reader last
// saw, because the relay does not know what that was — a page that missed an
// event catches up by re-reading `/api/deployments`.
//
// **An `alert` rides the same stream** (#524 §1). The relay evaluates the edge
// rule over every link it holds and sends what crossed; the webhook is one sink
// and this event is the other, carrying the identical body. A browser ignores
// it — the fleet row already says what is true — and the companion turns it into
// an OS notification, which is the whole reason a device is worth more than a
// tab.
//
// **The connection event's `type` is the word the row now carries.** The relay
// says `connected`, `disconnected` or `dark` — the same three words
// `RelayConnectionState` spells, minus the one that never arrives: nothing
// happens when a link goes `unseen`, because `unseen` is where every link
// starts.

import type { AlertBody } from "./alerts.ts";
import type { RelayConnectionState, RelayDeploymentRow } from "./relay-routes.ts";

/**
 * Every event name the stream uses, as one closed record. These are the SSE
 * `event:` field, so a browser attaches a listener per name rather than
 * branching inside one handler.
 */
export const RELAY_EVENTS = {
  /** A deployment's report arrived and replaced the one the relay held. */
  report: "report",
  /** A deployment completed a handshake; the relay holds its socket. */
  connected: "connected",
  /** Its socket ended, however it ended. Inside the dark window, still. */
  disconnected: "disconnected",
  /** `RELAY_DARK_AFTER_MS` unheard. The relay lost it; that is all it means. */
  dark: "dark",
  /** An alert edge was crossed, or the test button was pressed (#524 §1). */
  alert: "alert",
} as const;

/** One event name. */
export type RelayEventName = (typeof RELAY_EVENTS)[keyof typeof RELAY_EVENTS];

/**
 * A deployment report, as it arrived. The relay hoists `schema` so a reader can
 * branch on it and carries `report` opaque: the body is the deployment's to
 * shape and a console one version ahead of this relay renders fields it has
 * never heard of.
 */
export type RelayReportEvent = {
  type: typeof RELAY_EVENTS.report;
  /** When the relay took delivery, ISO 8601. */
  at: string;
  fingerprint: string;
  schema: number;
  report: unknown;
};

/**
 * A deployment moved between connection states. The whole row rides along so a
 * console re-renders it without a second request — the row is the only thing it
 * would have asked for.
 */
export type RelayConnectionEvent = {
  /** The state the row now carries. `unseen` is not among them: see the header. */
  type: Exclude<RelayConnectionState, "unseen">;
  at: string;
  deployment: RelayDeploymentRow;
};

/**
 * One alert, exactly as the webhook would have received it (#515 §9, #524 §1).
 * The body rides whole under `alert` rather than spread across this event, so
 * the two sinks cannot drift: what a chat channel renders and what a companion
 * notifies about are the same object, field for field.
 *
 * The body's own `kind` separates a crossed edge from the test button's probe.
 * A reader that only cares about incidents branches on it; nothing else has to.
 */
export type RelayAlertEvent = {
  type: typeof RELAY_EVENTS.alert;
  /** When the relay sent it, ISO 8601. */
  at: string;
  alert: AlertBody;
};

/** Everything the stream carries today. */
export type RelayEvent = RelayReportEvent | RelayConnectionEvent | RelayAlertEvent;
