// Copy the package out of node_modules so Node can run its raw `.ts`. Node 24
// refuses to type-strip any file under a `node_modules` segment
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and the installed package lives
// exactly there. This is the one irreducible bit of the bootstrapper that must
// be plain JS: it runs first, still inside node_modules, and its whole job is to
// get the TypeScript bootstrapper (bootstrap/cli.ts) + engine (src/) to a
// directory *outside* node_modules, where type-stripping is allowed. Everything
// downstream — the bootstrapper and engine — is type-checked TypeScript.
//
// The bundled copy is the transitional engine source. Later tickets (#40/#41)
// teach bootstrap/cli.ts to resolve the engine from a local mount / git ref; the
// "run raw `.ts` from a dir outside node_modules" shape is what stays.
//
// Escaping node_modules costs the copy its dependency resolution, so the copy
// gets a `node_modules` of its own holding one symlink per runtime dependency
// (linkDependencies below). The package had none until the relay's OIDC client
// (#538); anything it gains from here works the same way.

import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Package subtrees to copy: the TypeScript bootstrapper + engine, plus the
// scaffold resources `phoebe init` reads (init walks up from src/ to find them).
const MATERIALIZED_PARTS = ["bootstrap", "src", "relay", "templates", "prompts"];

/**
 * Resolve `name` from `fromDir` the way Node does: walk up, appending
 * `node_modules` to every ancestor that is not itself a `node_modules`
 * directory. Returns the package directory, or null when it is not installed.
 */
function findDependency(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Give the materialized copy a `node_modules` of its own, holding a symlink to
 * each of the package's runtime dependencies where they really live.
 *
 * Without this the copy cannot import them at all: it sits in a temp dir (or on
 * the data volume) with no `node_modules` above it, so `import "openid-client"`
 * from `relay/` resolves against nothing. Only the *direct* dependencies are
 * linked — their own dependencies resolve from the real directory the symlink
 * points at, because Node resolves through symlinks by default.
 *
 * A dependency that is not installed is skipped rather than fatal: the import
 * that needs it fails with Node's own "Cannot find package" at the moment it is
 * used, which names the package, instead of this copy step failing every verb.
 */
function linkDependencies(packageRoot, dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  } catch {
    return;
  }
  const kind = process.platform === "win32" ? "junction" : "dir";
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const resolved = findDependency(packageRoot, name);
    if (resolved === null) continue;
    const link = join(dir, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    try {
      symlinkSync(resolved, link, kind);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

/** Version-keyed materialization directory under `baseDir`. */
export function engineDir(baseDir, version) {
  return join(baseDir, `engine-${version}`);
}

/**
 * Ensure a runnable copy of the package exists outside node_modules and return
 * the path to the bootstrapper entry (`<dir>/bootstrap/cli.ts`). Idempotent: a
 * version-keyed marker means repeated invocations (anything that runs the bin
 * over and over) skip the copy after the first. Callers key `baseDir` per
 * install and the package version changes on release, so a stale copy is never
 * reused.
 */
export function ensureEngine({ packageRoot, baseDir, version }) {
  const dir = engineDir(baseDir, version);
  const marker = join(dir, ".materialized");
  if (!existsSync(marker)) {
    mkdirSync(dir, { recursive: true });
    for (const part of MATERIALIZED_PARTS) {
      const from = join(packageRoot, part);
      if (existsSync(from)) {
        cpSync(from, join(dir, part), { recursive: true });
      }
    }
    linkDependencies(packageRoot, dir);
    // The copied `.ts` modules must load as ESM; the nearest package.json to
    // `<dir>/bootstrap/cli.ts` is this one. A minimal `{"type":"module"}` is
    // enough — nothing reads its own package fields at runtime.
    writeFileSync(join(dir, "package.json"), '{\n  "type": "module"\n}\n');
    // Write the marker last so a copy interrupted midway re-runs next time.
    writeFileSync(marker, `${version}\n`);
  }
  return join(dir, "bootstrap", "cli.ts");
}
