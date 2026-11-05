// The selection policy: release age per update type (patch 3, minor 7, major
// 14 days), the skips, the undated rule, and the severity ordering.

import { describe, expect, test } from "vite-plus/test";
import type { Advisory, Candidate } from "./candidate.ts";
import { isMature, overThreshold, selectionReason } from "./policy.ts";

const NOW = new Date("2026-11-05T12:00:00Z");

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: "lodash",
    current: "4.17.20",
    target: "4.17.21",
    updateType: "patch",
    publishedAt: "2026-11-01T12:00:00Z",
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return { id: "GHSA-xxxx-yyyy-zzzz", severity: "moderate", fixedIn: "4.17.21", ...overrides };
}

describe("isMature", () => {
  test.each([
    ["patch", "2026-11-02T12:00:00Z", true],
    ["patch", "2026-11-02T12:00:01Z", false],
    ["minor", "2026-10-29T12:00:00Z", true],
    ["minor", "2026-10-30T00:00:00Z", false],
    ["major", "2026-10-22T12:00:00Z", true],
    ["major", "2026-10-23T00:00:00Z", false],
  ] as const)("a %s published %s is mature: %s", (updateType, publishedAt, mature) => {
    expect(isMature(candidate({ updateType, publishedAt }), NOW)).toBe(mature);
  });

  test("the caller's days replace the defaults", () => {
    const fresh = candidate({ publishedAt: "2026-11-05T00:00:00Z" });
    expect(isMature(fresh, NOW)).toBe(false);
    expect(isMature(fresh, NOW, { patch: 0, minor: 0, major: 0 })).toBe(true);
  });

  test("a lockfile move waits as long as the versions it moves between", () => {
    const tenDaysOld = "2026-10-26T12:00:00Z";
    const lockfile = { updateType: "lockfile", publishedAt: tenDaysOld } as const;
    expect(isMature(candidate({ ...lockfile, current: "1.0.150", target: "1.0.229" }), NOW)).toBe(
      true,
    );
    expect(isMature(candidate({ ...lockfile, current: "1.0.150", target: "1.2.0" }), NOW)).toBe(
      true,
    );
    expect(isMature(candidate({ ...lockfile, current: "0.9.0", target: "1.0.0" }), NOW)).toBe(
      false,
    );
  });

  test("pin and digest name no new version and never wait", () => {
    const today = "2026-11-05T11:00:00Z";
    expect(isMature(candidate({ updateType: "pin", publishedAt: today }), NOW)).toBe(true);
    expect(isMature(candidate({ updateType: "digest", publishedAt: today }), NOW)).toBe(true);
  });

  test("the fix release of an advisory skips the wait, whatever its severity", () => {
    const today = candidate({ updateType: "major", publishedAt: "2026-11-05T11:00:00Z" });
    expect(isMature({ ...today, advisories: [advisory({ severity: "low" })] }, NOW)).toBe(true);
    expect(isMature({ ...today, advisories: [advisory({ fixedIn: "v4.17.21" })] }, NOW)).toBe(true);
  });

  // Review on #771: the wait is what catches a hijacked publish, so an
  // advisory must not carry a release newer than its fix past it.
  test("a release newer than the fix waits like any other", () => {
    const fresh = candidate({
      current: "1.2.4",
      target: "1.2.9",
      publishedAt: "2026-11-05T11:00:00Z",
      advisories: [advisory({ severity: "critical", fixedIn: "1.2.5" })],
    });
    expect(isMature(fresh, NOW)).toBe(false);
    expect(isMature({ ...fresh, publishedAt: "2026-11-01T12:00:00Z" }, NOW)).toBe(true);
    expect(selectionReason(fresh)).toBe("patch update past the 3-day maturity wait");
  });

  test("a pre-release of the fix is not the fix", () => {
    const rc = candidate({
      current: "1.2.4",
      target: "1.2.5-rc.1",
      publishedAt: "2026-11-05T11:00:00Z",
      advisories: [advisory({ fixedIn: "1.2.5" })],
    });
    expect(isMature(rc, NOW)).toBe(false);
  });

  test("an advisory the target does not fix leaves the wait in place", () => {
    const today = candidate({ publishedAt: "2026-11-05T11:00:00Z" });
    expect(isMature({ ...today, advisories: [advisory({ fixedIn: null })] }, NOW)).toBe(false);
    expect(isMature({ ...today, advisories: [advisory({ fixedIn: "4.18.0" })] }, NOW)).toBe(false);
  });

  test("no publish date is proposed at once by default, and held under `undated: hold`", () => {
    const { publishedAt: _, ...undated } = candidate();
    expect(isMature(undated, NOW)).toBe(true);
    expect(isMature(undated, NOW, { patch: 3, minor: 7, major: 14, undated: "hold" })).toBe(false);
  });

  test("an unreadable publish date counts as no publish date", () => {
    const unreadable = candidate({ publishedAt: "yesterday" });
    expect(isMature(unreadable, NOW)).toBe(true);
    expect(isMature(unreadable, NOW, { patch: 3, minor: 7, major: 14, undated: "hold" })).toBe(
      false,
    );
  });
});

describe("selectionReason", () => {
  test("names the wait a candidate cleared", () => {
    expect(selectionReason(candidate({ updateType: "minor" }))).toBe(
      "minor update past the 7-day maturity wait",
    );
  });

  test("names the size a lockfile move waited as", () => {
    expect(
      selectionReason(candidate({ updateType: "lockfile", current: "1.0.150", target: "1.0.229" })),
    ).toBe("lockfile (patch) update past the 3-day maturity wait");
  });

  test("names each skip", () => {
    const { publishedAt: _, ...undated } = candidate();
    expect(selectionReason(undated)).toBe("publish date unknown, so it skips the maturity wait");
    expect(selectionReason(candidate({ updateType: "digest" }))).toBe(
      "digest update; it names no new version, so it skips the maturity wait",
    );
    expect(selectionReason(candidate({ advisories: [advisory()] }))).toBe(
      "fixes GHSA-xxxx-yyyy-zzzz, so it skips the maturity wait",
    );
  });
});

describe("overThreshold", () => {
  test("defaults to high", () => {
    expect(overThreshold(advisory({ severity: "moderate" }))).toBe(false);
    expect(overThreshold(advisory({ severity: "high" }))).toBe(true);
    expect(overThreshold(advisory({ severity: "critical" }))).toBe(true);
  });

  test("orders low, moderate, high, critical", () => {
    expect(overThreshold(advisory({ severity: "low" }), "low")).toBe(true);
    expect(overThreshold(advisory({ severity: "low" }), "moderate")).toBe(false);
    expect(overThreshold(advisory({ severity: "moderate" }), "moderate")).toBe(true);
    expect(overThreshold(advisory({ severity: "high" }), "critical")).toBe(false);
  });
});
