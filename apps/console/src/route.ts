// Where the console is, as one value read off the URL hash.
//
// The hash, not the path. The bundle is loaded from a custom scheme in the
// companion (#522 §4), and a hash router needs nothing from whatever serves it:
// it works identically off a `file://` document.
//
// Parsing is total: anything that is not a route this console answers reads as
// home. A console that threw on a hand-typed hash would be a blank page where a
// wrong URL should be a wrong page.

import type { DeploymentTab } from "./tabs.ts";

/**
 * Which page the console is showing. A **remote route** is one paired record,
 * by the deployment id it is keyed on (map #690): `#/r/<id>[/<tab>]`. A local
 * install has no hash of its own — the rail opens it in place — so the two do
 * not collide.
 */
export type Route =
  | { page: "home" }
  | { page: "add" }
  | { page: "settings" }
  | { page: "setup" }
  /**
   * `console` is the remote's console (console-view.tsx), `#/r/<id>/console`:
   * the view the rail opens, as it opens a local install's; the tabbed page
   * is behind the gear, as a local install's is. `tenant` is a workspace
   * child's slug, `#/r/<id>/console/<slug>`: the console on that tenant's
   * lines, as a local workspace child's row opens it.
   */
  | {
      page: "remote";
      deploymentId: string;
      tab: DeploymentTab | null;
      console?: true;
      tenant?: string;
    };

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

/** The hash for one remote route, and optionally one of its tabs. */
export function remoteHref(deploymentId: string, tab?: DeploymentTab): string {
  return `#/r/${encodeURIComponent(deploymentId)}${tab === undefined ? "" : `/${tab}`}`;
}

/** The hash for one remote's console, or for the console on one of its tenants. */
export function remoteConsoleHref(deploymentId: string, tenant?: string): string {
  return `#/r/${encodeURIComponent(deploymentId)}/console${
    tenant === undefined ? "" : `/${encodeURIComponent(tenant)}`
  }`;
}

const TABS: readonly string[] = ["overview", "pipelines", "doctor", "secrets", "config"];
const CONSOLE = "console";
/**
 * Setting up this machine (setup-page.tsx): what Docker needs and the buttons
 * that get it there. Where the companion opens when Docker is not ready.
 */
export const SETUP_ROUTE: Route = { page: "setup" };

export const SETUP_HREF = "#/setup";

/** One hash as a route. Everything that is not a page this console has is home. */
export function parseRoute(hash: string): Route {
  const segments = hash
    .replace(/^#/, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments[0] === "add" && segments[1] === undefined) return ADD_ROUTE;
  if (segments[0] === "settings" && segments[1] === undefined) return SETTINGS_ROUTE;
  if (segments[0] === "r" && segments[1] !== undefined) {
    const tab = segments[2];
    const deploymentId = decodeURIComponent(segments[1]);
    if (tab === CONSOLE && segments[4] === undefined) {
      const tenant = segments[3];
      return {
        page: "remote",
        deploymentId,
        tab: null,
        console: true,
        ...(tenant === undefined ? {} : { tenant: decodeURIComponent(tenant) }),
      };
    }
    if (segments[3] !== undefined) return HOME_ROUTE;
    if (tab !== undefined && !TABS.includes(tab)) return HOME_ROUTE;
    return {
      page: "remote",
      deploymentId,
      tab: tab === undefined ? null : (tab as DeploymentTab),
    };
  }
  if (segments[0] === "setup" && segments[1] === undefined) return SETUP_ROUTE;
  return HOME_ROUTE;
}
