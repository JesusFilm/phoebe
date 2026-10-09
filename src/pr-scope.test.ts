// The `prScope` vocabulary (#656): what a scope admits, how one kind's scope
// resolves, and the widest scope the shared listing runs on.

import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PrScope, type WorkKindsField } from "./config-schema.ts";
import {
  PR_SCAN_KIND_NAMES,
  prScanListingScope,
  prScopeAdmits,
  prScopePrefixes,
  resolvePrScopeForKind,
} from "./pr-scope.ts";

const BRANCH_PREFIX = "phoebe/";

const admits = (scope: PrScope, branch: string): boolean =>
  prScopeAdmits(scope, branch, BRANCH_PREFIX);

describe("what a scope admits", () => {
  test('"phoebe" is sugar for the branch prefix', () => {
    expect(prScopePrefixes("phoebe", BRANCH_PREFIX)).toEqual([BRANCH_PREFIX]);
    expect(admits("phoebe", "phoebe/issue-1")).toBe(true);
    expect(admits("phoebe", "renovate/npm-vite")).toBe(false);
  });

  test('"all" admits every branch', () => {
    expect(prScopePrefixes("all", BRANCH_PREFIX)).toBe("all");
    expect(admits("all", "renovate/npm-vite")).toBe(true);
  });

  test("a list is the literal set of admitted prefixes", () => {
    expect(admits(["renovate/"], "renovate/npm-vite")).toBe(true);
    expect(admits(["renovate/"], "phoebe/issue-1")).toBe(false);
    expect(admits(["renovate/", BRANCH_PREFIX], "phoebe/issue-1")).toBe(true);
  });

  test("the empty list admits nothing", () => {
    expect(admits([], "phoebe/issue-1")).toBe(false);
    expect(admits([], "renovate/npm-vite")).toBe(false);
  });

  test("a prefix matches the way `branchPrefix` does — leading, not anywhere", () => {
    expect(admits(["renovate/"], "fix/renovate/npm-vite")).toBe(false);
    // Not a path component either: a prefix is a string, as it always was.
    expect(admits(["renov"], "renovate/npm-vite")).toBe(true);
  });
});

describe("one kind's scope", () => {
  const forKind = (opts: {
    kind?: string;
    env?: NodeJS.ProcessEnv;
    workKinds?: WorkKindsField;
    configValue?: PrScope;
  }): PrScope =>
    resolvePrScopeForKind({
      kind: opts.kind ?? "checks",
      env: opts.env ?? {},
      workKinds: opts.workKinds ?? {},
      configValue: opts.configValue ?? "phoebe",
    });

  test("inherits the tenant value when the kind says nothing", () => {
    expect(forKind({ configValue: ["renovate/"] })).toEqual(["renovate/"]);
  });

  test("the kind's block overrides the tenant value for that kind alone", () => {
    const workKinds: WorkKindsField = { checks: { prScope: ["renovate/"] } };
    expect(forKind({ kind: "checks", workKinds })).toEqual(["renovate/"]);
    expect(forKind({ kind: "conflicts", workKinds })).toBe("phoebe");
    expect(forKind({ kind: "reviews", workKinds })).toBe("phoebe");
  });

  test("the per-kind env var beats the kind's block", () => {
    expect(
      forKind({
        env: { PHOEBE_CHECKS_PR_SCOPE: "all" },
        workKinds: { checks: { prScope: ["renovate/"] } },
      }),
    ).toBe("all");
  });

  test("another kind's env var is not heard", () => {
    expect(forKind({ kind: "reviews", env: { PHOEBE_CHECKS_PR_SCOPE: "all" } })).toBe("phoebe");
  });

  test("the env channel is enum-only, and says so", () => {
    expect(() => forKind({ env: { PHOEBE_CHECKS_PR_SCOPE: "renovate/" } })).toThrow(
      /PHOEBE_CHECKS_PR_SCOPE must be one of phoebe, all.*config-file value/s,
    );
  });

  test("a blank env value reads as unset", () => {
    expect(forKind({ env: { PHOEBE_CHECKS_PR_SCOPE: "" }, configValue: "all" })).toBe("all");
  });
});

describe("the listing's scope", () => {
  const config = (over: Partial<Parameters<typeof resolveConfig>[0]> = {}) =>
    resolveConfig({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      ...over,
    });

  test("one tenant value, and the listing is that value's prefixes", () => {
    expect(prScanListingScope({ env: {}, config: config() })).toEqual([BRANCH_PREFIX]);
  });

  test("a kind that widens widens the listing, not the other kinds", () => {
    const scope = prScanListingScope({
      env: {},
      config: config({ workKinds: { checks: { prScope: ["renovate/"] } } }),
    });
    expect(scope).toEqual([BRANCH_PREFIX, "renovate/"]);
    expect(
      resolvePrScopeForKind({
        kind: "conflicts",
        env: {},
        workKinds: { checks: { prScope: ["renovate/"] } },
        configValue: "phoebe",
      }),
    ).toBe("phoebe");
  });

  test('one "all" anywhere makes the listing "all"', () => {
    expect(
      prScanListingScope({
        env: { PHOEBE_REVIEWS_PR_SCOPE: "all" },
        config: config({ prScope: ["renovate/"] }),
      }),
    ).toBe("all");
  });

  test("every janitor on the empty list lists nothing", () => {
    expect(prScanListingScope({ env: {}, config: config({ prScope: [] }) })).toEqual([]);
  });

  test("the scanning kinds are the three janitors", () => {
    expect([...PR_SCAN_KIND_NAMES]).toEqual(["conflicts", "checks", "reviews"]);
  });
});
