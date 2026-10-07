// Where the console is, as one value read off the URL hash.
//
// The hash, not the path. The bundle is loaded from a custom scheme in the
// companion (#522 §4), and a hash router needs nothing from whatever serves it:
// it works identically off a `file://` document.
//
// Parsing is total: anything that is not a route this console answers reads as
// home. A console that threw on a hand-typed hash would be a blank page where a
// wrong URL should be a wrong page.

/** Which page the console is showing. */
export type Route = { page: "home" } | { page: "add" } | { page: "settings" };

export const HOME_ROUTE: Route = { page: "home" };

/** The hash for home: the installs on this machine, and the ways to add one. */
export const HOME_HREF = "#/";

/**
 * The ways to add a local install. The rail's "+ add" goes here rather than
 * straight into a picker, because there is more than one picker to choose from.
 */
export const ADD_ROUTE: Route = { page: "add" };

export const ADD_HREF = "#/add";

/**
 * The console's own settings, behind the gear at the foot of the rail: the
 * console's colours, desktop notifications, what this companion runs on.
 */
export const SETTINGS_ROUTE: Route = { page: "settings" };

export const SETTINGS_HREF = "#/settings";

/** One hash as a route. Everything that is not a page this console has is home. */
export function parseRoute(hash: string): Route {
  const segments = hash
    .replace(/^#/, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments[0] === "add" && segments[1] === undefined) return ADD_ROUTE;
  if (segments[0] === "settings" && segments[1] === undefined) return SETTINGS_ROUTE;
  return HOME_ROUTE;
}
