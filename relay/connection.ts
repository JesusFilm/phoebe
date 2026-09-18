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
    return { state: "connected", disconnectedForSeconds: null };
  }
  if (link.lastSeen === null && facts.lastHeard === null) {
    return { state: "unseen", disconnectedForSeconds: null };
  }
  const quietSince = Math.max(facts.lastHeard?.getTime() ?? 0, input.relayStartedAt.getTime());
  const quietFor = Math.max(input.now.getTime() - quietSince, 0);
  if (quietFor >= (input.darkAfterMs ?? RELAY_DARK_AFTER_MS)) {
    return { state: "dark", disconnectedForSeconds: null };
  }
  return { state: "disconnected", disconnectedForSeconds: Math.floor(quietFor / 1000) };
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
      firstSeen: link.firstSeen,
      lastSeen: link.lastSeen,
      pairedBy: link.pairedBy,
      state: verdict.state,
      connectedSince: facts.connectedSince?.toISOString() ?? null,
      disconnectedForSeconds: verdict.disconnectedForSeconds,
      lastClose: facts.lastClose,
      maybeReplaced:
        verdict.state === "dark" &&
        input.links.some((other) => other.name === link.name && other.firstSeen > link.firstSeen),
    };
  });
}
