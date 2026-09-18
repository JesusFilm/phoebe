// The IPC channels the preload calls and main answers. Internal to this package:
// the console bundle never sees a channel name, only the typed bridge that
// `phoebe-agent/contracts` declares.

import type { DesktopBridgeError } from "phoebe-agent/contracts";

export const BRIDGE_CHANNELS = {
  version: "phoebe:version",
  relayState: "phoebe:relay/state",
  relayRequest: "phoebe:relay/request",
  relaySignOut: "phoebe:relay/sign-out",
  relayEvent: "phoebe:relay/event",
} as const;

/**
 * What main answers an invoke with.
 *
 * A refusal travels as a value rather than as a thrown error because Electron
 * serialises a thrown error to its message and drops every field off it, and
 * `code` is the field every caller branches on (#527 §16). The preload turns the
 * value back into a rejection on the renderer's side, so the contract still
 * reads as "bridge calls reject with `{ code, message, instruction? }`".
 */
export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: DesktopBridgeError };

/** A refusal, ready to be handed back over a channel. */
export function refusal(error: DesktopBridgeError): BridgeResult<never> {
  return { ok: false, error };
}
