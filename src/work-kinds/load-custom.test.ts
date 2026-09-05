// Custom-kind loading (#350): the three declaration arms resolve to
// definitions — inline as-is, path modules via dynamic import (default export,
// plain or factory), wrappers carrying `options` — and the boot step assembles
// the registry from them.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeUserConfig } from "../config-schema.ts";
import type { AnyWorkKindDefinition } from "./definition.ts";
import { createWorkKindRegistry, loadCustomKinds } from "./load-custom.ts";

function userConfig(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

/** A minimal valid inline definition. */
function inlineDefinition(name: string): AnyWorkKindDefinition {
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

/** The same definition, as JS module source (plain-object default export). */
const PLAIN_MODULE_SOURCE = `export default {
  name: "nudge",
  oneShotEligible: true,
  promptFile: "prompts/custom.md",
  workspace: "worktree",
  report: { noun: "thing(s)", describe: (unit) => unit.ref },
  fetch: () => Promise.resolve([]),
  select: () => ({ unit: null, skipped: [], total: 0 }),
  run: () => Promise.resolve(),
};
`;

/** A factory module — the built-ins' own shape — baking config values in. */
const FACTORY_MODULE_SOURCE = `export default (config) => ({
  name: "nudge",
  oneShotEligible: true,
  promptFile: "prompts/custom.md",
  workspace: "worktree",
  report: { noun: config.readyLabel + " nudge(s)", describe: (unit) => unit.ref },
  fetch: () => Promise.resolve([]),
  select: () => ({ unit: null, skipped: [], total: 0 }),
  run: () => Promise.resolve(),
});
`;

function moduleDir(source: string, fileName = "nudge.mjs"): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-kind-module-"));
  writeFileSync(join(dir, fileName), source);
  return dir;
}

describe("loadCustomKinds", () => {
  test("an inline definition passes through as-is, with no options", async () => {
    const definition = inlineDefinition("nudge");
    const config = resolveConfig(userConfig({ workKinds: { nudge: definition } }));
    const loaded = await loadCustomKinds(config, "/nowhere");
    expect(loaded).toEqual([{ name: "nudge", definition, options: undefined }]);
  });

  test("a path-string entry imports the module's default export", async () => {
    const dir = moduleDir(PLAIN_MODULE_SOURCE);
    const config = resolveConfig(userConfig({ workKinds: { nudge: "./nudge.mjs" } }));
    const loaded = await loadCustomKinds(config, dir);
    expect(loaded[0]?.definition.report.noun).toBe("thing(s)");
    expect(loaded[0]?.options).toBeUndefined();
  });

  test("a factory default export is invoked with the resolved config", async () => {
    const dir = moduleDir(FACTORY_MODULE_SOURCE);
    const config = resolveConfig(
      userConfig({ readyLabel: "needs-robot", workKinds: { nudge: "./nudge.mjs" } }),
    );
    const loaded = await loadCustomKinds(config, dir);
    expect(loaded[0]?.definition.report.noun).toBe("needs-robot nudge(s)");
  });

  test("a module block's extra root fields arrive as the kind's options", async () => {
    const dir = moduleDir(PLAIN_MODULE_SOURCE);
    const config = resolveConfig(
      userConfig({
        workKinds: { nudge: { module: "./nudge.mjs", staleDays: 7, effort: "low" } },
      }),
    );
    const loaded = await loadCustomKinds(config, dir);
    // The knobs are the engine's; only the rest reaches the kind.
    expect(loaded[0]?.options).toEqual({ staleDays: 7 });
  });

  test("a module block with no extra fields yields undefined options", async () => {
    const dir = moduleDir(PLAIN_MODULE_SOURCE);
    const config = resolveConfig(userConfig({ workKinds: { nudge: { module: "./nudge.mjs" } } }));
    const loaded = await loadCustomKinds(config, dir);
    expect(loaded[0]?.options).toBeUndefined();
  });

  test("a missing module is a boot error naming the entry and both paths", async () => {
    const dir = moduleDir(PLAIN_MODULE_SOURCE);
    const config = resolveConfig(userConfig({ workKinds: { nudge: "./missing.mjs" } }));
    await expect(loadCustomKinds(config, dir)).rejects.toThrow(
      /kinds\.nudge: failed to load kind module \.\/missing\.mjs/,
    );
  });

  test("a module without a default export is a boot error", async () => {
    const dir = moduleDir(`export const notDefault = 1;\n`);
    const config = resolveConfig(userConfig({ workKinds: { nudge: "./nudge.mjs" } }));
    await expect(loadCustomKinds(config, dir)).rejects.toThrow(/must `export default`/);
  });
});

describe("built-in replacement modules (#465)", () => {
  const ISSUES_MODULE_SOURCE = PLAIN_MODULE_SOURCE.replace('name: "nudge"', 'name: "issues"');

  test("a built-in path-string entry loads the replacement into its slot", async () => {
    const dir = moduleDir(ISSUES_MODULE_SOURCE, "issues.mjs");
    const config = resolveConfig(userConfig({ workKinds: { issues: "./issues.mjs" } }));
    const registry = await createWorkKindRegistry(config, dir);
    expect(registry.get("issues")?.definition.report.noun).toBe("thing(s)");
    expect([...registry.keys()]).toContain("conflicts");
  });

  test("a built-in module block's root options reach the registry, knobs excluded", async () => {
    const dir = moduleDir(ISSUES_MODULE_SOURCE, "issues.mjs");
    const config = resolveConfig(
      userConfig({ workKinds: { issues: { module: "./issues.mjs", max: 3, effort: "low" } } }),
    );
    const registry = await createWorkKindRegistry(config, dir);
    expect(registry.get("issues")?.options).toEqual({ max: 3 });
  });

  test("a replacement whose definition names another kind is a boot error", async () => {
    const dir = moduleDir(PLAIN_MODULE_SOURCE, "issues.mjs");
    const config = resolveConfig(userConfig({ workKinds: { issues: "./issues.mjs" } }));
    await expect(createWorkKindRegistry(config, dir)).rejects.toThrow(
      /kinds\.issues: its definition names itself "nudge", not "issues"/,
    );
  });

  test("a built-in block without a module keeps the shipped definition", async () => {
    const config = resolveConfig(userConfig({ workKinds: { issues: { effort: "low" } } }));
    const registry = await createWorkKindRegistry(config, "/nowhere");
    expect(registry.get("issues")?.definition.report.noun).toMatch(/issue/);
  });
});

describe("createWorkKindRegistry", () => {
  test("assembles built-ins plus customs and validates the lot", async () => {
    const config = resolveConfig(
      userConfig({
        workOrder: ["issues", "nudge"],
        workKinds: { nudge: inlineDefinition("nudge") },
      }),
    );
    const registry = await createWorkKindRegistry(config, "/nowhere");
    expect(registry.has("issues")).toBe(true);
    expect(registry.has("nudge")).toBe(true);
  });

  test("stays quiet about a kind missing from the order — it still runs (#415)", async () => {
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
    try {
      const config = resolveConfig(userConfig({ workKinds: { nudge: inlineDefinition("nudge") } }));
      await createWorkKindRegistry(config, "/nowhere");
    } finally {
      console.warn = originalWarn;
    }
    expect(warned).toEqual([]);
  });
});
