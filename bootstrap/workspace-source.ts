// Bootstrapper-only `workspace` field reader (#83/#91).
//
// Mirrors `engine-source.ts`: the presence of `workspace: { depth? }` on the
// deployment-root config is what selects workspace discovery mode. The engine
// never reads this field (Ticket 0 / #97 will strip it from `PhoebeConfig` the
// same way `engine` is dropped). Malformed values fail loudly here.

/** Resolved workspace block: depth is always an integer ≥ 1 (default 1). */
export type ResolvedWorkspace = { depth: number };

/** Default scan depth when the root config declares `workspace: {}`. */
export const DEFAULT_WORKSPACE_DEPTH = 1;

/**
 * Whether an arbitrary value is a well-formed `workspace` field object.
 * `depth`, when present, must be an integer ≥ 1; omitted is fine (defaulted).
 */
function isWorkspaceField(value: unknown): value is { depth?: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const field = value as Record<string, unknown>;
  if (field["depth"] === undefined) return true;
  const depth = field["depth"];
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 1;
}

/**
 * Extract the resolved `workspace` block from a loaded root config, or `null`
 * when the block is absent (nested / flat mode ladders take over). A present
 * but malformed block is a hard error — silent defaulting would hide a typo
 * that flipped the whole deployment out of workspace mode.
 */
export function readWorkspaceField(config: Record<string, unknown>): ResolvedWorkspace | null {
  const field = config["workspace"];
  if (field === undefined) return null;
  if (!isWorkspaceField(field)) {
    throw new Error(
      `phoebe.config.ts \`workspace\` must be { depth?: integer ≥ 1 } ` +
        `(got ${JSON.stringify(field)}).`,
    );
  }
  return { depth: field.depth ?? DEFAULT_WORKSPACE_DEPTH };
}
