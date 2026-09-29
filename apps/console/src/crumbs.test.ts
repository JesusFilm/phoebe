import { describe, expect, test } from "vite-plus/test";
import { routeCrumbs } from "./crumbs.ts";
import { install } from "./test-fixture.ts";

const base = {
  surface: "companion" as const,
  route: { page: "home" as const },
  open: null,
  view: "console" as const,
  tenant: null,
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

  test("a tenant's config is under its workspace, by the name the rail gives it", () => {
    const workspace = install({ name: "jesusfilm" });
    expect(
      routeCrumbs({ ...base, open: workspace, view: "tenant", child: "JesusFilm/phoebe" }),
    ).toEqual(["This machine", "jesusfilm", "JesusFilm/phoebe", "Config"]);
  });

  test("home with nothing open, and settings by itself", () => {
    expect(routeCrumbs(base)).toEqual(["Home"]);
    expect(routeCrumbs({ ...base, route: { page: "add" } })).toEqual(["Home"]);
    expect(routeCrumbs({ ...base, route: { page: "settings" } })).toEqual(["Settings"]);
    expect(routeCrumbs({ ...base, surface: "browser" })).toEqual(["Home"]);
  });
});
