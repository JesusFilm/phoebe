// Smoke test: the vendored @babel/parser bundle resolves, exports `parse`, and
// can handle the TypeScript syntax present in this repo's config files.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { parse } from "./babel-parser.mjs";

const TEMPLATE_CONFIG = readFileSync(
  fileURLToPath(new URL("../../../templates/phoebe.config.ts", import.meta.url)),
  "utf8",
);

describe("vendored babel-parser bundle", () => {
  test("parse is a function", () => {
    expect(typeof parse).toBe("function");
  });

  test("parses templates/phoebe.config.ts without errors", () => {
    const ast = parse(TEMPLATE_CONFIG, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    expect(ast.type).toBe("File");
    expect(ast.errors).toHaveLength(0);
  });

  test("parses a type-annotated const declaration", () => {
    const src = `import type { PhoebeUserConfig } from "phoebe-agent";
const config: PhoebeUserConfig = { repoSlug: "x/y" };
export default config;`;
    const ast = parse(src, { sourceType: "module", plugins: ["typescript"] });
    expect(ast.type).toBe("File");
    expect(ast.errors).toHaveLength(0);
  });

  test("parses defineConfig call expression", () => {
    const src = `export const config = defineConfig({ repoSlug: "x/y" });
export default config;`;
    const ast = parse(src, { sourceType: "module", plugins: ["typescript"] });
    expect(ast.type).toBe("File");
    expect(ast.errors).toHaveLength(0);
  });

  test("AST carries position data on nodes", () => {
    const src = `const x = "hello";`;
    const ast = parse(src, { sourceType: "module", plugins: ["typescript"] });
    const stmt = ast.program.body[0];
    expect(stmt).toBeDefined();
    expect(typeof stmt!.start).toBe("number");
    expect(typeof stmt!.end).toBe("number");
  });
});
