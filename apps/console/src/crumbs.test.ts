import { describe, expect, test } from "vite-plus/test";
import { routeCrumbs } from "./crumbs.ts";
import { rowFacts } from "./facts.ts";
import { install, row } from "./test-fixture.ts";

const base = {
  surface: "companion" as const,
  route: { page: "fleet" as const },
  open: null,
  view: "console" as const,
  tenant: null,
  facts: [rowFacts(row({ fingerprint: "abc", name: "youtube-studio" }), null)],
  signedIn: true,
};

describe("where the console is, for the pane's top line", () => {
  test("an open install is under This machine, on its console or its settings", () => {
    const one = install({ name: "Studio" });
    expect(routeCrumbs({ ...base, open: one })).toEqual(["This machine", "Studio", "Console"]);
    expect(routeCrumbs({ ...base, open: one, view: "settings" })).toEqual([
      "This machine",
      "Studio",
      "Settings",
    ]);
    expect(routeCrumbs({ ...base, open: one, tenant: "JesusFilm/phoebe" })).toEqual([
      "This machine",
      "Studio",
      "phoebe",
    ]);
  });

  test("the relay's pages are under Relay in the companion, bare in a browser", () => {
    expect(routeCrumbs(base)).toEqual(["Relay", "Fleet"]);
    expect(routeCrumbs({ ...base, route: { page: "people" } })).toEqual(["Relay", "People"]);
    expect(
      routeCrumbs({ ...base, route: { page: "deployment", fingerprint: "abc", tab: "doctor" } }),
    ).toEqual(["Relay", "youtube-studio", "doctor"]);
    expect(
      routeCrumbs({ ...base, route: { page: "deployment", fingerprint: "zzz", tab: "overview" } }),
    ).toEqual(["Relay", "zzz", "overview"]);
    expect(routeCrumbs({ ...base, surface: "browser" })).toEqual(["Fleet"]);
  });

  test("home when signed out or asked for, and settings by itself", () => {
    expect(routeCrumbs({ ...base, signedIn: false })).toEqual(["Home"]);
    expect(routeCrumbs({ ...base, route: { page: "add" } })).toEqual(["Home"]);
    expect(routeCrumbs({ ...base, route: { page: "settings" } })).toEqual(["Settings"]);
    expect(routeCrumbs({ ...base, surface: "browser", signedIn: false })).toEqual(["Fleet"]);
  });
});
