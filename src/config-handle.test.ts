// Tests for the parser-based config-edit substrate.
//
// Contracts:
//   * resolveConfigObject supports all scaffolded and documented config forms.
//   * All refusals in the closed set have one fixture test each.
//   * Two refusals are "silent failure" cases — they must be tests, not prose:
//     spread in the object (naive read returns undefined → duplicate key on write)
//     shorthand property (naive read returns identifier text, not the value)
//   * editConfigAppendWorkKind edits the real workOrder, ignoring comments.
//   * editConfigMoveField relocates a field's source range — comments inside it
//     included — and refuses anything computed or spread rather than moving it.
//   * editConfigGetField / setField / removeField have happy-path coverage.
//   * ConfigRefusal is detected by isConfigRefusal; plain Record is not.
//   * configHandle delegates to the edit functions.

import { describe, expect, test } from "vite-plus/test";
import {
  ConfigRefusal,
  REASON_WORKORDER_NOT_FOUND,
  configHandle,
  editConfigAppendWorkKind,
  editConfigGetField,
  editConfigListKeys,
  editConfigMoveField,
  editConfigRemoveField,
  editConfigSetField,
  isConfigRefusal,
  workKindInstruction,
} from "./config-handle.ts";

// ------------------------------------------------------------------ fixtures

/** Standard multi-line config in the templates/examples form. */
const MINIMAL = (extra = ""): string =>
  `import type { PhoebeUserConfig } from "phoebe-agent";\n\nconst config: PhoebeUserConfig = {\n  repoSlug: "acme/test",\n  repoUrl: "https://github.com/acme/test.git",\n  installCommand: "npm ci",\n  checkCommand: "npm run check",\n  testCommand: "npm test",${extra}\n};\n\nexport default config;\n`;

// ------------------------------------------------------------------ supported config forms

describe("resolveConfigObject — supported forms", () => {
  test("const + type annotation + export default (templates/examples form)", () => {
    const content = MINIMAL(`\n  workOrder: ["checks"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
  });

  test("const config = defineConfig({...}); export default config", () => {
    const content = `const config = defineConfig({\n  repoSlug: "x/y",\n  workOrder: ["checks"],\n});\nexport default config;\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
  });

  test("export default defineConfig({...})", () => {
    const content = `export default defineConfig({\n  repoSlug: "x/y",\n  workOrder: ["checks"],\n});\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
  });

  test("inline export default {}", () => {
    const content = `export default {\n  repoSlug: "x/y",\n  workOrder: ["checks"],\n};\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
  });

  test("satisfies annotation on the expression", () => {
    const content = `import type { PhoebeUserConfig } from "phoebe-agent";\nconst config = {\n  repoSlug: "x/y",\n  workOrder: ["checks"],\n} satisfies PhoebeUserConfig;\nexport default config;\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
  });

  test("as annotation on the expression", () => {
    const content = `import type { PhoebeUserConfig } from "phoebe-agent";\nconst config = {\n  repoSlug: "x/y",\n  workOrder: ["checks"],\n} as PhoebeUserConfig;\nexport default config;\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
  });

  test("Pick<> type annotation (workspace template form)", () => {
    const content = `import type { PhoebeUserConfig } from "phoebe-agent";\nconst config: Pick<PhoebeUserConfig, "engine" | "workspace"> = {\n  engine: { source: "github", ref: "main" },\n  workspace: { depth: 1 },\n};\nexport default config;\n`;
    const result = editConfigGetField(content, "engine");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found).toBe(true);
  });

  test("let instead of const", () => {
    const content = `let config = {\n  repoSlug: "x/y",\n  workOrder: ["checks"],\n};\nexport default config;\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
  });

  test("quoted string key", () => {
    const content = `const config = {\n  "repoSlug": "x/y",\n  workOrder: ["checks"],\n};\nexport default config;\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found).toBe(true);
  });

  test("file with other top-level declarations (enums, interfaces) is supported", () => {
    const content = `import type { PhoebeUserConfig } from "phoebe-agent";\n\ninterface Extra { x: number; }\n\nconst config: PhoebeUserConfig = {\n  repoSlug: "x/y",\n  workOrder: ["checks"],\n};\n\nexport default config;\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
  });

  test("export const config = {...}; export default config", () => {
    const content = `export const config = {\n  repoSlug: "x/y",\n  workOrder: ["checks"],\n};\nexport default config;\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('"research"');
  });

  test("moveField delegates to editConfigMoveField (smoke test)", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts"],`);
    const result = configHandle.moveField(content, ["workOrder"], ["pipelines", "work", "order"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`order: ["conflicts"]`);
    expect(configHandle.listKeys(result.content, ["pipelines", "work"])).toEqual({
      ok: true,
      found: true,
      keys: ["order"],
    });
  });
});

