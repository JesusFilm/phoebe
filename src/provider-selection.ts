// Per-work-kind provider/model/effort resolution (#300). Pure — the engine's
// `selectProvider` (src/main.ts) wraps this with the actual Provider lookup —
// so the ladder is unit-testable without building an engine.
//
// Each knob resolves independently, most specific wins — the settings
// catalogue's one rule (env beats file at a path; a more specific path beats
// what it would inherit) read at one kind's depth:
//
//   1. per-kind env      (PHOEBE_REVIEWS_MODEL)
//   2. per-kind config   (workKinds.reviews.model)
//   3. global env        (PHOEBE_MODEL)
//   4. the global leaf   (model / effort / defaultProvider)
//   5. repo defaults     (the kind definition's, then defaultModels / defaultEfforts)
//
// Per-kind *config* deliberately outranks global *env*: a kind's block is
// durable policy that survives a blanket `PHOEBE_MODEL`/`PHOEBE_AGENT`
// override; only the kind-specific env var pushes it aside. Every name here
// comes from the catalogue, which is what makes `PHOEBE_<KIND>_PROVIDER` and
// its permanent alias `PHOEBE_<KIND>_AGENT` one rung rather than two.

import {
  PROVIDER_NAMES,
  workKindOverride,
  type PhoebeConfig,
  type ProviderName,
} from "./config-schema.ts";
import {
  readKindSetting,
  readSetting,
  settingAt,
  workKindEnvVar as catalogueWorkKindEnvVar,
} from "./settings-catalogue.ts";

export type ProviderSelection = {
  provider: ProviderName;
  model: string;
  /** Unset means "pass no effort flag" — the provider CLI's own default stands. */
  effort: string | undefined;
};

/** The per-kind settings: one env name per knob a kind block holds. */
export type WorkKindEnvKnob = "PROVIDER" | "AGENT" | "MODEL" | "EFFORT" | "RUN_TIMEOUT_MS";

/**
 * The name of one per-kind setting, e.g. `PHOEBE_REVIEWS_MODEL`. The
 * catalogue owns the derivation (src/settings-catalogue.ts); this keeps the
 * knob-shaped spelling its callers already use.
 */
export function workKindEnvVar(kind: string, knob: WorkKindEnvKnob): string {
  return catalogueWorkKindEnvVar(kind, knob.toLowerCase());
}

const PROVIDER_SETTING = settingAt("defaultProvider");
const MODEL_SETTING = settingAt("model");
const EFFORT_SETTING = settingAt("effort");

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
  config: Pick<
    PhoebeConfig,
    "defaultProvider" | "defaultModels" | "defaultEfforts" | "workKinds" | "model" | "effort"
  >;
  /**
   * The kind definition's own `model`/`effort` defaults (#303): they sit at
   * the repo-defaults rung — above `defaultModels`/`defaultEfforts`, below
   * everything the tenant or the environment says.
   */
  definitionDefaults?: { model?: string; effort?: string };
}): ProviderSelection {
  const { kind, env, config } = opts;
  const block = workKindOverride(config.workKinds, kind);

  const assertProvider = (name: string, source: string): ProviderName => {
    if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Unknown ${source} "${name}". Use one of: ${PROVIDER_NAMES.join(", ")}.`);
    }
    return name as ProviderName;
  };

  // `via` names whichever name the operator actually set, so an unknown value
  // is reported against the variable they typed rather than its canonical twin.
  const perKindProvider = readKindSetting(env, PROVIDER_SETTING, kind);
  const globalProvider = readSetting(env, PROVIDER_SETTING);
  const provider =
    perKindProvider !== undefined
      ? assertProvider(perKindProvider.value, perKindProvider.via)
      : (block?.provider ??
        (globalProvider !== undefined
          ? assertProvider(globalProvider.value, globalProvider.via)
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
    readKindSetting(env, MODEL_SETTING, kind)?.value ??
    (blockSpeaks ? block.model : undefined) ??
    readSetting(env, MODEL_SETTING)?.value ??
    config.model ??
    (definitionSpeaks ? opts.definitionDefaults?.model : undefined) ??
    config.defaultModels[provider];

  // `null` is an explicit clear — stop the ladder and pass no effort flag.
  // `undefined` (absent) falls through to global env / definition defaults /
  // repo defaults.
  const effortFromKindEnv = readKindSetting(env, EFFORT_SETTING, kind)?.value;
  const blockEffort = blockSpeaks ? block?.effort : undefined;
  const effort: string | undefined =
    effortFromKindEnv !== undefined
      ? effortFromKindEnv
      : blockEffort !== undefined
        ? blockEffort === null
          ? undefined
          : blockEffort
        : (readSetting(env, EFFORT_SETTING)?.value ??
          config.effort ??
          (definitionSpeaks ? opts.definitionDefaults?.effort : undefined) ??
          config.defaultEfforts[provider]);

  return { provider, model, effort };
}
