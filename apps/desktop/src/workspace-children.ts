// The children of a workspace install, read the way the bootstrapper reads them.
//
// A workspace root's config carries a `workspace` block (docs/workspace.md): walk
// to `depth` for folders carrying `phoebe.config.ts`, or `tenants: [...]` naming
// them. The bootstrapper resolves that block from the loaded config. The
// companion never loads a config (install-facts.ts), so it reads the block off
// the source text — enough to say which arm and how deep — and walks the same
// folders with the same skip rule (bootstrap/tenants.ts): no dotfolders, no
// `node_modules`, no `.git`, and a folder that carries a config is a child and
// is not walked into.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LocalInstallChild } from "phoebe-agent/contracts";
import { TENANT_CONFIG_FILE } from "../../../bootstrap/tenants.ts";
import { DEFAULT_WORKSPACE_DEPTH } from "../../../bootstrap/workspace-source.ts";
import { editConfigGetField } from "../../../src/config-handle.ts";

/** The block as the source declares it, or null when the config has none. */
export type WorkspaceBlock = { depth: number } | { tenants: string[] };

const BLOCK = /\bworkspace\s*:\s*\{([\s\S]*?)\}/;
const DEPTH = /\bdepth\s*:\s*(\d+)/;
const TENANTS = /\btenants\s*:\s*\[([\s\S]*?)\]/;
const STRING = /["'`]([^"'`]+)["'`]/g;

/**
 * Read the block off the config's text. A `tenants` array wins over `depth`, as
 * the bootstrapper's validator rejects a block with both; an empty block is the
 * default depth.
 */
export function workspaceBlockOf(source: string | null): WorkspaceBlock | null {
  if (source === null) return null;
  const block = BLOCK.exec(source);
  if (block === null) return null;
  const body = block[1] as string;
  const tenants = TENANTS.exec(body);
  if (tenants !== null) {
    return { tenants: [...(tenants[1] as string).matchAll(STRING)].map((m) => m[1] as string) };
  }
  const depth = DEPTH.exec(body);
  return { depth: depth === null ? DEFAULT_WORKSPACE_DEPTH : Number(depth[1]) };
}

export type ChildrenDeps = {
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
  /** The subdirectories of a directory, by name. `readdirSync` on a real machine. */
  listDirs?: (dir: string) => string[];
};

/** The children under `rootDir` for this block, sorted by slug the way the fleet is. */
export function workspaceChildren(
  rootDir: string,
  block: WorkspaceBlock,
  deps: ChildrenDeps = {},
): LocalInstallChild[] {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((file: string) => readFileSync(file, "utf8"));
  const listDirs = deps.listDirs ?? defaultListDirs;

  const dirs: string[] = [];
  if ("tenants" in block) {
    for (const entry of block.tenants) {
      const dir = path.isAbsolute(entry) ? entry : path.join(rootDir, entry);
      if (exists(path.join(dir, TENANT_CONFIG_FILE))) dirs.push(dir);
    }
  } else {
    const walk = (parent: string, remaining: number): void => {
      if (remaining < 1) return;
      for (const name of listDirs(parent)) {
        if (shouldSkip(name)) continue;
        const dir = path.join(parent, name);
        if (exists(path.join(dir, TENANT_CONFIG_FILE))) dirs.push(dir);
        else walk(dir, remaining - 1);
      }
    };
    walk(rootDir, block.depth);
  }

  return dirs
    .map((dir) => ({ dir, name: path.basename(dir), slug: slugOf(dir, exists, read) }))
    .sort((a, b) => (a.slug ?? a.name).localeCompare(b.slug ?? b.name));
}

/** The bootstrapper's rule, kept in step by hand: bootstrap/tenants.ts `shouldSkipWorkspaceDir`. */
function shouldSkip(name: string): boolean {
  if (name === "node_modules" || name === ".git") return true;
  return name.startsWith(".");
}

function slugOf(
  dir: string,
  exists: (file: string) => boolean,
  read: (file: string) => string,
): string | null {
  const file = path.join(dir, TENANT_CONFIG_FILE);
  if (!exists(file)) return null;
  let source: string;
  try {
    source = read(file);
  } catch {
    return null;
  }
  const slug = editConfigGetField(source, "repoSlug");
  if (!slug.ok || !slug.found || typeof slug.literal !== "string") return null;
  const trimmed = slug.literal.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultListDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
