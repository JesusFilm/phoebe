// The IPC channels the preload calls and main answers. Internal to this package:
// the console bundle never sees a channel name, only the typed bridge that
// `phoebe-agent/contracts` declares.

import type { DesktopBridgeError } from "phoebe-agent/contracts";

export const BRIDGE_CHANNELS = {
  version: "phoebe:version",
  relayState: "phoebe:relay/state",
  relaySignIn: "phoebe:relay/sign-in",
  relayArm: "phoebe:relay/arm",
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

/** Carries a `DesktopBridgeError` out of a handler without losing its fields. */
export function detailOf(error: unknown): DesktopBridgeError | null {
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const { code, message } = detail as Partial<DesktopBridgeError>;
  return typeof code === "string" && typeof message === "string"
    ? (detail as DesktopBridgeError)
    : null;
}

/**
 * Run one handler and turn whatever comes out into the value the channel
 * carries. A refusal keeps its code; anything else that throws is `unknown`,
 * because a bug in main is not a thing the console can act on and pretending
 * otherwise would put a stack trace in a rail entry.
 */
export async function answer<T>(run: () => T | Promise<T>): Promise<BridgeResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const detail = detailOf(error);
    if (detail !== null) return refusal(detail);
    return refusal({
      code: "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
