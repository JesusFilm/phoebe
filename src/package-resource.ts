// Shared "find a shipped resource" walk-up for readers that must resolve
// `templates/…` / `prompts/…` from an installed dependency's `src/` — no
// build step, so `import.meta.url` is the only anchor. The walk stops at a
// `node_modules` boundary so an installed dep never resolves scaffold
// sources from the consuming repo. Used by `src/init.ts` (container/prompt
// templates) and `src/config/authoring.ts` (the three config templates).

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

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

/** Read a shipped resource verbatim, honoring an explicit `packageRoot` test seam. */
export function readShippedFile(
  relPath: string,
  packageRoot: string | undefined,
  moduleDir: string,
): string {
  const absolute = packageRoot
    ? resolvePath(packageRoot, relPath)
    : resolvePackageResource(relPath, moduleDir);
  return readFileSync(absolute, "utf8");
}
