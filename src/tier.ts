// Per-ticket model/effort tier override (#155): a human-placed
// `phoebe:tier:basic|mid|strong` label that overrides the tenant's default
// provider/model/effort for one run. Deliberately not an automatic difficulty
// classifier — `helm-go` already built and deleted a runtime one in favor of a
// static, human-authored tier table; this mirrors that shape. Fleet-wide
// constant, not tenant-configurable, for the same reason `tenant-configs.test.ts`
// forbids other fleet-wide settings from drifting per tenant.

export const PHOEBE_TIER_LABEL_PREFIX = "phoebe:tier:";

export type Tier = "basic" | "mid" | "strong";

/**
 * `model` is the Claude Code CLI's own alias (`opus`/`sonnet`), not a dated
 * model string — portable, no future re-pin needed. `strong` is the only tier
 * that reaches Opus, and only ever via a label a human placed in advance; the
 * fleet never chooses it for itself.
 */
export const TIER_BUNDLES: Record<Tier, { model: string; effort: string }> = {
  basic: { model: "sonnet", effort: "low" },
  mid: { model: "sonnet", effort: "high" },
  strong: { model: "opus", effort: "high" },
};

/**
 * The unit's tier from its label set, or `undefined` when no `phoebe:tier:*`
 * label is present or its value isn't one of `TIER_BUNDLES`' keys — a typo
 * (`phoebe:tier:bogus`) falls back to the tenant default rather than
 * throwing.
 */
export function classifyTier(labels: readonly string[]): Tier | undefined {
  const hit = labels.find((label) => label.startsWith(PHOEBE_TIER_LABEL_PREFIX));
  if (!hit) return undefined;
  const value = hit.slice(PHOEBE_TIER_LABEL_PREFIX.length);
  return value === "basic" || value === "mid" || value === "strong" ? value : undefined;
}
