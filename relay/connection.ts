// Where the relay holds each deployment: connected, disconnected for N seconds,
// dark, or unseen (#507 §1, #541).
//
// This is a reading of two clocks against one file, and it is derived on every
// request rather than stored. A stored state would be wrong a second after it
// was written — nothing happens when a deployment goes dark, which is exactly
// what makes darkness worth deriving.
//
// **The dark clock starts at the later of the last heartbeat and the relay's
// own start.** A relay that restarts has heard from nobody yet, and a naive
// "last seen was four hours ago" would paint a healthy fleet dark for the first
// minute after every deploy. Counting from the restart gives every deployment
// the same grace it would get from a dropped socket, which is what it had.
//
// **Before the threshold, the word is a fact with a duration.** "Disconnected
// 12 s" is not a fourth state and not a prediction: the relay cannot know
// whether a deployment is reconnecting, retrying slowly, or gone. It knows how
// long it has been quiet. After the threshold that same silence has a meaning —
// **dark** — and requests to it are refused up front.
//
// **However the connection ended.** A clean close, a relay restart and a
// half-open socket all land here identically, because the deployment's side of
// each is the same: nothing is arriving. The half-open case needs one extra
// push, and it is the heartbeat's (relay/deployments.ts): a socket that has
// missed three pings is terminated, so it cannot sit in the live map reporting
// `connected` while the far end is a wall.

import type { ConnectionAlertFacts } from "../src/contracts/alerts.ts";
import { RELAY_DARK_AFTER_MS } from "../src/contracts/relay-protocol.ts";
import type { RelayConnectionState, RelayDeploymentRow } from "../src/contracts/relay-routes.ts";
import type { Link } from "./links.ts";

/** What the live process knows about one link beyond what `links.json` holds. */
export type ConnectionFacts = {
  /** When the live connection completed its handshake, or null for no socket. */
  connectedSince: Date | null;
  /**
   * When the relay last heard anything from this deployment *in this process* —
   * a pong, a message, a handshake. Null after a restart, which is the case the
   * dark clock's `max` exists for.
   */
  lastHeard: Date | null;
  /** How the last connection in this process ended, close code and all. */
  lastClose: { code: number; reason: string; at: string } | null;
};

/** A link with no live connection and nothing heard yet. */
export const NOTHING_HEARD: ConnectionFacts = {
  connectedSince: null,
  lastHeard: null,
  lastClose: null,
};

export type ConnectionVerdict = {
  state: RelayConnectionState;
  /** Whole seconds of silence, while `disconnected`. Null in every other state. */
  disconnectedForSeconds: number | null;
  /**
   * How long this deployment has been quiet, in ms, on the clock below — and
   * unlike `disconnectedForSeconds` it keeps counting past the dark threshold,
   * because that is the clock the five-minute alert debounce reads (#515 §4).
   * Null while there is a live socket and null for a link never heard from.
   *
   * A console never renders this. It is the number two thresholds are compared
   * against, and a row that published it would be inviting a second reading of
   * darkness beside the relay's own.
   */
  quietForMs: number | null;
  /** When that silence started, ISO 8601 — the `since` on a dark alert. */
  quietSince: string | null;
};

/**
 * One link's connection state. `darkAfterMs` is a parameter only so a test can
 * make a minute pass without waiting one; production has a single threshold and
 * it is not configuration.
 */
export function connectionOf(input: {
  link: Link;
  facts: ConnectionFacts;
  /** When this relay process started serving. */
  relayStartedAt: Date;
  now: Date;
  darkAfterMs?: number;
}): ConnectionVerdict {
  const { link, facts } = input;
  if (facts.connectedSince !== null) {
    return {
      state: "connected",
      disconnectedForSeconds: null,
      quietForMs: null,
      quietSince: null,
    };
  }
  if (link.lastSeen === null && facts.lastHeard === null) {
    return { state: "unseen", disconnectedForSeconds: null, quietForMs: null, quietSince: null };
  }
  const since = Math.max(facts.lastHeard?.getTime() ?? 0, input.relayStartedAt.getTime());
  const quietFor = Math.max(input.now.getTime() - since, 0);
  const quiet = { quietForMs: quietFor, quietSince: new Date(since).toISOString() };
  if (quietFor >= (input.darkAfterMs ?? RELAY_DARK_AFTER_MS)) {
    return { state: "dark", disconnectedForSeconds: null, ...quiet };
  }
  return { state: "disconnected", disconnectedForSeconds: Math.floor(quietFor / 1000), ...quiet };
}

