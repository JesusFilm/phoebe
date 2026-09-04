// Registry assembly (#303/#348): the five built-ins register under exactly the
// closed names, custom kinds join them indistinguishably, and every definition
// — built-in or not — passes the same validation.

import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, WORK_KIND_NAMES, type PhoebeUserConfig } from "../config-schema.ts";
import type { AnyWorkKindDefinition } from "./definition.ts";
import { buildRegistry } from "./registry.ts";
import { validateWorkKindDefinition } from "./validate.ts";

function testConfig(overrides: Partial<PhoebeUserConfig> = {}) {
  return resolveConfig({
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  });
}

/** A minimal, valid custom definition. */
function customDefinition(name: string): AnyWorkKindDefinition {
  return {
    name,
    oneShotEligible: true,
    promptFile: "prompts/custom.md",
    workspace: "worktree",
    report: { noun: "thing(s)", describe: (unit: { ref: string }) => unit.ref },
    fetch: () => Promise.resolve([]),
    select: () => ({ unit: null, skipped: [], total: 0 }),
    run: () => Promise.resolve(),
  };
}

describe("buildRegistry", () => {
  test("registers exactly the built-in names, pinned to WORK_KIND_NAMES", () => {
    const registry = buildRegistry(testConfig());
    expect([...registry.keys()].sort()).toEqual([...WORK_KIND_NAMES].sort());
  });

  test("built-in definitions bake this tenant's config in", () => {
    const registry = buildRegistry(
      testConfig({
        readyLabel: "needs-robot",
        promptFiles: { issue: "prompts/my-issues.md" },
      }),
    );
    const issues = registry.get("issues")!.definition;
    expect(issues.report.noun).toBe("needs-robot issue(s)");
    expect(issues.promptFile).toBe("prompts/my-issues.md");
  });

  test("a custom kind registers beside the built-ins, carrying its options", () => {
    const options = { channel: "C123" };
    const registry = buildRegistry(testConfig(), [
      { name: "nudge", definition: customDefinition("nudge"), options },
    ]);
    expect(registry.get("nudge")?.definition.report.noun).toBe("thing(s)");
    expect(registry.get("nudge")?.options).toBe(options);
    // Built-ins carry no options.
    expect(registry.get("issues")?.options).toBeUndefined();
  });

  test("a custom kind colliding with a built-in name is a boot error", () => {
    expect(() =>
      buildRegistry(testConfig(), [
        { name: "issues", definition: customDefinition("issues"), options: undefined },
      ]),
    ).toThrow(/collides with a built-in/);
  });

  test("a definition whose name differs from its declaration key is a boot error", () => {
    expect(() =>
      buildRegistry(testConfig(), [
        { name: "nudge", definition: customDefinition("other"), options: undefined },
      ]),
    ).toThrow(/must match its declaration key/);
  });

  test("custom definitions are validated with a config-path voice", () => {
    const broken = { ...customDefinition("nudge"), run: "not a function" };
    expect(() =>
      buildRegistry(testConfig(), [
        {
          name: "nudge",
          definition: broken as unknown as AnyWorkKindDefinition,
          options: undefined,
        },
      ]),
    ).toThrow(/workKinds\.custom\.nudge: .*`run` must be a function/);
  });
});

describe("validateWorkKindDefinition", () => {
  test("accepts a complete definition", () => {
    expect(() => validateWorkKindDefinition(customDefinition("ok"), "at")).not.toThrow();
  });

  test.each(["scratch", "readonly"])("accepts the %s workspace mode", (mode) => {
    const definition = { ...customDefinition("ok"), workspace: mode };
    expect(() => validateWorkKindDefinition(definition, "at")).not.toThrow();
  });

  test.each([
    ["name", { name: "" }, /`name` must be a non-empty string/],
    ["oneShotEligible", { oneShotEligible: "yes" }, /`oneShotEligible` must be a boolean/],
    ["promptFile", { promptFile: "  " }, /`promptFile` must be a non-empty path/],
    ["workspace", { workspace: "none" }, /`workspace` must be one of: worktree, scratch, readonly/],
    ["model", { model: 3 }, /`model` must be a string/],
    ["report", { report: null }, /`report` must be an object/],
    ["fetch", { fetch: undefined }, /`fetch` must be a function/],
    ["select", { select: 7 }, /`select` must be a function/],
  ])("rejects a bad %s", (_field, patch, message) => {
    const candidate = { ...customDefinition("x"), ...patch };
    expect(() => validateWorkKindDefinition(candidate, "workKinds.custom.x")).toThrow(message);
    expect(() => validateWorkKindDefinition(candidate, "workKinds.custom.x")).toThrow(
      /^workKinds\.custom\.x:/,
    );
  });

  test("rejects a report without a describe function", () => {
    const candidate = { ...customDefinition("x"), report: { noun: "thing(s)" } };
    expect(() => validateWorkKindDefinition(candidate, "at")).toThrow(
      /`report\.describe` must be a function/,
    );
  });
});

describe("declared keys reach validation through registry assembly (#425)", () => {
  test("a custom kind naming a GH_APP_* key in agentEnv fails to register", () => {
    expect(() =>
      buildRegistry(testConfig(), [
        {
          name: "nudge",
          definition: {
            ...customDefinition("nudge"),
            requiredEnv: ["GH_APP_PRIVATE_KEY"],
            agentEnv: ["GH_APP_PRIVATE_KEY"],
          },
          options: undefined,
        },
      ]),
    ).toThrow(/reserved key `GH_APP_PRIVATE_KEY`/);
  });

  test("the tenant's own provider key name is reserved, not the shipped default", () => {
    const config = testConfig({ providerEnv: { claude: "MY_CLAUDE_KEY" } });
    const declaring = (key: string) => [
      {
        name: "nudge",
        definition: { ...customDefinition("nudge"), requiredEnv: [key] },
        options: undefined,
      },
    ];
    expect(() => buildRegistry(config, declaring("MY_CLAUDE_KEY"))).toThrow(/MY_CLAUDE_KEY/);
    expect(() => buildRegistry(config, declaring("ANTHROPIC_API_KEY"))).not.toThrow();
  });

  test("a valid declaration registers and keeps both fields", () => {
    const registry = buildRegistry(testConfig(), [
      {
        name: "nudge",
        definition: {
          ...customDefinition("nudge"),
          requiredEnv: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
          agentEnv: ["SLACK_BOT_TOKEN"],
        },
        options: undefined,
      },
    ]);
    expect(registry.get("nudge")?.definition.agentEnv).toEqual(["SLACK_BOT_TOKEN"]);
  });
});
