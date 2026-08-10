// Provider/model/effort resolution for one agent run (#155) — a pure
// function so it's directly unit-testable, independent of `runEngine`'s
// composition root. Both call chains that invoke an agent (the issue-shaped
// producer and the PR-fix skeleton behind checks/conflicts/reviews) terminate
// at this one function via `main.ts`'s `runAgentInWorktree`, so the
// tier-classification and bundle-selection logic is written once and shared.

import { PROVIDER_NAMES, type PhoebeConfig, type ProviderName } from "../config/index.ts";
import { TIER_BUNDLES, type Tier } from "../tier.ts";
import { PROVIDERS } from "./providers.ts";
import type { Provider } from "./types.ts";

export type SelectedProvider = { provider: Provider; model: string; effort?: string };

/**
 * A recognized `tier` (from the unit's `phoebe:tier:*` label) short-circuits
 * straight to that tier's bundle — the Claude Code CLI's own `opus`/`sonnet`
 * model alias plus its effort — bypassing
 * `PHOEBE_AGENT`/`PHOEBE_MODEL`/`PHOEBE_EFFORT`/tenant-default resolution
 * entirely for this one run. `strong` is the only tier that reaches Opus, and
 * only ever via a label a human placed in advance — the fleet never picks it
 * for itself.
 *
 * With no tier (or an unrecognized one, already filtered out by
 * `classifyTier`), resolution is env override, falling back to the tenant's
 * resolved config default — the same ladder `PHOEBE_MODEL`/`defaultModels`
 * already used before `PHOEBE_EFFORT`/`defaultEfforts` existed.
 */
export function selectProvider(opts: {
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  tier?: Tier;
}): SelectedProvider {
  const { config, env, tier } = opts;
  if (tier) {
    const bundle = TIER_BUNDLES[tier];
    return { provider: PROVIDERS.claude, model: bundle.model, effort: bundle.effort };
  }
  const name = env["PHOEBE_AGENT"] ?? config.defaultProvider;
  if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown PHOEBE_AGENT "${name}". Use one of: ${PROVIDER_NAMES.join(", ")}.`);
  }
  const provider = PROVIDERS[name as ProviderName];
  const model = env["PHOEBE_MODEL"] ?? config.defaultModels[name as ProviderName];
  const effort = env["PHOEBE_EFFORT"] ?? config.defaultEfforts[name as ProviderName];
  return { provider, model, ...(effort !== undefined ? { effort } : {}) };
}
