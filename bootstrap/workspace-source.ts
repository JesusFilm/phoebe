// Bootstrapper-owned `workspace` field reader (#83/#91/#128).
//
// Mirrors `engine-source.ts`: the presence of a `workspace` block on the
// deployment-root config is what selects workspace discovery mode. The block
// carries exactly one of two discovery arms:
//
//   workspace: { depth: 1 }                    walk the tree for children
//   workspace: { tenants: ["widget", "web"] }  declare the fleet explicitly
//
// The user-facing type lives on `PhoebeUserConfig` (`WorkspaceField` in
// config-schema); the engine never reads this field — `resolveConfig` drops it
// the same way `engine` is dropped (#97). Malformed values fail loudly here
// when the bootstrapper loads the root config as an untyped record before the
// engine exists, and again engine-side: `src/config-schema.ts` imports
// {@link validateWorkspaceField} from this module rather than keeping a second
// copy, so the two entry points cannot drift as the arms grow (#128).

import { isAbsolute, normalize, sep } from "node:path";

/**
 * Resolved workspace block — a structural union, one member per discovery arm,
 * narrowed with {@link isExplicitWorkspace}. It reads exactly like the config
 * the operator wrote: `depth` is always an integer ≥ 1 (default 1), `tenants`
 * is the declared list in declared order with each entry normalized.
 */
export type ResolvedWorkspace = { depth: number } | { tenants: string[] };

/** Default scan depth when the root config declares `workspace: {}`. */
export const DEFAULT_WORKSPACE_DEPTH = 1;

/** Glob metacharacters, rejected outright — see {@link validateWorkspaceField}. */
const GLOB_CHARS = /[*?[\]{}]/;

/** Whether a resolved block declares its fleet explicitly rather than by walking. */
export function isExplicitWorkspace(
  workspace: ResolvedWorkspace,
): workspace is { tenants: string[] } {
  return "tenants" in workspace;
}

/**
 * Validate a `workspace` block and resolve it to one arm. Throws on anything
 * malformed — silent defaulting would hide a typo that flipped the whole
 * deployment out of workspace mode, or (worse, under the explicit arm) that
 * quietly shrank the fleet.
 *
 * Path rules on `tenants`, all fatal at load:
 *
 *  - **Globs are not supported.** A glob would reintroduce the emergent
 *    membership this arm exists to remove, so it fails loudly here rather than
 *    later as a missing directory.
 *  - **An entry may not resolve to the workspace root.** The root config is the
 *    supervisor; supervising it as a tenant means a child re-reading the fleet
 *    config.
 *  - **No duplicates after normalization.** A silent dedupe would mean the
 *    config diff lied about fleet size.
 *  - **No tenant nested inside another tenant.** Each tenant dir is its own
 *    checkout. The depth walk makes this impossible via prune-at-first-hit; the
 *    explicit arm has no such guard.
 *
 * Absolute and `..` entries are **deliberately supported** — a root config may
 * supervise repos outside the workspace checkout. Spelling is normalized
 * without complaint (`"./widget/"` → `widget`).
 *
 * Nesting and duplicate detection here is **lexical**, so it compares two
 * relative entries or two absolute entries but not one of each: this validator
 * also runs engine-side from `validateUserConfig`, which never learns the
 * config's own directory. Discovery resolves every entry against the root and
 * is where a relative-versus-absolute clash surfaces.
 */
export function validateWorkspaceField(field: unknown): ResolvedWorkspace {
  if (field === null || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(
      `phoebe.config.ts \`workspace\` must be { depth?: integer ≥ 1 } or ` +
        `{ tenants: string[] } (got ${JSON.stringify(field)}).`,
    );
  }

  const block = field as { depth?: unknown; tenants?: unknown };
  const hasDepth = block.depth !== undefined;
  const hasTenants = block.tenants !== undefined;

  if (hasDepth && hasTenants) {
    throw new Error(
      "phoebe.config.ts `workspace` must declare exactly one of `depth` (walk the " +
        "tree for children) or `tenants` (declare the fleet explicitly) — got both. " +
        "Delete whichever arm you did not mean to use.",
    );
  }

  if (hasTenants) {
    return { tenants: validateTenantList(block.tenants) };
  }

  if (!hasDepth) {
    return { depth: DEFAULT_WORKSPACE_DEPTH };
  }

  const { depth } = block;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
    throw new Error(
      `phoebe.config.ts \`workspace.depth\` must be an integer ≥ 1 ` +
        `(got ${JSON.stringify(depth)}).`,
    );
  }
  return { depth };
}