// ------------------------------------------------------------------ closed refusal set

describe("refusal set — spread in the config object (silent failure case)", () => {
  test("refuses when config object contains a spread element", () => {
    // Silent failure: a key present via the spread reads as undefined, so a
    // naive migration would add a duplicate key. The parser catches this.
    const content = `const BASE = { installCommand: "npm ci" };\nconst config = { ...BASE, repoSlug: "x/y" };\nexport default config;\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(false);
  });

  test("refuses appendWorkKind when config object contains a spread element", () => {
    const content = `const BASE = { repoSlug: "x/y" };\nconst config = { ...BASE, workOrder: ["checks"] };\nexport default config;\n`;
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
  });
});

describe("refusal set — shorthand property (silent failure case)", () => {
  test("setField refuses a shorthand property (value is the identifier, not a literal)", () => {
    // Silent failure: reading a shorthand returns the identifier name as text,
    // not the runtime value. The parser catches this via prop.shorthand.
    const content = `const repoSlug = "x/y";\nconst config = { repoSlug };\nexport default config;\n`;
    const result = editConfigSetField(content, "repoSlug", "new-org/repo");
    expect(result.ok).toBe(false);
  });

  test("getField on a shorthand property returns raw source (identifier text)", () => {
    const content = `const repoSlug = "x/y";\nconst config = { repoSlug };\nexport default config;\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found).toBe(true);
    if (!result.found) return;
    // The raw value is the identifier name "repoSlug" — a non-literal
    expect(result.raw).toBe("repoSlug");
    expect(result.literal).toBeUndefined();
  });
});

describe("refusal set — export { default } from", () => {
  test("refuses when the module re-exports default from another module", () => {
    // `export { default } from "..."` is an ExportNamedDeclaration, not
    // ExportDefaultDeclaration, so there is no local default export to resolve.
    const content = `export { default } from "./other-config.ts";\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no default export");
  });
});

describe("refusal set — defineConfig(reference)", () => {
  test("refuses when defineConfig receives a variable reference, not an inline object", () => {
    const content = `const OPTS = { repoSlug: "x/y" };\nconst config = defineConfig(OPTS);\nexport default config;\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not an inline object literal");
  });
});

describe("refusal set — conditional default export", () => {
  test("refuses a ternary default export", () => {
    const content = `const a = { repoSlug: "x" };\nconst b = { repoSlug: "y" };\nexport default process.env.CI ? a : b;\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not a plain object literal");
  });
});

describe("refusal set — no default export", () => {
  test("refuses when there is no default export and no named config export", () => {
    // A completely unexported local variable — neither `export default` nor
    // `export const config = ...` — is refused.
    const content = `const myConfig = { repoSlug: "x/y" };\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no default export");
  });
});

describe("refusal set — computed key", () => {
  test("refuses when config object has a computed key", () => {
    const content = `const key = "repoSlug";\nconst config = { [key]: "x/y" };\nexport default config;\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("computed key");
  });
});

describe("refusal set — duplicate keys", () => {
  test("refuses when config object has duplicate keys", () => {
    const content = `const config = {\n  repoSlug: "x/y",\n  repoSlug: "a/b",\n};\nexport default config;\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("duplicate key");
  });
});

