// Finding a file the package ships — a template, a prompt — from a module
// inside it.
//
// The walk-up exists because the package's own layout is not fixed from any one
// module's point of view. `src/init.ts` sits one level under the package root in
// a checkout, and an installed copy nests it under `node_modules/phoebe-agent/`.
// Walking up until the resource appears covers both, and stopping at a
// `node_modules` boundary is what keeps a miss from climbing out of the package
// and finding a consumer's file of the same name.
//
// It is also what makes the companion work. `apps/desktop` bundles the host
// verbs into its main process (ADR 0001), so at run time these modules live in
// `apps/desktop/dist/` rather than under `src/` — and a relative path computed
// against the module's own directory would point at nothing. The walk-up finds
// the same `templates/` and `prompts/` it always did. Where even that cannot
// hold — a packaged app, where the resources sit beside the executable — the
// caller passes a root explicitly.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The absolute path to a package-shipped resource, searching upward from
 * `moduleDir`. Throws rather than returning null: a missing shipped file is a
 * broken installation, and the paths searched are the useful half of the error.
 */
export function resolvePackageResource(relativePath: string, moduleDir: string): string {
  let dir = moduleDir;
  while (true) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir || basename(parent) === "node_modules") {
      throw new Error(
        `Could not find ${relativePath} within the Phoebe package (searched from ${moduleDir})`,
      );
    }
    dir = parent;
  }
}

/**
 * The directory a module was loaded from, for handing to
 * {@link resolvePackageResource}.
 *
 * Written as `fileURLToPath(import.meta.url)` and never as
 * `new URL(relative, import.meta.url)`: a bundler reads the second form as an
 * asset reference and rewrites it to a `data:` URL, which `fileURLToPath` then
 * refuses. The first form survives bundling as itself.
 */
export function moduleDirOf(moduleUrl: string): string {
  return dirname(fileURLToPath(moduleUrl));
}
