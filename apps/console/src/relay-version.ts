// The version handshake, from the console's side (#525 §4).
//
// One read, before anything else: `GET /api/version` is unauthenticated, so this
// happens ahead of the session, ahead of the fleet, ahead of the stream. If the
// relay serves a console protocol below this bundle's, the Relay arm says
// **upgrade the relay first** and the console asks that relay for nothing more.
// A page that went on to fetch the fleet anyway would be a page rendering
// whatever an older relay happened to answer, which is the failure the integer
// exists to prevent.
//
// **This is where the inequality lives, and the only place.** The relay never
// performs it — it publishes its integer and serves everyone at or below it — so
// there is no second implementation to keep in step, and no hand-mirrored copy
// in the contracts' runtime entry (console-protocol.ts says why).
//
// The rule bites in the companion, which is distributed on its own and can
// therefore be newer than the relay it points at (#525 §5). In a browser the
// relay served this very bundle, so the answer is always "serves" — the check
// still runs there rather than branching on the surface, because a branch is a
// second path and this one costs one request that is already warm in the cache.

import { CONSOLE_PROTOCOL } from "phoebe-agent/contracts";
import type { RelayVersion } from "phoebe-agent/contracts";
import { RelayRequestError, type RelayClient } from "./relay-client.ts";

/** Where the relay upgrade doc lives, for the refusal to point at. */
export const RELAY_UPGRADE_DOC =
  "https://github.com/JesusFilm/phoebe/blob/main/docs/relay.md#upgrading";

/** The sentence, shared with the deployment wire so an operator learns it once. */
export const UPGRADE_THE_RELAY = "upgrade the relay first";

/**
 * What the console knows about the relay it is pointed at.
 *
 *  - `serves` — this relay is at or above this bundle. Carry on.
 *  - `too-old` — it is below. Say so and make no other call. `relay` is null
 *    when the relay is old enough not to answer `/api/version` at all, which is
 *    the same verdict arrived at from a 404 rather than from an integer.
 *  - `unread` — nobody could ask. Not a verdict: an unreachable relay, a
 *    companion with no session to ask through, a fetch that failed. The console
 *    carries on and fails the way it would have failed anyway, because refusing
 *    on a read that did not happen would strand every operator whose relay was
 *    merely slow.
 */
export type RelayVersionReading =
  | { kind: "serves"; relay: RelayVersion }
  | { kind: "too-old"; relay: RelayVersion | null }
  | { kind: "unread" };

/**
 * Does a relay serving `relayConsole` answer a console speaking
 * `consoleProtocol`? The whole of the rule, in one expression, written the same
 * way round as `relaySpeaks` on the deployment rail: the relay is the side that
 * has to be newer.
 */
export function relayServesConsole(relayConsole: number, consoleProtocol: number): boolean {
  return relayConsole >= consoleProtocol;
}

/** Ask the relay, and read the answer as one of the three verdicts above. */
export async function readRelayVersion(client: RelayClient): Promise<RelayVersionReading> {
  let relay: RelayVersion;
  try {
    relay = await client.version();
  } catch (error) {
    // A relay with no `/api/version` is a relay from before the route existed,
    // which is below every console protocol there has ever been. That is the
    // verdict, not an error — and it is the only status that reads as one.
    if (error instanceof RelayRequestError && error.status === 404) {
      return { kind: "too-old", relay: null };
    }
    return { kind: "unread" };
  }
  return relayServesConsole(relay.console, CONSOLE_PROTOCOL)
    ? { kind: "serves", relay }
    : { kind: "too-old", relay };
}

/**
 * What the Relay group says when it is refusing. One sentence, because the rail
 * has one line: what is wrong, and which end to move.
 */
export function tooOldText(relay: RelayVersion | null): string {
  const its = relay === null ? "an older console API" : `console protocol ${relay.console}`;
  const version = relay === null ? "" : ` (phoebe-agent ${relay.version})`;
  return `This relay serves ${its}${version} and this one speaks ${CONSOLE_PROTOCOL} — ${UPGRADE_THE_RELAY}.`;
}
