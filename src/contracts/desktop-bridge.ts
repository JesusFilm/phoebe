// The **desktop bridge** — the surface the companion's preload exposes to the
// console bundle, and the only way that bundle can tell it is running in the
// companion rather than in a browser (#522 §4, #527 §1).
//
// Types only, like the rest of contracts. The preload implements it over
// `ipcRenderer.invoke` and `ipcRenderer.on`; the renderer reads it off one
// global. Renderer and main ship in one bundle at one version (#521 §4), so
// there is no RPC library and no runtime schema layer between the two sides —
// this file is the whole agreement.
//
// What is declared here is what the companion's window needs to open: its
// version, and the relay arm it is (or is not) signed in to. The host verbs,
// the install list and the local read loop join it with #555; #554 gives the
// relay arm a device token, at which point `request` and `events` start
// answering instead of refusing.

import type { RelayEvent } from "./relay-events.ts";
import type { RelayIdentity } from "./relay-routes.ts";

/**
 * The global the preload writes the bridge onto, and the only thing the console
 * bundle looks at to learn which side of the seam it is running on (#522 §4).
 * Mirrored by hand in index.mjs, like every other value here.
 */
export const DESKTOP_BRIDGE_GLOBAL = "phoebe";

/**
 * Why a bridge call was refused. One closed set for both arms (#527 §16), so a
 * refusal renders the same way whether it came from Docker on this machine or
 * from the relay.
 */
export type DesktopBridgeErrorCode =
  | "not-initialised"
  | "docker-missing"
  | "container-not-running"
  | "busy"
  | "refused"
  | "signed-out"
  | "undelivered"
  | "unknown";

/**
 * The shape every rejected bridge call carries. `instruction` is the fallback
 * the operator can run by hand (#503), present only when there is one.
 */
export type DesktopBridgeError = {
  code: DesktopBridgeErrorCode;
  message: string;
  instruction?: string;
};

/**
 * Who the companion is signed in to, if anyone (#527 §9).
 *
 * `person` is the identity or null rather than a `signedIn` flag beside an
 * optional identity: two fields that can contradict each other are two fields a
 * page has to decide between.
 */
export type RelayArmState = {
  /** The relay this companion is paired with, or null before one is set. */
  url: string | null;
  /** The signed-in person, or null when there is no session. */
  person: RelayIdentity | null;
  /** Whether the session survives a relaunch. False with no keyring (#554). */
  persisted: boolean;
  /** What to tell the operator about the state above, when there is something. */
  reason?: string;
};

/** One call the companion makes on the relay's JSON API on the renderer's behalf. */
export type RelayPassthrough = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
};

/**
 * The bridge itself. Every method returns a promise; every subscription returns
 * its own unsubscribe.
 */
export type DesktopBridge = {
  /** The companion's version — the root package's, read at build time (#521 §4). */
  version: () => Promise<string>;
  /**
   * The remote arm. Main holds the device token and makes the calls, so the
   * renderer never learns the token and route knowledge stays in the console's
   * relay-client seam (#527 §9).
   */
  relay: {
    state: () => Promise<RelayArmState>;
    request: (request: RelayPassthrough) => Promise<unknown>;
    /** The relay's event stream, re-emitted. Returns the unsubscribe. */
    events: (onEvent: (event: RelayEvent) => void) => () => void;
    signOut: () => Promise<void>;
  };
};