/**
 * Every link as the alert rule reads its connection half (#515). The same two
 * clocks `deploymentRows` reads, projected onto the rule's own vocabulary
 * instead of a console's: no `lastClose`, no `firstSeen`, and the silence in ms
 * rather than in the seconds a row publishes.
 *
 * The report half is not here. The relay gets that from wherever it stores what
 * a deployment pushed, and the notifier joins the two.
 */
export function alertConnections(input: {
  links: readonly Link[];
  facts: (link: Link) => ConnectionFacts;
  relayStartedAt: Date;
  now: Date;
  darkAfterMs?: number;
}): ConnectionAlertFacts[] {
  return input.links.map((link) => {
    const verdict = connectionOf({
      link,
      facts: input.facts(link),
      relayStartedAt: input.relayStartedAt,
      now: input.now,
      ...(input.darkAfterMs !== undefined ? { darkAfterMs: input.darkAfterMs } : {}),
    });
    return {
      fingerprint: link.fingerprint,
      name: link.name,
      connection: verdict.state,
      quietForMs: verdict.quietForMs,
      quietSince: verdict.quietSince,
      maybeReplaced: replacedBy(link, input.links, verdict.state),
    };
  });
}

/**
 * A newer link has taken this dark link's name (#505 §5) — the one derivation
 * that looks across rows, shared by the console's rows and the alert rule so
 * the panel and the alert cannot disagree about which link looks replaced.
 */
function replacedBy(link: Link, links: readonly Link[], state: RelayConnectionState): boolean {
  if (state !== "dark") return false;
  return links.some((other) => other.name === link.name && other.firstSeen > link.firstSeen);
}

/**
 * Every link this relay knows, as a console reads them. Sorting is the
 * console's (#507 §9); this hands over the facts in the order they were paired.
 *
 * The `maybeReplaced` flag is the one derivation that looks across rows: a dark
 * link whose name a newer link has taken is almost certainly the same
 * deployment after a data-volume wipe (#505 §5). Almost, not certainly — two
 * deployments are allowed to share a name — so the flag is a question the relay
 * asks and a person answers by forgetting one of them.
 */
export function deploymentRows(input: {
  links: readonly Link[];
  facts: (link: Link) => ConnectionFacts;
  relayStartedAt: Date;
  now: Date;
  darkAfterMs?: number;
}): RelayDeploymentRow[] {
  return input.links.map((link) => {
    const facts = input.facts(link);
    const verdict = connectionOf({
      link,
      facts,
      relayStartedAt: input.relayStartedAt,
      now: input.now,
      ...(input.darkAfterMs !== undefined ? { darkAfterMs: input.darkAfterMs } : {}),
    });
    return {
      fingerprint: link.fingerprint,
      name: link.name,
      publicKey: link.publicKey,
      // Empty on the link means no box key: a deployment paired before box keys
      // existed, which is a fact the console needs rather than a blank it
      // should try to encrypt to.
      boxKey: link.boxKey === "" ? null : link.boxKey,
      firstSeen: link.firstSeen,
      lastSeen: link.lastSeen,
      pairedBy: link.pairedBy,
      state: verdict.state,
      connectedSince: facts.connectedSince?.toISOString() ?? null,
      disconnectedForSeconds: verdict.disconnectedForSeconds,
      lastClose: facts.lastClose,
      maybeReplaced: replacedBy(link, input.links, verdict.state),
    };
  });
}
