// The hash router. Total by design: a hash the console does not answer is
// home, never a throw and never a blank screen.

import { describe, expect, test } from "vite-plus/test";
import { ADD_HREF, HOME_HREF, parseRoute, SETTINGS_HREF } from "./route.ts";

describe("parseRoute", () => {
  test("an empty hash, a bare hash and home's own hash are all home", () => {
    for (const hash of ["", "#", "#/", HOME_HREF]) {
      expect(parseRoute(hash), hash).toEqual({ page: "home" });
    }
  });

  test("the add page has an address of its own, so the rail's + add can go there", () => {
    expect(parseRoute(ADD_HREF)).toEqual({ page: "add" });
    expect(parseRoute("#/add/folder")).toEqual({ page: "home" });
  });

  test("the settings page has an address of its own, behind the gear on the rail", () => {
    expect(parseRoute(SETTINGS_HREF)).toEqual({ page: "settings" });
    expect(parseRoute("#/settings/theme")).toEqual({ page: "home" });
  });

  test("a hash that names no route at all is home", () => {
    for (const hash of ["#/nowhere", "#/d/AAAA", "#nonsense"]) {
      expect(parseRoute(hash), hash).toEqual({ page: "home" });
    }
  });
});
