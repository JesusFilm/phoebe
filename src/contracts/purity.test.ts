// The guard on `phoebe-agent/contracts` (#528, map #497). The subpath's whole
// promise is that a browser bundle can load it — an Electron renderer today, an
// Expo bundle later — so the closure of everything it imports has to stay free
// of Node built-ins and of engine code. Nothing enforces that at type-check
// time: `import { readFileSync } from "node:fs"` type-checks perfectly and only
// fails once someone runs the bundle. This test is the enforcement.
//
// Two rules, walked transitively from every file under src/contracts/:
//
//  1. No file in the closure imports a Node built-in, in any form — a type-only
//     import of `node:fs` would still put @types/node in a consumer's way.
//  2. No file under src/contracts/ reaches outside the directory for a value.
//     Type imports may cross the line, and when they do the file they name
//     joins the closure and answers to rule 1 in turn.
//
// A type that trips the guard is a type that belongs in contracts. Moving it is
// the fix, and the point of the directory.
//
// The walk covers the `.mjs` files too, not just the `.ts` ones. Those are the
// subpath's runtime surface — where a pure value has to live, since Node will not
// type-strip a `.ts` under node_modules — so they are exactly the files whose
// imports a browser bundle executes. Leaving them out would have let the one file
// a consumer really loads import `node:crypto` unchallenged.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const contractsDir = import.meta.dirname;
const repoRoot = join(import.meta.dirname, "..", "..");

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

type ImportSite = { specifier: string; typeOnly: boolean };

/** `import ... from "x"` / `export ... from "x"`, single- or multi-line. */
const FROM_STATEMENT = /^[ \t]*(import|export)\b([\s\S]*?)\bfrom[ \t]*["']([^"']+)["']/gm;
/** `import "x"` — a side-effect import, always a runtime edge. */
const SIDE_EFFECT_IMPORT = /^[ \t]*import[ \t]*["']([^"']+)["']/gm;
/** `import("x")` — likewise. */
const DYNAMIC_IMPORT = /\bimport[ \t]*\([ \t]*["']([^"']+)["']/g;

/**
 * Blank out comments so prose that happens to read like an import statement —
 * this file's own header, for one — never counts as an edge. Coarse on purpose:
 * it can chew a `//` inside a string literal, which at worst hides nothing,
 * since imports sit on lines of their own.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * A clause is type-only either wholesale (`import type { A } from "x"`) or by
 * every named specifier carrying its own inline `type` modifier
 * (`import { type A, type B } from "x"`) — a mix of `{ type A, B }` still
 * imports a value and answers to rule 2.
 */
function isTypeOnlyClause(clause: string): boolean {
  if (/^\s*type\b/.test(clause)) return true;
  const named = clause.match(/\{([\s\S]*)\}/);
  if (!named || named[1]!.trim() === "") return false;
  if (/[^{]*\*\s*as\b/.test(clause.slice(0, named.index))) return false;
  const specifiers = named[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return specifiers.every((s) => /^type\b/.test(s));
}

export function importsIn(source: string): ImportSite[] {
  const code = stripComments(source);
  const sites: ImportSite[] = [];
  for (const [, , clause, specifier] of code.matchAll(FROM_STATEMENT)) {
    sites.push({ specifier: specifier!, typeOnly: isTypeOnlyClause(clause!) });
  }
  for (const [, specifier] of code.matchAll(SIDE_EFFECT_IMPORT)) {
    sites.push({ specifier: specifier!, typeOnly: false });
  }
  for (const [, specifier] of code.matchAll(DYNAMIC_IMPORT)) {
    sites.push({ specifier: specifier!, typeOnly: false });
  }
  return sites;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function inContracts(file: string): boolean {
  return !relative(contractsDir, file).startsWith("..");
}

/**
 * The two rules, as messages. `file` decides which apply: a file under
 * src/contracts/ answers to both, a file that a contract type-imports only to
 * rule 1.
 */
export function violationsIn(file: string, source: string): string[] {
  const here = relative(repoRoot, file);
  const found: string[] = [];
  for (const { specifier, typeOnly } of importsIn(source)) {
    if (BUILTINS.has(specifier)) {
      found.push(`${here} imports the Node built-in "${specifier}"`);
      continue;
    }
    if (!inContracts(file)) continue;
    if (!isRelative(specifier)) {
      found.push(`${here} imports "${specifier}" — contracts depends on no package`);
      continue;
    }
    const target = resolve(dirname(file), specifier);
    if (!inContracts(target) && !typeOnly) {
      found.push(`${here} value-imports "${specifier}" from outside contracts`);
    }
  }
  return found;
}

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(full));
    else if (entry.name.endsWith(".mjs")) files.push(full);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

const SOURCE_EXTENSIONS = [".ts", ".mjs"];

/** Resolve a relative specifier the way the bundler will, explicit extensions and all. */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && SOURCE_EXTENSIONS.some((ext) => candidate.endsWith(ext))) {
      return candidate;
    }
  }
  return null;
}

