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

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Package subtrees to copy: the TypeScript bootstrapper + engine, plus the
// scaffold resources `phoebe init` reads (init walks up from src/ to find them).
const MATERIALIZED_PARTS = ["bootstrap", "src", "templates", "prompts"];

/** Version-keyed materialization directory under `baseDir`. */
export function engineDir(baseDir, version) {
  return join(baseDir, `engine-${version}`);
}

/**
 * Ensure a runnable copy of the package exists outside node_modules and return
 * the path to the bootstrapper entry (`<dir>/bootstrap/cli.ts`). Idempotent: a
 * version-keyed marker means repeated invocations (the supervisor loop runs the
 * bin over and over) skip the copy after the first. Callers key `baseDir` per
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
    // The copied `.ts` modules must load as ESM; the nearest package.json to
    // `<dir>/bootstrap/cli.ts` is this one. A minimal `{"type":"module"}` is
    // enough — nothing reads its own package fields at runtime.
    writeFileSync(join(dir, "package.json"), '{\n  "type": "module"\n}\n');
    // Write the marker last so a copy interrupted midway re-runs next time.
    writeFileSync(marker, `${version}\n`);
  }
  return join(dir, "bootstrap", "cli.ts");
}
