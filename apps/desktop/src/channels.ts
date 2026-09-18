// The IPC channels the preload calls and main answers. Internal to this package:
// the console bundle never sees a channel name, only the typed bridge that
// `phoebe-agent/contracts` declares.

import type { DesktopBridgeError } from "phoebe-agent/contracts";

export const BRIDGE_CHANNELS = {
  version: "phoebe:version",
  environment: "phoebe:environment",
  installsList: "phoebe:installs/list",
  installsPick: "phoebe:installs/pick",
  installsAdd: "phoebe:installs/add",
  installsRemove: "phoebe:installs/remove",
  installsChanged: "phoebe:installs/changed",
  runStart: "phoebe:runs/start",
  runCurrent: "phoebe:runs/current",
  runCancel: "phoebe:runs/cancel",
  runLine: "phoebe:runs/line",
  runExit: "phoebe:runs/exit",
  preferencesGet: "phoebe:preferences/get",
  preferencesSet: "phoebe:preferences/set",
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

/**
 * A refusal raised from inside main, where a throw is the natural shape.
 *
 * One error shape for the whole bridge (#527 §16) means the code and the
 * instruction have to survive from wherever the decision was made to the
 * handler that answers the invoke. An `Error` subclass carries them there; the
 * handler turns it back into a {@link refusal}, and anything else that escapes
 * becomes `unknown` with its message intact.
 */
export class BridgeRefusal extends Error {
  readonly error: DesktopBridgeError;

  constructor(error: DesktopBridgeError) {
    super(error.message);
    this.name = "BridgeRefusal";
    this.error = error;
  }
}

/**
 * Run one handler's body, answering with its value or with the refusal it
 * raised. Every channel goes through here, so no handler has to remember to
 * catch — and an unexpected throw arrives at the window as `unknown` with a
 * message rather than as a promise that never settles.
 */
export async function answering<T>(body: () => T | Promise<T>): Promise<BridgeResult<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    if (error instanceof BridgeRefusal) return refusal(error.error);
    return refusal({
      code: "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
