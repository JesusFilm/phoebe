// The options block: defaults for nothing at all, each field's validation,
// and the refusal of an unknown key at every level.

import { describe, expect, test } from "vite-plus/test";
import {
  DEPENDENCY_UPDATES_OPTION_DEFAULTS,
  everyMs,
  resolveDependencyUpdatesOptions as resolve,
} from "./options.ts";

const at = "kinds.dependency-updates";

describe("resolveDependencyUpdatesOptions", () => {
  test("no block and an empty block are the defaults", () => {
    expect(resolve(undefined, at)).toEqual(DEPENDENCY_UPDATES_OPTION_DEFAULTS);
    expect(resolve({}, at)).toEqual(DEPENDENCY_UPDATES_OPTION_DEFAULTS);
    expect(DEPENDENCY_UPDATES_OPTION_DEFAULTS).toMatchObject({
      every: "1d",
      sources: ["native", "agent", "renovate"],
      maturity: { patch: 3, minor: 7, major: 14, undated: "propose" },
      grouping: { strategy: { prod: "by-relation", dev: "all" }, groups: [] },
      majors: "individual",
      label: "phoebe:dependencies",
      prConcurrentLimit: 5,
      bootstrapperPin: "skip",
    });
  });

  test("every field takes a value of its own", () => {
    expect(
      resolve(
        {
          every: "12h",
          sources: ["renovate", "native"],
          ignore: ["@types/*"],
          maturity: { minor: 3, undated: "hold" },
          minSeverity: "critical",
          grouping: { strategy: "individual", groups: [{ pattern: "eslint*", group: "lint" }] },
          majors: "follow-strategy",
          label: "deps",
          prConcurrentLimit: 0,
          bootstrapperPin: "propose",
        },
        at,
      ),
    ).toEqual({
      every: "12h",
      sources: ["renovate", "native"],
      ignore: ["@types/*"],
      maturity: { patch: 3, minor: 3, major: 14, undated: "hold" },
      minSeverity: "critical",
      grouping: {
        strategy: { prod: "individual", dev: "individual" },
        groups: [{ pattern: "eslint*", group: "lint" }],
      },
      majors: "follow-strategy",
      label: "deps",
      prConcurrentLimit: 0,
      bootstrapperPin: "propose",
    });
  });

  test("a strategy per side keeps the other side's default", () => {
    expect(
      resolve({ grouping: { strategy: { dev: "by-workspace" } } }, at).grouping.strategy,
    ).toEqual({ prod: "by-relation", dev: "by-workspace" });
  });

  test.each([
    [{ evry: "1d" }, "kinds.dependency-updates: unknown option `evry`"],
    [{ bootstrapperPin: true }, "`bootstrapperPin` must be one of skip, propose"],
    [{ every: "daily" }, "`every` must be a period"],
    [{ every: "0h" }, "`every` must be a period"],
    [{ sources: [] }, "`sources` must be a non-empty array"],
    [{ sources: ["native", "dependabot"] }, "`sources[]` must be one of native, agent, renovate"],
    [{ sources: ["agent", "agent"] }, "`sources` lists agent twice"],
    [{ ignore: [""] }, "`ignore` must be an array"],
    [
      { maturity: { patch: -1 } },
      "kinds.dependency-updates.maturity: `patch` must be a non-negative",
    ],
    [{ maturity: { weeks: 1 } }, "kinds.dependency-updates.maturity: unknown option `weeks`"],
    [{ maturity: { undated: "wait" } }, "`undated` must be one of propose, hold"],
    [{ minSeverity: "severe" }, "`minSeverity` must be one of low, moderate, high, critical"],
    [{ grouping: { strategy: "by-scope" } }, "`strategy` must be one of individual"],
    [{ grouping: { strategy: { test: "all" } } }, "unknown option `test`"],
    [
      { grouping: { groups: [{ pattern: "x" }] } },
      "`groups` must be an array of { pattern, group }",
    ],
    [{ majors: "grouped" }, "`majors` must be one of individual, follow-strategy"],
    [{ label: " " }, "`label` must be a non-empty string"],
    [{ prConcurrentLimit: 1.5 }, "`prConcurrentLimit` must be a non-negative integer"],
  ])("refuses %j", (block, message) => {
    expect(() => resolve(block, at)).toThrow(message);
  });

  test("a block that is not an object is refused", () => {
    expect(() => resolve(["native"], at)).toThrow("options must be an object");
  });
});

describe("everyMs", () => {
  test("reads each unit", () => {
    expect(everyMs("30s")).toBe(30_000);
    expect(everyMs("90m")).toBe(5_400_000);
    expect(everyMs("1h")).toBe(3_600_000);
    expect(everyMs("1d")).toBe(86_400_000);
    expect(everyMs("2w")).toBe(1_209_600_000);
  });
});