describe("refusal set — non-literal value (for writes)", () => {
  test("getField returns raw source text for a non-literal value (readable for detection)", () => {
    const content = `const config = {\n  testCommand: process.env.TEST || "npm test",\n};\nexport default config;\n`;
    const result = editConfigGetField(content, "testCommand");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.literal).toBeUndefined();
    expect(result.raw).toContain("process.env");
  });

  test("setField refuses to overwrite a non-literal value", () => {
    const content = `const config = {\n  testCommand: process.env.TEST || "npm test",\n};\nexport default config;\n`;
    const result = editConfigSetField(content, "testCommand", "npm test");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("non-literal");
  });
});

describe("refusal set — config.x = ... mutation after the literal", () => {
  test("refuses when the config variable is mutated after its declaration", () => {
    const content = `const config = { repoSlug: "x/y" };\nconfig.workOrder = ["issues"];\nexport default config;\n`;
    const result = editConfigGetField(content, "repoSlug");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("mutated");
  });
});

// ------------------------------------------------------------------ appendWorkKind — happy paths

describe("editConfigAppendWorkKind — single-line arrays", () => {
  test("appends to a non-empty array (no trailing comma)", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts", "checks"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`workOrder: ["conflicts", "checks", "research"]`);
    expect(result.content).toContain("repoSlug");
    expect(result.content).toContain("npm ci");
  });

  test("appends to an array with trailing comma", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts",],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`workOrder: ["conflicts", "research",]`);
  });

  test("appends to an empty array", () => {
    const content = MINIMAL(`\n  workOrder: [],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`workOrder: ["research"]`);
  });

  test("returns ok=true unchanged when kind already present (double quotes)", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts", "research"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(content);
  });

  test("does not duplicate kind on second call", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts"],`);
    const first = editConfigAppendWorkKind(content, "research");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = editConfigAppendWorkKind(first.content, "research");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.content).toBe(first.content);
  });
});

