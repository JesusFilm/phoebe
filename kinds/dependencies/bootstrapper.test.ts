// Which candidates count as the bootstrapper pin, and what each mode keeps.

import { describe, expect, test } from "vite-plus/test";
import { isBootstrapperPin, withoutBootstrapperPin } from "./bootstrapper.ts";
import type { Candidate } from "./candidate.ts";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "dockerfile",
    package: "phoebe-agent",
    current: "0.7.1",
    target: "0.16.0",
    updateType: "minor",
    depType: "prod",
    workspace: "container/Dockerfile",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

describe("isBootstrapperPin", () => {
  test.each([
    ["Renovate's dockerfile manager", { workspace: "anywhere" }],
    ["this repo's template", { workspace: "templates/container/Dockerfile" }],
    ["a consumer's scaffold", { workspace: "container/Dockerfile" }],
    ["another manager name on a Dockerfile", { manager: "docker", workspace: "Dockerfile" }],
    ["a suffixed Dockerfile", { manager: "docker", workspace: "ops/Dockerfile.prod" }],
    ["a Containerfile", { manager: "docker", workspace: "Containerfile" }],
    ["a .dockerfile", { manager: "docker", workspace: "ops/phoebe.dockerfile" }],
  ])("%s is the pin", (_name, overrides) => {
    expect(isBootstrapperPin(candidate(overrides))).toBe(true);
  });

  test.each([
    ["phoebe-agent in a package.json", { manager: "npm", workspace: "package.json" }],
    ["another package in the Dockerfile", { package: "renovate" }],
    ["a directory named like a Dockerfile", { manager: "docker", workspace: "Dockerfile/x.json" }],
  ])("%s is not", (_name, overrides) => {
    expect(isBootstrapperPin(candidate(overrides))).toBe(false);
  });
});

describe("withoutBootstrapperPin", () => {
  const list = [candidate(), candidate({ package: "renovate" })];

  test("skip drops the pin and counts it", () => {
    const { kept, skipped } = withoutBootstrapperPin(list, "skip");
    expect(kept.map((c) => c.package)).toEqual(["renovate"]);
    expect(skipped).toBe(1);
  });

  test("propose keeps everything", () => {
    expect(withoutBootstrapperPin(list, "propose")).toEqual({ kept: list, skipped: 0 });
  });
});
