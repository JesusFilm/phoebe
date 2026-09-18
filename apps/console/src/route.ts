// Where the console is, as one value read off the URL hash.
//
// The hash, not the path. The bundle is served from the relay's root and from a
// custom scheme in the companion (#522 §4), and the relay deliberately serves no
// single-page fallback — a path it has no file for stays a JSON `no-such-route`
// (relay/console-assets.ts). A path router would need that fallback; a hash
// router needs nothing from the server at all, and it works identically off a
// `file://` document.
//
// Parsing is total: anything that is not a route this console answers reads as
// the fleet. A console that threw on a hand-typed hash would be a blank page
// where a wrong URL should be a wrong page.

/** The tabs a deployment has today. `config` is #545. */
export const DEPLOYMENT_TABS = ["overview", "pipelines", "doctor", "secrets"] as const;

export type DeploymentTab = (typeof DEPLOYMENT_TABS)[number];

/** Which page the console is showing. */
export type Route =
  | { page: "fleet" }
  | { page: "deployment"; fingerprint: string; tab: DeploymentTab };

export const FLEET_ROUTE: Route = { page: "fleet" };

/** The hash for the fleet page. */
export const FLEET_HREF = "#/fleet";

/**
 * The hash for one deployment's tab. Overview is the bare deployment URL rather
 * than `/overview`, so the link the rail carries and the link an operator copies
 * out of the address bar are the same string.
 */
export function deploymentHref(fingerprint: string, tab: DeploymentTab = "overview"): string {
  const base = `#/d/${encodeURIComponent(fingerprint)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/**
 * One hash as a route. `#/d/<fingerprint>` and `#/d/<fingerprint>/<tab>` are the
 * only shapes with anything in them; everything else — `#`, `#/fleet`, a typo, a
 * fingerprint with no deployment behind it — is the fleet.
 *
 * A fingerprint naming no deployment still parses: whether that row exists is
 * the page's question to answer, not the parser's, and the page can say "no such
 * deployment" only if it is handed one to look for.
 */
export function parseRoute(hash: string): Route {
  const segments = hash
    .replace(/^#/, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments[0] !== "d" || segments[1] === undefined) return FLEET_ROUTE;
  const fingerprint = decodeURIComponent(segments[1]);
  if (fingerprint === "") return FLEET_ROUTE;
  const asked = segments[2];
  const tab = DEPLOYMENT_TABS.find((candidate) => candidate === asked) ?? "overview";
  return { page: "deployment", fingerprint, tab };
}
