import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
// Plain-JS bootstrapper module (see materialize.mjs for why the bootstrap slice
// can't be TypeScript). Imported untyped into this .ts test.
import { engineDir, ensureEngine } from "./materialize.mjs";

// A throwaway "installed package" laid out like the published tarball: the
// TypeScript bootstrapper + engine plus the scaffold resources init reads.
function makeFakePackage(root: string): void {
  mkdirSync(join(root, "bootstrap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "templates", "container"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "bootstrap", "cli.ts"), "export const entry = 0;\n");
  writeFileSync(join(root, "src", "cli.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "src", "main.ts"), "export const y = 2;\n");
  writeFileSync(join(root, "templates", "container", "Dockerfile"), "FROM node:24\n");
  writeFileSync(join(root, "prompts", "issues-prompt.md"), "# prompt\n");
}

describe("ensureEngine", () => {
  let base: string;
  let pkg: string;

  beforeEach(() => {
    base = join(tmpdir(), `phoebe-materialize-test-${process.pid}-${process.hrtime.bigint()}`);
    pkg = join(base, "pkg");
    mkdirSync(base, { recursive: true });
    makeFakePackage(pkg);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("copies the package subtrees outside node_modules and returns the entry path", () => {
    const entry = ensureEngine({ packageRoot: pkg, baseDir: base, version: "1.2.3" });

    const dir = engineDir(base, "1.2.3");
    // The bin execs the TypeScript bootstrapper, not the engine directly.
    expect(entry).toBe(join(dir, "bootstrap", "cli.ts"));
    // bootstrap + src + the scaffold resources init needs are all materialized.
    expect(existsSync(join(dir, "bootstrap", "cli.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "cli.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "main.ts"))).toBe(true);
    expect(existsSync(join(dir, "templates", "container", "Dockerfile"))).toBe(true);
    expect(existsSync(join(dir, "prompts", "issues-prompt.md"))).toBe(true);
    // An ESM package.json is written so the copied `.ts` loads as a module.
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toEqual({ type: "module" });
  });

  test("is idempotent — a second call does not re-copy over a materialized dir", () => {
    ensureEngine({ packageRoot: pkg, baseDir: base, version: "1.2.3" });

    // Mutate the materialized copy, then call again: the marker makes it a no-op,
    // so our edit survives (proving no re-copy from the source package).
    const copied = join(engineDir(base, "1.2.3"), "bootstrap", "cli.ts");
    writeFileSync(copied, "export const edited = true;\n");
    ensureEngine({ packageRoot: pkg, baseDir: base, version: "1.2.3" });

    expect(readFileSync(copied, "utf8")).toContain("edited");
  });

  test("keys the directory by version so a new version re-materializes", () => {
    const a = ensureEngine({ packageRoot: pkg, baseDir: base, version: "1.0.0" });
    const b = ensureEngine({ packageRoot: pkg, baseDir: base, version: "2.0.0" });

    expect(a).not.toBe(b);
    expect(existsSync(join(engineDir(base, "1.0.0"), "bootstrap", "cli.ts"))).toBe(true);
    expect(existsSync(join(engineDir(base, "2.0.0"), "bootstrap", "cli.ts"))).toBe(true);
  });
});
