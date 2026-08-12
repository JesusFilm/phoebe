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
// src/config/); the engine never reads this field — `resolveConfiguration`
// drops it the same way `engine` is dropped (#97). Malformed values fail
// loudly here when the bootstrapper loads the root config as an untyped
// record before the engine exists, and again engine-side: `src/config/types.ts`
// imports {@link validateWorkspaceField} from this module rather than keeping
// a second copy, so the two entry points cannot drift as the arms grow (#128).

import { isAbsolute, normalize, resolve, sep } from "node:path";

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
 *  - **An entry may not be, or contain, the workspace root.** The root config is
 *    the supervisor; supervising it as a tenant means a child re-reading the
 *    fleet config, and a tenant dir that *contains* the root is the same hazard
 *    one level out.
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
 * `opts.root` is the workspace root the entries resolve against. Callers that
 * know it (the bootstrapper, `phoebe list`) get the full check, including the
 * rules that need to know where an entry points: the root spelled absolutely,
 * and a duplicate or nested pair where one entry is relative and the other
 * absolute. The engine-side call from `validateUserConfig` has no config
 * directory to offer, so it omits the root and those go unchecked there —
 * everything expressible lexically is still checked either way, including pure
 * `..` chains, which contain the root whatever the root turns out to be.
 */
export function validateWorkspaceField(
  field: unknown,
  opts: { root?: string } = {},
): ResolvedWorkspace {
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
    return { tenants: validateTenantList(block.tenants, opts.root) };
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
 * preserves it verbatim. An empty list is a valid zero-tenant fleet (a root
 * mid-add or mid-remove); discovery warns so an empty supervisor does not look
 * like a silent failure.
 */
function validateTenantList(value: unknown, root: string | undefined): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `phoebe.config.ts \`workspace.tenants\` must be an array of directory paths ` +
        `(got ${JSON.stringify(value)}).`,
    );
  }

  const normalized: string[] = [];
  // Comparison key → the declared spelling it came from, so a clash can name
  // the entry the operator actually wrote.
  const seen = new Map<string, string>();
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
    if (dir === "." || dir.length === 0 || resolvesToRoot(dir, root)) {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` entry ${JSON.stringify(entry)} resolves to the ` +
          `workspace root — the root is the supervisor, never one of its own tenants.`,
      );
    }
    if (containsRoot(dir, root)) {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` entry ${JSON.stringify(entry)} contains the ` +
          `workspace root — a tenant whose checkout holds the fleet config would have the ` +
          `supervisor inside it. List the sibling directory you meant, not its parent.`,
      );
    }

    // Compared on where an entry *points*, not on how it was spelled, so a
    // relative entry and an absolute one naming the same directory still clash.
    const key = comparisonKey(dir, root);
    const clash = seen.get(key);
    if (clash !== undefined) {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` has a duplicate entry: ${JSON.stringify(dir)} ` +
          `and ${JSON.stringify(clash)} are the same directory — deduplicating silently would ` +
          `make the fleet smaller than the config reads.`,
      );
    }

    const nested = [...seen].find(([other]) => nests(other, key) || nests(key, other));
    if (nested !== undefined) {
      throw new Error(
        `phoebe.config.ts \`workspace.tenants\` lists ${JSON.stringify(dir)} nested inside ` +
          `${JSON.stringify(nested[1])} (or the reverse) — each tenant directory is its own ` +
          `checkout, so one may not contain another.`,
      );
    }

    seen.set(key, dir);
    normalized.push(dir);
  }
  return normalized;
}

/**
 * What two entries are compared on. With a root, that is the directory they
 * resolve to, which is the only way to see that `widget` and
 * `/srv/deploy/widget` are one tenant. Without one — the engine-side call from
 * `validateUserConfig`, which has no config directory — the normalized spelling
 * is all there is, so two entries anchored differently cannot be compared and a
 * clash between them goes unseen.
 */
function comparisonKey(dir: string, root: string | undefined): string {
  return root === undefined ? dir : resolve(root, dir);
}

/**
 * Trailing separators carry no meaning for a directory entry. A lone separator
 * is the filesystem root and survives, so the loop stops at one character —
 * absurd as a tenant, but it still has to compare correctly in {@link nests}.
 * `normalize` has already settled which separator is in play for the platform.
 */
function stripTrailingSeparators(dir: string): string {
  let end = dir.length;
  while (end > 1 && dir[end - 1] === sep) {
    end -= 1;
  }
  return dir.slice(0, end);
}

/**
 * Whether a normalized entry is the workspace root spelled some other way. `.`
 * is caught lexically by the caller; this catches the root written out in full,
 * which needs the root path to see.
 */
function resolvesToRoot(dir: string, root: string | undefined): boolean {
  if (root === undefined) return false;
  return resolve(root, dir) === resolve(root);
}

/**
 * Whether a normalized entry contains the workspace root. A pure `..` chain is
 * an ancestor of any root, so it is rejected even with no root path to resolve
 * against; anything else needs the root.
 */
function containsRoot(dir: string, root: string | undefined): boolean {
  if (!isAbsolute(dir) && dir.split(sep).every((segment) => segment === "..")) return true;
  if (root === undefined) return false;
  return nests(resolve(root, dir), resolve(root));
}

/**
 * Whether `inner` sits under `outer`, compared segment-wise so `app-web` is not
 * read as nested inside `app`. Only comparable when both paths are anchored the
 * same way — see the `opts.root` note on {@link validateWorkspaceField}. A path
 * that already ends in a separator (the filesystem root) is not given a second.
 */
function nests(outer: string, inner: string): boolean {
  if (isAbsolute(outer) !== isAbsolute(inner)) return false;
  const prefix = outer.endsWith(sep) ? outer : `${outer}${sep}`;
  return inner.startsWith(prefix);
}

/**
 * Raised when a config declares the explicit arm but the caller only knows how
 * to walk. The field shape, ordering, and validation landed first (#128);
 * discovery and reconcile for a declared fleet land with #130.
 */
export class ExplicitWorkspaceUnsupportedError extends Error {
  constructor(declared: number) {
    super(
      "phoebe.config.ts `workspace.tenants` (an explicitly declared fleet) is not supported " +
        "by this version of Phoebe yet — use `workspace: { depth }` to walk the tree for " +
        `children. Declared: ${declared} tenant(s).`,
    );
    this.name = "ExplicitWorkspaceUnsupportedError";
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
    throw new ExplicitWorkspaceUnsupportedError(workspace.tenants.length);
  }
  return workspace.depth;
}

/**
 * Extract the resolved `workspace` block from a loaded root config, or `null`
 * when the block is absent (the deployment is solo). A present
 * but malformed block is a hard error — see {@link validateWorkspaceField}.
 */
export function readWorkspaceField(
  config: Record<string, unknown>,
  opts: { root?: string } = {},
): ResolvedWorkspace | null {
  const field = config["workspace"];
  if (field === undefined) return null;
  return validateWorkspaceField(field, opts);
}

/**
 * Single entry point for resolving the workspace block from a loaded root
 * config. Boot, `phoebe list`, and `init --tenant` all call this so they
 * cannot disagree about which discovery arm is in force (#137/#142).
 */
export function resolveWorkspace(
  config: Record<string, unknown>,
  opts: { root?: string } = {},
): ResolvedWorkspace | null {
  return readWorkspaceField(config, opts);
}

/** Which discovery arm a resolved block uses. */
export function workspaceArm(workspace: ResolvedWorkspace): "depth" | "tenants" {
  return isExplicitWorkspace(workspace) ? "tenants" : "depth";
}
