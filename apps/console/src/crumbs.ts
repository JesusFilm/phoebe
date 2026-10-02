// The line at the top of the right pane: where the console is, as T3 Code puts
// the project and thread at the top of its pane.
//
// Read off what the app already holds — the route, the open install and which
// of its views is up — rather than kept anywhere. The rail is the map; this is
// the "you are here" on it, and it changes when the rail's selection does.

import type { LocalInstall } from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import type { RowFacts } from "./facts.ts";
import type { Route } from "./route.ts";

export type Crumbs = readonly string[];

export function routeCrumbs(input: {
  surface: Surface;
  route: Route;
  /** The local install whose page is open, if one is. */
  open: LocalInstall | null;
  /** Which of the open install's views is up. */
  view: "console" | "settings";
  /** A workspace child the console was opened on, by slug. */
  tenant: string | null;
  /** The relay's rows, for a deployment's name. */
  facts: readonly RowFacts[];
  /** Whether a relay session is held; without one the companion is on its home. */
  signedIn: boolean;
}): Crumbs {
  const { surface, route, open, view, tenant, facts, signedIn } = input;
  if (open !== null) {
    if (view === "settings") return ["This machine", open.name, "Settings"];
    return ["This machine", open.name, tenant === null ? "Console" : tenant.split("/").pop()!];
  }
  if (route.page === "settings") return ["Settings"];
  if (surface === "companion" && (!signedIn || route.page === "add")) return ["Home"];
  const relay = surface === "companion" ? ["Relay"] : [];
  switch (route.page) {
    case "people":
      return [...relay, "People"];
    case "deployment": {
      const row = facts.find((facts) => facts.row.fingerprint === route.fingerprint);
      return [...relay, row?.row.name ?? route.fingerprint, route.tab];
    }
    case "add":
      return ["Home"];
    case "fleet":
      return [...relay, "Fleet"];
  }
}