/** Every file a bundle of contracts would pull in, contracts' own files included. */
function closure(): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue = sourceFilesUnder(contractsDir);
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier } of importsIn(readFileSync(file, "utf8"))) {
      if (!isRelative(specifier)) continue;
      const target = resolveSpecifier(file, specifier);
      if (target === null) unresolved.push(`${relative(repoRoot, file)} → "${specifier}"`);
      else queue.push(target);
    }
  }
  return { files: [...seen], unresolved };
}

describe("the contracts closure stays pure", () => {
  test("every file reachable from contracts obeys both rules", () => {
    const { files, unresolved } = closure();
    expect(unresolved, "a relative import the guard could not follow").toEqual([]);
    const found = files.flatMap((file) => violationsIn(file, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });

  test("the closure is not empty — a broken walk would pass vacuously", () => {
    const { files } = closure();
    expect(files).toContain(join(contractsDir, "index.ts"));
    expect(files).toContain(join(contractsDir, "stop-outcome.ts"));
    expect(files).toContain(join(contractsDir, "index.mjs"));
    expect(files).toContain(join(contractsDir, "secret-envelope.mjs"));
  });

  test.each([
    { what: "a Node built-in", source: `import { readFileSync } from "node:fs";` },
    { what: "an unprefixed Node built-in", source: `import { join } from "path";` },
    { what: "a type-only Node built-in", source: `import type { Stats } from "node:fs";` },
    { what: "a package dependency", source: `import { parse } from "some-package";` },
    { what: "a value import from the engine", source: `import { runStop } from "../stop.ts";` },
    { what: "a side-effect import", source: `import "../resolved-config.ts";` },
    { what: "a dynamic import", source: `const m = await import("../doctor.ts");` },
  ])("a contract that imports $what trips the guard", ({ source }) => {
    expect(violationsIn(join(contractsDir, "fixture.ts"), source)).not.toEqual([]);
  });

  test.each([
    { what: "a type-only import from the engine", source: `import type { A } from "../paths.ts";` },
    {
      what: "an inline type-only named import from the engine",
      source: `import { type A } from "../paths.ts";`,
    },
    { what: "a sibling contract", source: `export type { StopOutcome } from "./stop-outcome.ts";` },
    { what: "no imports at all", source: `export type Kind = "a" | "b";` },
  ])("a contract with $what passes", ({ source }) => {
    expect(violationsIn(join(contractsDir, "fixture.ts"), source)).toEqual([]);
  });

  test("mixed inline type and value specifiers still trip the guard", () => {
    const source = `import { type A, runStop } from "../stop.ts";`;
    expect(violationsIn(join(contractsDir, "fixture.ts"), source)).not.toEqual([]);
  });

  test("a runtime .mjs in contracts answers to both rules", () => {
    const runtime = join(contractsDir, "fixture.mjs");
    expect(violationsIn(runtime, `import { randomUUID } from "node:crypto";`)).not.toEqual([]);
    expect(violationsIn(runtime, `import { sealSecret } from "../stop.ts";`)).not.toEqual([]);
    expect(violationsIn(runtime, `export { sealSecret } from "./secret-envelope.mjs";`)).toEqual(
      [],
    );
  });

  test("a file the guard only reaches by type import still answers to rule 1", () => {
    const outside = join(repoRoot, "src", "paths.ts");
    expect(violationsIn(outside, `import { join } from "node:path";`)).not.toEqual([]);
    expect(violationsIn(outside, `import { x } from "./elsewhere.ts";`)).toEqual([]);
  });

  test("prose that reads like an import is not an import", () => {
    const source = `// import { readFileSync } from "node:fs";\nexport type A = 1;`;
    expect(importsIn(source)).toEqual([]);
  });
});

describe("the phoebe-agent/contracts subpath resolves", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    files: string[];
    exports: Record<string, Record<string, string>>;
    dependencies?: Record<string, string>;
  };
  const entry = pkg.exports["./contracts"];

  test("the export map declares the subpath, types first", () => {
    expect(entry).toEqual({
      types: "./src/contracts/index.ts",
      import: "./src/contracts/index.mjs",
    });
  });

  test("the import condition carries the envelope, not just types", async () => {
    // What an installed consumer actually loads. Types are the other condition's
    // job; this one has to hand back callable functions, and a subpath whose
    // runtime entry re-exported nothing would satisfy every other test here.
    const runtime = (await import("./index.mjs")) as Record<string, unknown>;
    expect(typeof runtime.sealSecret).toBe("function");
    expect(typeof runtime.openSecret).toBe("function");
  });

  test("the envelope added no runtime dependency", () => {
    // The envelope is ECIES hand-assembled from WebCrypto rather than a sealed
    // box from libsodium precisely so this list does not grow (#514 §6, #506):
    // a dependency here lands in every deployment's image. What is on it is the
    // relay's own — a host process an operator runs deliberately — and nothing
    // under contracts may import either name, which the walk above enforces.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["openid-client"]);
  });

  test("both conditions name files the published tarball carries", () => {
    for (const target of Object.values(entry ?? {})) {
      expect(existsSync(join(repoRoot, target)), `${target} is missing`).toBe(true);
    }
    expect(pkg.files).toContain("src");
  });
});