describe("editConfigAppendWorkKind — multi-line arrays", () => {
  test("appends with trailing-comma style", () => {
    const content = MINIMAL(`\n  workOrder: [\n    "conflicts",\n    "checks",\n  ],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('[\n    "conflicts",\n    "checks",\n    "research",\n  ]');
  });

  test("appends without trailing-comma style", () => {
    const content = MINIMAL(`\n  workOrder: [\n    "conflicts",\n    "checks"\n  ],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('"research"');
    expect(result.content).toContain('"checks",');
  });

  test("returns ok=true unchanged when kind already present in multi-line array", () => {
    const content = MINIMAL(
      `\n  workOrder: [\n    "conflicts",\n    "research",\n    "checks",\n  ],`,
    );
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(content);
  });
});

describe("editConfigAppendWorkKind — commented-out workOrder", () => {
  test("edits the real array, not the commented-out one", () => {
    // The regex substrate matched inside // comment blocks; the parser does not.
    const content = [
      `import type { PhoebeUserConfig } from "phoebe-agent";`,
      ``,
      `// Example config (do not edit this block):`,
      `// const example = {`,
      `//   workOrder: ["issue", "conflict"],`,
      `// };`,
      ``,
      `const config: PhoebeUserConfig = {`,
      `  repoSlug: "x/y",`,
      `  workOrder: ["issue", "checks"],`,
      `};`,
      ``,
      `export default config;`,
      ``,
    ].join("\n");

    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The comment block is untouched byte-for-byte
    expect(result.content).toContain(`//   workOrder: ["issue", "conflict"],`);

    // The real array was edited
    expect(result.content).toContain(`workOrder: ["issue", "checks", "research"]`);

    // The commented-out array was NOT edited (still has original text)
    expect(result.content).not.toContain(`workOrder: ["issue", "conflict", "research"]`);
  });
});

describe("editConfigAppendWorkKind — refusals", () => {
  test("refuses when workOrder is absent (REASON_WORKORDER_NOT_FOUND)", () => {
    const content = MINIMAL();
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(REASON_WORKORDER_NOT_FOUND);
  });

  test("refuses when workOrder is a computed value (not an array literal)", () => {
    const content = MINIMAL(`\n  workOrder: computeOrder(),`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
  });

  test("refuses when workOrder array contains a spread element", () => {
    const content = MINIMAL(`\n  workOrder: [...BASE_ORDER, "checks"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("spread");
  });

  test("refuses when workOrder array contains a variable element", () => {
    const content = MINIMAL(`\n  workOrder: [EXTRA_KIND, "checks"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("non-literal");
  });

  test("refused result carries a non-empty reason string", () => {
    const content = MINIMAL(`\n  workOrder: [...BASE, "x"],`);
    const result = editConfigAppendWorkKind(content, "research");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ getField

describe("editConfigGetField", () => {
  test("returns found=false when the key is absent", () => {
    const result = editConfigGetField(MINIMAL(), "workOrder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found).toBe(false);
  });

  test("returns a string literal value", () => {
    const result = editConfigGetField(MINIMAL(), "repoSlug");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.literal).toBe("acme/test");
    expect(result.raw).toBe(`"acme/test"`);
  });

  test("returns raw source for a non-literal value", () => {
    const content = `const config = { testCommand: process.env.TEST ?? "npm test" };\nexport default config;\n`;
    const result = editConfigGetField(content, "testCommand");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.literal).toBeUndefined();
    expect(result.raw).toContain("process.env");
  });
});

// ------------------------------------------------------------------ setField

describe("editConfigSetField", () => {
  test("overwrites an existing string literal", () => {
    const content = MINIMAL();
    const result = editConfigSetField(content, "checkCommand", "pnpm run check");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`checkCommand: "pnpm run check"`);
    expect(result.content).toContain("repoSlug");
  });

  test("inserts a new field into a multi-line object", () => {
    const content = MINIMAL();
    const result = editConfigSetField(content, "readyCommand", "pnpm run ready");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`readyCommand: "pnpm run ready"`);
    // Other fields unchanged
    expect(result.content).toContain(`repoSlug: "acme/test"`);
  });

  test("refuses to overwrite a shorthand property", () => {
    // `{ repoSlug }` is a shorthand: the value node is the identifier itself.
    const shorthand = `const repoSlug = "x/y";\nconst config = { repoSlug };\nexport default config;\n`;
    const result = editConfigSetField(shorthand, "repoSlug", "new/repo");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("shorthand");
  });
});

// ------------------------------------------------------------------ removeField

describe("editConfigRemoveField", () => {
  test("removes an existing field from a multi-line object", () => {
    const content = MINIMAL(`\n  workOrder: ["checks"],`);
    const result = editConfigRemoveField(content, "workOrder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain("workOrder");
    expect(result.content).toContain("repoSlug");
    expect(result.content).toContain("testCommand");
  });

  test("returns ok=true unchanged when key is absent", () => {
    const content = MINIMAL();
    const result = editConfigRemoveField(content, "workOrder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(content);
  });

  test("removes first property when object brace and property share a line", () => {
    // repoSlug and the opening brace are on the same line — the multiline
    // whole-line path must not delete the brace and everything before it.
    const content = `const config = { repoSlug: "x/y",\n  workOrder: ["checks"],\n};\nexport default config;\n`;
    const result = editConfigRemoveField(content, "repoSlug");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain("repoSlug");
    expect(result.content).toContain("workOrder");
    expect(result.content).toContain("const config");
  });
});

// ------------------------------------------------------------------ ConfigRefusal and isConfigRefusal

describe("ConfigRefusal and isConfigRefusal", () => {
  test("isConfigRefusal returns true for ConfigRefusal instance", () => {
    const refusal = new ConfigRefusal("add it by hand");
    expect(isConfigRefusal(refusal)).toBe(true);
  });

  test("isConfigRefusal returns false for a plain Record", () => {
    const writes: Record<string, string> = { "phoebe.config.ts": "content" };
    expect(isConfigRefusal(writes)).toBe(false);
  });

  test("isConfigRefusal returns false for empty Record", () => {
    expect(isConfigRefusal({})).toBe(false);
  });

  test("ConfigRefusal carries the instruction string", () => {
    const instr = "add research to workOrder";
    const r = new ConfigRefusal(instr);
    expect(r.instruction).toBe(instr);
  });
});

// ------------------------------------------------------------------ workKindInstruction

describe("workKindInstruction", () => {
  test("includes the kind name and file reference", () => {
    const instr = workKindInstruction("research");
    expect(instr).toContain("research");
    expect(instr).toContain("phoebe.config.ts");
  });
});

// ------------------------------------------------------------------ configHandle

describe("configHandle", () => {
  test("appendWorkKind delegates to editConfigAppendWorkKind (smoke test)", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts"],`);
    const result = configHandle.appendWorkKind(content, "research");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('"research"');
  });

  test("moveField delegates to editConfigMoveField (smoke test)", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts"],`);
    const result = configHandle.moveField(content, ["workOrder"], ["pipelines", "work", "order"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(`order: ["conflicts"]`);
    expect(configHandle.listKeys(result.content, ["pipelines", "work"])).toEqual({
      ok: true,
      found: true,
      keys: ["order"],
    });
  });

  test("there is no workspace or tenant method on the handle (shape check)", () => {
    expect("editWorkspace" in configHandle).toBe(false);
    expect("editTenants" in configHandle).toBe(false);
    expect("addTenant" in configHandle).toBe(false);
    expect("removeTenant" in configHandle).toBe(false);
    expect("reorderTenants" in configHandle).toBe(false);
  });
});

// ------------------------------------------------------------------ moveField

describe("editConfigMoveField", () => {
  test("creates the destination blocks and leaves every other byte alone", () => {
    const content = MINIMAL(`\n  workOrder: ["conflicts", "checks"],`);
    const result = editConfigMoveField(content, ["workOrder"], ["pipelines", "work", "order"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain(
      [
        `  pipelines: {`,
        `    work: {`,
        `      order: ["conflicts", "checks"],`,
        `    },`,
        `  },`,
      ].join("\n"),
    );
    expect(result.content).not.toContain("workOrder");
    // Untouched: the import, the five required fields, the export.
    expect(result.content).toContain(`import type { PhoebeUserConfig } from "phoebe-agent";`);
    expect(result.content).toContain(`  testCommand: "npm test",`);
    expect(result.content).toContain(`export default config;`);
  });

  test("comments inside the moved range travel with it, reindented", () => {
    const content = MINIMAL(
      [
        ``,
        `  workKinds: {`,
        `    // conflicts is the expensive one.`,
        `    conflicts: { effort: "high" },`,
        `  },`,
      ].join("\n"),
    );
    const result = editConfigMoveField(content, ["workKinds"], ["pipelines", "work", "kinds"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(
      [
        `      kinds: {`,
        `        // conflicts is the expensive one.`,
        `        conflicts: { effort: "high" },`,
        `      },`,
      ].join("\n"),
    );
  });

  test("folds a nested field into an existing nested block", () => {
    const moved = editConfigMoveField(
      MINIMAL(
        [
          ``,
          `  workKinds: {`,
          `    issues: { effort: "high" },`,
          `  },`,
          `  promptFiles: {`,
          `    issue: "prompts/mine.md",`,
          `  },`,
        ].join("\n"),
      ),
      ["workKinds"],
      ["pipelines", "work", "kinds"],
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const folded = editConfigMoveField(
      moved.content,
      ["promptFiles", "issue"],
      ["pipelines", "work", "kinds", "issues", "promptFile"],
    );
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.content).toContain(
      `        issues: { effort: "high", promptFile: "prompts/mine.md" },`,
    );
  });

  test("creates the kind block when the destination kind has no entry yet", () => {
    const content = MINIMAL(`\n  promptFiles: {\n    issue: "prompts/mine.md",\n  },`);
    const result = editConfigMoveField(
      content,
      ["promptFiles", "issue"],
      ["pipelines", "work", "kinds", "issues", "promptFile"],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(
      [
        `  pipelines: {`,
        `    work: {`,
        `      kinds: {`,
        `        issues: {`,
        `          promptFile: "prompts/mine.md",`,
        `        },`,
        `      },`,
        `    },`,
        `  },`,
      ].join("\n"),
    );
  });

  test("the migrated config re-parses, so moves compose", () => {
    let content = MINIMAL(
      [
        ``,
        `  workOrder: ["checks"],`,
        `  workKinds: {`,
        `    checks: { effort: "low" },`,
        `  },`,
      ].join("\n"),
    );
    for (const [from, to] of [
      [["workOrder"], ["pipelines", "work", "order"]],
      [["workKinds"], ["pipelines", "work", "kinds"]],
    ] as const) {
      const step = editConfigMoveField(content, from, to);
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      content = step.content;
    }
    expect(content).toContain(`      order: ["checks"],`);
    expect(content).toContain(`      kinds: {`);
    const pipelines = editConfigGetField(content, "pipelines");
    expect(pipelines.ok && pipelines.found).toBe(true);
  });
});

describe("editConfigMoveField — refusals", () => {
  const refuse = (extra: string, from: readonly string[] = ["workKinds"]): string => {
    const result = editConfigMoveField(MINIMAL(extra), from, ["pipelines", "work", "kinds"]);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  };

  test("refuses a spread inside the moved value", () => {
    expect(refuse(`\n  workKinds: { ...BASE_KINDS, issues: { effort: "high" } },`)).toContain(
      "spread",
    );
  });

  test("refuses a reference as the moved value", () => {
    expect(refuse(`\n  workKinds: KIND_TUNING,`)).toContain("computed value");
  });

  test("refuses a call expression nested in the moved value", () => {
    expect(refuse(`\n  workKinds: { issues: tune("high") },`)).toContain("computed value");
  });

  test("refuses a template literal nested in the moved value", () => {
    expect(refuse("\n  workKinds: { issues: { promptFile: `${DIR}/p.md` } },")).toContain(
      "computed value",
    );
  });

  test("refuses a computed key inside the moved value", () => {
    expect(refuse(`\n  workKinds: { [kindName]: { effort: "high" } },`)).toContain("computed key");
  });

  test("refuses a shorthand property inside the moved value", () => {
    expect(refuse(`\n  workKinds: { issues },`)).toContain("shorthand");
  });

  test("refuses when the field is absent", () => {
    expect(refuse(``)).toContain("not found");
  });

  test("refuses when the destination already exists", () => {
    const content = MINIMAL(
      [
        ``,
        `  workKinds: { issues: { effort: "high" } },`,
        `  pipelines: {`,
        `    work: {`,
        `      kinds: { checks: { effort: "low" } },`,
        `    },`,
        `  },`,
      ].join("\n"),
    );
    const result = editConfigMoveField(content, ["workKinds"], ["pipelines", "work", "kinds"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("already exists");
  });

  test("refuses when an intermediate on the path is not an object literal", () => {
    const content = MINIMAL(
      `\n  workKinds: { issues: { effort: "high" } },\n  pipelines: build(),`,
    );
    const result = editConfigMoveField(content, ["workKinds"], ["pipelines", "work", "kinds"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not a plain object literal");
  });
});

// ------------------------------------------------------------------ listKeys

describe("editConfigListKeys", () => {
  test("lists a nested block's keys in source order", () => {
    const content = MINIMAL(`\n  promptFiles: {\n    issue: "a.md",\n    conflict: "b.md",\n  },`);
    const result = editConfigListKeys(content, ["promptFiles"]);
    expect(result).toEqual({ ok: true, found: true, keys: ["issue", "conflict"] });
  });

  test("distinguishes an absent block from an empty one", () => {
    expect(editConfigListKeys(MINIMAL(), ["promptFiles"])).toEqual({ ok: true, found: false });
    expect(editConfigListKeys(MINIMAL(`\n  promptFiles: {},`), ["promptFiles"])).toEqual({
      ok: true,
      found: true,
      keys: [],
    });
  });

  test("refuses a block that is not an object literal", () => {
    const result = editConfigListKeys(MINIMAL(`\n  promptFiles: loadPrompts(),`), ["promptFiles"]);
    expect(result.ok).toBe(false);
  });
});