/**
 * Normalize and check every declared entry. Declared order is authoritative —
 * it is spawn order, `phoebe list` order, and warn order — so the returned list
 * preserves it verbatim. An empty list is a valid zero-tenant fleet (the
 * empty-`repos/` precedent); discovery warns so an empty supervisor does not
 * look like a silent failure.
 */
function validateTenantList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `phoebe.config.ts \`workspace.tenants\` must be an array of directory paths ` +
        `(got ${JSON.stringify(value)}).`,
    );
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` entries must be directory path strings ` +
          `(got ${JSON.stringify(entry)}).`,
      );
    }
    if (GLOB_CHARS.test(entry)) {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` entry ${JSON.stringify(entry)} looks like a ` +
          `glob — globs are not supported. List each tenant directory explicitly, which is ` +
          `the point of declaring the fleet.`,
      );
    }

    const dir = stripTrailingSeparators(normalize(entry));
    if (dir === "." || dir.length === 0) {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` entry ${JSON.stringify(entry)} resolves to the ` +
          `workspace root — the root is the supervisor, never one of its own tenants.`,
      );
    }

    const duplicate = normalized.find((seen) => seen === dir);
    if (duplicate !== undefined) {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` has a duplicate entry: ${JSON.stringify(dir)} ` +
          `is listed twice (${JSON.stringify(entry)} normalizes onto an earlier entry) — ` +
          `deduplicating silently would make the fleet smaller than the config reads.`,
      );
    }

    const nested = normalized.find((seen) => nests(seen, dir) || nests(dir, seen));
    if (nested !== undefined) {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` lists ${JSON.stringify(dir)} nested inside ` +
          `${JSON.stringify(nested)} (or the reverse) — each tenant directory is its own ` +
          `checkout, so one may not contain another.`,
      );
    }

    normalized.push(dir);
  }
  return normalized;
}

/** Trailing separators carry no meaning for a directory entry; `/` survives. */
function stripTrailingSeparators(dir: string): string {
  let end = dir.length;
  while (end > 1 && (dir[end - 1] === sep || dir[end - 1] === "/")) {
    end -= 1;
  }
  return dir.slice(0, end);
}

/**
 * Whether `inner` sits under `outer`, compared segment-wise so `app-web` is not
 * read as nested inside `app`. Only comparable when both entries are anchored
 * the same way — see the lexical caveat on {@link validateWorkspaceField}.
 */
function nests(outer: string, inner: string): boolean {
  if (isAbsolute(outer) !== isAbsolute(inner)) return false;
  return inner.startsWith(`${outer}${sep}`) || inner.startsWith(`${outer}/`);
}

/**
 * Raised when a config declares the explicit arm but the caller only knows how
 * to walk. The field shape, ordering, and validation landed first (#128);
 * discovery and reconcile for a declared fleet land with #130.
 */
export class ExplicitWorkspaceUnsupportedError extends Error {
  readonly tenants: readonly string[];

  constructor(tenants: readonly string[]) {
    super(
      "phoebe.config.ts `workspace.tenants` (an explicitly declared fleet) is not supported " +
        "by this version of Phoebe yet — use `workspace: { depth }` to walk the tree for " +
        `children. Declared: ${tenants.length} tenant(s).`,
    );
    this.name = "ExplicitWorkspaceUnsupportedError";
    this.tenants = tenants;
  }
}

/**
 * Narrow a resolved block to the walk arm's depth, refusing the explicit arm
 * outright. Discovery still only walks, and the failure that would actually
 * hurt is a silent fallback: an operator who declared a fleet would get an
 * emergent one — precisely what the explicit arm exists to prevent — without
 * being told. So every walk-only caller goes through here.
 */
export function requireDepthArm(workspace: ResolvedWorkspace): number {
  if (isExplicitWorkspace(workspace)) {
    throw new ExplicitWorkspaceUnsupportedError(workspace.tenants);
  }
  return workspace.depth;
}

/**
 * Extract the resolved `workspace` block from a loaded root config, or `null`
 * when the block is absent (nested / flat mode ladders take over). A present
 * but malformed block is a hard error — see {@link validateWorkspaceField}.
 */
export function readWorkspaceField(config: Record<string, unknown>): ResolvedWorkspace | null {
  const field = config["workspace"];
  if (field === undefined) return null;
  return validateWorkspaceField(field);
}
