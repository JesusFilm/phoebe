// Per-work-kind provider/model/effort resolution (#300). Pure — the engine's
// `selectProvider` (src/main.ts) wraps this with the actual Provider lookup —
// so the ladder is unit-testable without building an engine.
//
// Each knob resolves independently, most specific wins:
//
//   1. per-kind env      (PHOEBE_REVIEWS_MODEL)
//   2. per-kind config   (workKinds.reviews.model)
//   3. global env        (PHOEBE_MODEL)
//   4. repo defaults     (defaultProvider / defaultModels / defaultEfforts)
//
// Per-kind *config* deliberately outranks global *env*: a kind's block is
// durable policy that survives a blanket `PHOEBE_MODEL`/`PHOEBE_AGENT`
// override; only the kind-specific env var pushes it aside.

import {
  PROVIDER_NAMES,
  workKindOverride,
  type PhoebeConfig,
  type ProviderName,
} from "./config-schema.ts";

export type ProviderSelection = {
  provider: ProviderName;
  model: string;
  /** Unset means "pass no effort flag" — the provider CLI's own default stands. */
  effort: string | undefined;
};

/**
 * The name of one per-kind runtime toggle, e.g. `PHOEBE_REVIEWS_MODEL`.
 * Hyphens in a (custom) kind name map to underscores — collision-free, since
 * `_` is outside the kind-name charset (#350).
 */
export function workKindEnvVar(kind: string, knob: "AGENT" | "MODEL" | "EFFORT"): string {
  return `PHOEBE_${kind.toUpperCase().replaceAll("-", "_")}_${knob}`;
}

/**
 * Resolve which provider, model, and effort one work unit of `kind` runs with.
 * Empty env values read as unset throughout, so compose's `"${VAR:-}"`
 * passthrough never silently forces a blank value. Throws on a provider name
 * outside the closed set, naming the env var that supplied it — the config
 * side was already validated at boot.
 */
export function selectProviderForKind(opts: {
  kind: string;
  env: NodeJS.ProcessEnv;
  config: Pick<PhoebeConfig, "defaultProvider" | "defaultModels" | "defaultEfforts" | "workKinds">;
  /**
   * The kind definition's own `model`/`effort` defaults (#303): they sit at
   * the repo-defaults rung — above `defaultModels`/`defaultEfforts`, below
   * everything the tenant or the environment says.
   */
  definitionDefaults?: { model?: string; effort?: string };
}): ProviderSelection {
  const { kind, env, config } = opts;
  const readEnv = (key: string): string | undefined => env[key] || undefined;
  const block = workKindOverride(config.workKinds, kind);

  const assertProvider = (name: string, source: string): ProviderName => {
    if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Unknown ${source} "${name}". Use one of: ${PROVIDER_NAMES.join(", ")}.`);
    }
    return name as ProviderName;
  };

  const kindAgentVar = workKindEnvVar(kind, "AGENT");
  const perKindAgent = readEnv(kindAgentVar);
  const globalAgent = readEnv("PHOEBE_AGENT");
  const provider =
    perKindAgent !== undefined
      ? assertProvider(perKindAgent, kindAgentVar)
      : (block?.provider ??
        (globalAgent !== undefined
          ? assertProvider(globalAgent, "PHOEBE_AGENT")
          : config.defaultProvider));

  // The mismatch guard: a kind block speaks for one provider — its explicit
  // `provider`, else `defaultProvider`. When the run's effective provider
  // differs (an env var flipped it), the block's model/effort stay silent so
  // provider-specific model names never reach the wrong CLI.
  const blockSpeaks =
    block !== undefined && (block.provider ?? config.defaultProvider) === provider;

  // A definition's defaults speak for the repo's default provider — a
  // definition has no `provider` knob, so like a providerless block they stay
  // silent when an env flip moved the run to a different CLI, keeping
  // provider-specific model names away from the wrong one.
  const definitionSpeaks =
    opts.definitionDefaults !== undefined && provider === config.defaultProvider;

  const model =
    readEnv(workKindEnvVar(kind, "MODEL")) ??
    (blockSpeaks ? block.model : undefined) ??
    readEnv("PHOEBE_MODEL") ??
    (definitionSpeaks ? opts.definitionDefaults?.model : undefined) ??
    config.defaultModels[provider];

  const effort =
    readEnv(workKindEnvVar(kind, "EFFORT")) ??
    (blockSpeaks ? block.effort : undefined) ??
    readEnv("PHOEBE_EFFORT") ??
    (definitionSpeaks ? opts.definitionDefaults?.effort : undefined) ??
    config.defaultEfforts[provider];

  return { provider, model, effort };
}
