// The hash router. Total by design: a hash the console does not answer is the
// fleet page, never a throw and never a blank screen.

import { describe, expect, test } from "vite-plus/test";
import { deploymentHref, parseRoute } from "./route.ts";

describe("parseRoute", () => {
  test("an empty hash, a bare hash and the fleet hash are all the fleet", () => {
    for (const hash of ["", "#", "#/", "#/fleet"]) {
      expect(parseRoute(hash), hash).toEqual({ page: "fleet" });
    }
  });

  test("a deployment with no tab is its overview", () => {
    expect(parseRoute("#/d/AAAA")).toEqual({
      page: "deployment",
      fingerprint: "AAAA",
      tab: "overview",
    });
  });

  test("each tab the console has round-trips through its own href", () => {
    for (const tab of ["overview", "pipelines", "doctor"] as const) {
      expect(parseRoute(deploymentHref("AAAA", tab)), tab).toEqual({
        page: "deployment",
        fingerprint: "AAAA",
        tab,
      });
    }
  });

  test("the secrets tab is a route of its own (#550)", () => {
    expect(parseRoute("#/d/AAAA/secrets")).toMatchObject({
      page: "deployment",
      fingerprint: "AAAA",
      tab: "secrets",
    });
  });

  test("the config tab is a route of its own (#545, #547)", () => {
    expect(parseRoute("#/d/AAAA/config")).toMatchObject({
      page: "deployment",
      fingerprint: "AAAA",
      tab: "config",
    });
  });

  test("a tab this console does not have lands on the overview, not on nothing", () => {
    // An operator following a link from a newer console gets the deployment
    // rather than a blank page.
    expect(parseRoute("#/d/AAAA/history")).toMatchObject({
      page: "deployment",
      fingerprint: "AAAA",
      tab: "overview",
    });
  });

  test("a fingerprint survives being a URL", () => {
    const fingerprint = "a/b+c=";
    expect(parseRoute(deploymentHref(fingerprint))).toMatchObject({ fingerprint });
  });

  test("a hash that names no route at all is the fleet", () => {
    for (const hash of ["#/people", "#/d", "#/d/", "#nonsense"]) {
      expect(parseRoute(hash), hash).toEqual({ page: "fleet" });
    }
  });
});

describe("deploymentHref", () => {
  test("overview is the bare deployment URL, so one deployment has one address", () => {
    expect(deploymentHref("AAAA")).toBe("#/d/AAAA");
    expect(deploymentHref("AAAA", "overview")).toBe("#/d/AAAA");
  });

  test("every other tab hangs off it", () => {
    expect(deploymentHref("AAAA", "doctor")).toBe("#/d/AAAA/doctor");
  });
});
