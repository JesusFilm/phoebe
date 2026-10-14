// The two reads of `prScope` that the filter itself does not do (#655): one
// kind's value off the ladder, and the union the shared listing needs.

import { describe, expect, test } from "vite-plus/test";
import type { WorkKindsField } from "./config-schema.ts";
import { admittedPrefixes, resolvePrScopeForKind, widestPrScope } from "./pr-scope.ts";

const forKind = (opts: {
  kind?: string;
  env?: NodeJS.ProcessEnv;
  workKinds?: WorkKindsField;
  configValue?: Parameters<typeof resolvePrScopeForKind>[0]["configValue"];
}) =>
  resolvePrScopeForKind({
    kind: opts.kind ?? "checks",
    env: opts.env ?? {},
    workKinds: opts.workKinds ?? {},
    configValue: opts.configValue ?? "phoebe",
  });

describe("admittedPrefixes", () => {
  test('"phoebe" is sugar for the branch prefix', () => {
    expect(admittedPrefixes("phoebe", "phoebe/")).toEqual(["phoebe/"]);
  });

  test('"all" is bounded by no prefix at all', () => {
    expect(admittedPrefixes("all", "phoebe/")).toBeNull();
  });

  test("a list is itself, whatever the branch prefix is", () => {
    expect(admittedPrefixes(["renovate/"], "phoebe/")).toEqual(["renovate/"]);
    expect(admittedPrefixes([], "phoebe/")).toEqual([]);
  });
});

describe("one kind's prScope", () => {
  test("a kind with no block inherits the tenant's value", () => {
    expect(forKind({ configValue: "all" })).toBe("all");
    expect(forKind({ configValue: ["renovate/"] })).toEqual(["renovate/"]);
  });

  test("the kind's own block overrides the tenant's value for that kind alone", () => {
    const workKinds: WorkKindsField = { checks: { prScope: ["renovate/"] } };
    expect(forKind({ kind: "checks", workKinds })).toEqual(["renovate/"]);
    expect(forKind({ kind: "conflicts", workKinds })).toBe("phoebe");
    expect(forKind({ kind: "reviews", workKinds })).toBe("phoebe");
  });

  test("the per-kind env name beats the kind's block, and takes the enum only", () => {
    const workKinds: WorkKindsField = { checks: { prScope: ["renovate/"] } };
    expect(forKind({ workKinds, env: { PHOEBE_CHECKS_PR_SCOPE: "all" } })).toBe("all");
    // Not one of the two enum values, so it is not an answer and the block stands.
    expect(forKind({ workKinds, env: { PHOEBE_CHECKS_PR_SCOPE: "renovate/" } })).toEqual([
      "renovate/",
    ]);
  });
});

describe("the union the shared listing filters on", () => {
  test('"all" anywhere makes the listing every PR', () => {
    expect(widestPrScope(["phoebe", "all"], "phoebe/")).toBe("all");
  });

  test("prefixes are unioned, with the tenant's own desugared", () => {
    expect(widestPrScope(["phoebe", ["renovate/"]], "phoebe/")).toEqual(["phoebe/", "renovate/"]);
  });

  test("a prefix two scopes share is listed once", () => {
    expect(widestPrScope([["renovate/"], ["renovate/"]], "phoebe/")).toEqual(["renovate/"]);
  });

  test("every scope empty admits nothing, so the listing filters everything out", () => {
    expect(widestPrScope([[], []], "phoebe/")).toEqual([]);
  });
});
