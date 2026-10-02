// Which side of the seam this bundle is running on.
//
// One bundle serves two surfaces: a browser pointed at a relay, and the
// companion's window, where the same files are loaded from disk over a custom
// scheme (#522 §4). The only difference the bundle can observe is the desktop
// bridge the companion's preload exposes — there is no build flag, no user-agent
// sniff and no second entry point, because a second build is a second thing to
// keep in step.
//
// So this module is small on purpose: it reads one global and says which surface
// this is. Everything downstream takes the answer as a prop.

import { DESKTOP_BRIDGE_GLOBAL } from "phoebe-agent/contracts";
import type { DesktopBridge } from "phoebe-agent/contracts";

/** Where the console is running: a browser the relay served it to, or the companion. */
export type Surface = "browser" | "companion";

/**
 * The companion's bridge, or null in a browser.
 *
 * `globalThis` is a parameter so a test can hand in a window that has a bridge
 * without one existing.
 */
export function desktopBridge(host: object = globalThis): DesktopBridge | null {
  const bridge = (host as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL];
  return isBridge(bridge) ? bridge : null;
}

/**
 * Enough of a shape check to tell the bridge from anything else that happens to
 * hold that name. Not a schema: preload and renderer ship in one bundle at one
 * version (#527 §1), so the only question is whether a preload ran at all.
 */
function isBridge(value: unknown): value is DesktopBridge {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DesktopBridge>;
  return typeof candidate.version === "function" && typeof candidate.relay === "object";
}
