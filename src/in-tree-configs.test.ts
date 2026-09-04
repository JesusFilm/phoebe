// Repo-governance guard: no config in this repo declares a deprecated field
// (#419).
//
// The dogfood configs, the examples, and the scaffold template are the four
// things a reader copies from. A deprecated field left in one of them teaches
// the shape we are moving away from, and — for the two dogfood configs — prints
// a deprecation warning on every load of the deployment that works this repo.
//
// Sibling of deployment-prompts.test.ts: same reason for living under `src/`
// (test files never ship) and the same shape — a list at the top, so a new
// config or a new alias is one line here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { DEPRECATED_PIPELINE_ALIASES, deprecatedPipelineAliases } from "./config-schema.ts";
import { loadUserConfig } from "./load-config.ts";

const repoRoot = join(import.meta.dirname, "..");

/** Every config in this repo that loads as a real config. */
const LOADABLE_CONFIGS = [
  "phoebe.config.ts",
  ".phoebe/phoebe.config.ts",
  "examples/solo/phoebe.config.ts",
  "examples/custom-kind/phoebe.config.ts",
  "examples/workspace/phoebe.config.ts",
  "examples/workspace/widget/phoebe.config.ts",
  "examples/workspace/gadget/phoebe.config.ts",
] as const;

/**
 * Templates carry unrendered `{{TOKEN}}` placeholders, so they are read as text
 * rather than imported. A field name appearing anywhere in one is enough to
 * fail: a commented-out example of a deprecated field is still a teaching copy.
 */
const TEMPLATE_CONFIGS = ["templates/phoebe.config.ts", "templates/phoebe.config.workspace.ts"];

describe.each(LOADABLE_CONFIGS)("%s", (relPath) => {
  test("declares no deprecated top-level work fields", async () => {
    const user = await loadUserConfig(join(repoRoot, relPath));
    expect(deprecatedPipelineAliases(user)).toEqual([]);
  });
});

describe.each(TEMPLATE_CONFIGS)("%s", (relPath) => {
  test("scaffolds no deprecated top-level work fields", () => {
    const source = readFileSync(join(repoRoot, relPath), "utf8");
    for (const { alias } of DEPRECATED_PIPELINE_ALIASES) {
      expect(source, `${relPath} mentions ${alias}`).not.toContain(alias);
    }
  });
});
