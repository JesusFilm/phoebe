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
      minSeverity: "high",
      label: "phoebe:dependencies",
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
          bootstrapperPin: "propose",
        },
        at,
      ),
    ).toEqual({
      every: "30m",
      sources: ["renovate", "native"],
      minSeverity: "critical",
      label: "deps",
      bootstrapperPin: "propose",
    });
  });

  test.each([
    ["not an object", "kinds.dependency-security: the dependency-security kind's options must be"],
    [{ every: "hourly" }, "kinds.dependency-security: `every` must be a period"],
    [{ sources: [] }, "kinds.dependency-security: `sources` must be a non-empty array"],
    [{ minSeverity: "severe" }, "kinds.dependency-security: `minSeverity` must be one of"],
    [{ label: " " }, "kinds.dependency-security: `label` must be a non-empty string"],
    [{ label: "security" }, 'label must not be "security"'],
    [{ label: "dependencies" }, 'label must not be "dependencies"'],
    [{ bootstrapperPin: "bundle" }, "kinds.dependency-security: `bootstrapperPin` must be one of"],
    [{ prConcurrentLimit: 5 }, "kinds.dependency-security: unknown option `prConcurrentLimit`"],
  ])("%j fails", (block, message) => {
    expect(() => resolveDependencySecurityOptions(block, at)).toThrow(message);
  });
});
