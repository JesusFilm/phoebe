// The options block: the defaults an empty block gets, and the errors a bad
// field raises, each naming its config path.

import { describe, expect, test } from "vite-plus/test";
import {
  DEPENDENCY_SECURITY_OPTION_DEFAULTS,
  resolveDependencySecurityOptions,
} from "./options.ts";

const at = "kinds.dependency-security";

describe("resolveDependencySecurityOptions", () => {
  test("no block, or an empty one, is the hourly detector over native and agent", () => {
    expect(resolveDependencySecurityOptions(undefined, at)).toEqual(
      DEPENDENCY_SECURITY_OPTION_DEFAULTS,
    );
    expect(resolveDependencySecurityOptions({}, at)).toEqual({
      every: "1h",
      sources: ["native", "agent"],
      minSeverity: { prod: "high", dev: "critical" },
      label: "phoebe:dependencies",
      prConcurrentLimit: 5,
      bootstrapperPin: "skip",
    });
  });

  test("a full block is taken as given", () => {
    expect(
      resolveDependencySecurityOptions(
        {
          every: "30m",
          sources: ["renovate", "native"],
          minSeverity: "critical",
          label: "deps",
          prConcurrentLimit: 0,
          bootstrapperPin: "propose",
        },
        at,
      ),
    ).toEqual({
      every: "30m",
      sources: ["renovate", "native"],
      minSeverity: { prod: "critical", dev: "critical" },
      label: "deps",
      prConcurrentLimit: 0,
      bootstrapperPin: "propose",
    });
  });

  test("minSeverity takes one severity for both sides, or a side of its own", () => {
    const min = (value: unknown) =>
      resolveDependencySecurityOptions({ minSeverity: value }, at).minSeverity;
    expect(min("moderate")).toEqual({ prod: "moderate", dev: "moderate" });
    expect(min({ dev: "high" })).toEqual({ prod: "high", dev: "high" });
    expect(min({ prod: "low" })).toEqual({ prod: "low", dev: "critical" });
    expect(min({})).toEqual({ prod: "high", dev: "critical" });
  });

  test.each([
    ["not an object", "kinds.dependency-security: the dependency-security kind's options must be"],
    [{ every: "hourly" }, "kinds.dependency-security: `every` must be a period"],
    [{ sources: [] }, "kinds.dependency-security: `sources` must be a non-empty array"],
    [{ minSeverity: "severe" }, "kinds.dependency-security: `minSeverity` must be one of"],
    [{ minSeverity: 3 }, "kinds.dependency-security: `minSeverity` must be one of"],
    [
      { minSeverity: { dev: "severe" } },
      "kinds.dependency-security.minSeverity: `dev` must be one of low, moderate, high, critical",
    ],
    [
      { minSeverity: { test: "high" } },
      "kinds.dependency-security.minSeverity: unknown option `test`",
    ],
    [{ label: " " }, "kinds.dependency-security: `label` must be a non-empty string"],
    [{ label: "security" }, 'label must not be "security"'],
    [{ label: "dependencies" }, 'label must not be "dependencies"'],
    [{ bootstrapperPin: "bundle" }, "kinds.dependency-security: `bootstrapperPin` must be one of"],
    [
      { prConcurrentLimit: -1 },
      "kinds.dependency-security: `prConcurrentLimit` must be a non-negative integer",
    ],
    [{ ignore: ["lodash"] }, "kinds.dependency-security: unknown option `ignore`"],
  ])("%j fails", (block, message) => {
    expect(() => resolveDependencySecurityOptions(block, at)).toThrow(message);
  });
});
