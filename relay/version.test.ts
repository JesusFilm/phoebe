// Where the relay's two numbers come from, and what it says when one of them
// cannot be read.

import { describe, expect, test } from "vite-plus/test";
import { relayPackageVersion, UNKNOWN_VERSION } from "./version.ts";

describe("the relay's own version", () => {
  test("is the version in the package it is running out of", () => {
    expect(relayPackageVersion(() => JSON.stringify({ version: "1.2.3" }))).toBe("1.2.3");
  });

  test("reads the real package.json when nothing is injected", () => {
    expect(relayPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test.each([
    ["a package.json that will not parse", () => "{"],
    ["a package.json with no version", () => JSON.stringify({ name: "phoebe-agent" })],
    ["a package.json with a blank version", () => JSON.stringify({ version: "" })],
    [
      "a package.json that cannot be read at all",
      () => {
        throw new Error("EACCES");
      },
    ],
  ])("is %s away from stopping the relay", (_case, read: () => string) => {
    // A version nobody can read is a line on a screen that reads wrong. It is
    // not a reason to take the fleet's only way in offline.
    expect(relayPackageVersion(read)).toBe(UNKNOWN_VERSION);
  });
});
