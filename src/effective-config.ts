// The effective config, computed (#531; decisions #502 and #513).
//
// One function — {@link computeEffectiveConfig} — annotates every setting a
// tenant runs on with its value and where that value came from, and it is the
// only thing that does. `phoebe config` prints what it returns, the deployment
// report embeds it, and the bootstrapper calls the verb per tenant the way it
// calls `phoebe pipelines`. A second implementation on the bootstrapper side, or
// a doctor-style mirror, is exactly what #502 rejected: two answers to "what is
// this deployment actually running" is worse than none.
//
// Three things shape the code below.
//
// **The catalogue is the key, not the type.** The view walks
// `SETTINGS` (src/settings-catalogue.ts), not the fields of `PhoebeConfig`, so
// every `PHOEBE_*` name that exists is covered by construction — the invariant
// #502 asked for, kept by the catalogue's own guard test rather than restated
// here.
//
// **A ladder is a list of candidates.** Each leaf is built by writing down what
// spoke for it, most specific first ({@link leafFrom}). The head is the winner
// and the tail is `shadowed`, so the thing an operator actually wants — "why
// isn't my file value taking effect" — is answered by the same code that decides
// the value, and the two cannot drift. Where a reader has a quirk the ladder
// alone does not express (the provider-mismatch guard, which silences a kind
// block speaking for a different provider), the quirk moves the candidate down
// the list rather than deleting it.
//
// **It reads nothing.** No filesystem, no `process.env` fallback, no config
// loading. The caller hands over the parsed config and whatever env layers it
// could see; src/config-command.ts is the half that opens files and catches a
// config that will not load at all. That is what makes every ladder here
// testable against a literal, with no deployment underneath it.

import { DEFAULT_RECONCILE_INTERVAL_MS } from "../bootstrap/reconcile.ts";
import { DEFAULT_SLOT_FLOOR_BUDGET } from "../bootstrap/slot-broker.ts";
import type {
  ConfigWarning,
  EffectiveFields,
  EffectiveLeaf,
  EnvLocation,
  EnvPresence,
  SettingReader as LeafReader,
  SettingSource,
  ShadowedValue,
  TenantEffectiveConfig,
} from "./contracts/effective-config.ts";
import {
  CONFIG_DEFAULTS,
  DEFAULT_PIPELINE_NAME,
  DEFAULT_PROMPT_FILE_BY_KIND,
  DEPRECATED_PIPELINE_ALIASES,
  PIPELINE_DEFAULTS,
  PROMPT_FILE_KEY_BY_KIND,
  resolveConfig,
  WORK_KIND_NAMES,
  workKindOverride,
  type PhoebeConfig,
  type PhoebeUserConfig,
  type ProviderName,
  type ResolvedPipeline,
} from "./config-schema.ts";
import { applyEnvOverlay } from "./load-config.ts";
import { pipelineOwnedKinds } from "./pipeline.ts";
import { ENGINE_CREDENTIAL_KEYS } from "./shell-env.ts";
import { envNames, kindEnvNames, SETTINGS, settingAt, type Setting } from "./settings-catalogue.ts";

/**
 * The env as three layers, so a value can say where it was set. The engine child
 * sees one merged environment — the supervisor flattened the files into it long
 * before this runs — so the layers are how a caller hands back the provenance
 * that flattening threw away. Omit a layer and nothing is attributed to it;
 * `process` alone is a correct, less specific answer.
 */
export type EnvLayers = {
  /** What the process inherited: the compose file, a shell export, the image. */
  process?: NodeJS.ProcessEnv;
  /** The deployment root's `.env`, when the caller can read it. */
  root?: NodeJS.ProcessEnv;
  /** This tenant's own `.env`. */
  tenant?: NodeJS.ProcessEnv;
  /**
   * The tenant secret store (#504) — the top tier, above all three files. A key
   * it sets is the value the engine child holds, and the `.env` entry it beat is
   * reported `shadowed` rather than dropped.
   */
  store?: NodeJS.ProcessEnv;
};

/** Everything {@link computeEffectiveConfig} needs, and nothing it can read itself. */
export type EffectiveConfigInput = {
  /** The tenant's config exactly as its file exported it — before overlay or defaults. */
  user: PhoebeUserConfig;
  /** Where that file lives. Named as the `via` of every file-sourced leaf. */
  configPath: string;
  env?: EnvLayers;
  /** Data base for the derived `paths` block; defaults to `resolveConfig`'s. */
  dataBase?: string;
  /**
   * Env keys this tenant's work kinds declared (`requiredEnv` / `agentEnv`).
   * Passed in rather than read here because collecting them means loading the
   * tenant's kind modules, which is I/O and can fail on its own.
   */
  declaredEnv?: readonly string[];
};

/** A value that spoke for a leaf. The first one in a list wins; the rest shadow. */
type Candidate = {
  source: SettingSource;
  via?: string;
  from?: EnvLocation;
  value: unknown;
};

const PROVIDER_SETTING = settingAt("defaultProvider");
const MODEL_SETTING = settingAt("model");
const EFFORT_SETTING = settingAt("effort");
const RUN_TIMEOUT_SETTING = settingAt("runTimeoutMs");
const POLL_INTERVAL_SETTING = settingAt("pollIntervalMs");
const BASE_SETTING = settingAt("kinds.issues.base");

/**
 * Defaults for the catalogued paths `CONFIG_DEFAULTS` does not hold. The three
 * host knobs live with the bootstrapper that reads them, and the tenant-level
 * `pollIntervalMs` has no config field at all — a pipeline's cadence is what it
 * feeds, so the pipeline default is its default too.
 */
const EXTRA_DEFAULTS: Readonly<Record<string, unknown>> = {
  pollIntervalMs: PIPELINE_DEFAULTS.pollIntervalMs,
  "deployment.slotFloorBudget": DEFAULT_SLOT_FLOOR_BUDGET,
  "deployment.reconcileIntervalMs": DEFAULT_RECONCILE_INTERVAL_MS,
};

/**
 * Bootstrapper-only blocks the catalogue does not name, because no env var
 * addresses them. They are in the view anyway (#502): an operator debugging a
 * deployment that will not come up is asking about `engine` and `workspace` far
 * more often than about a label name.
 */
const BOOTSTRAPPER_BLOCKS = [
  "engine",
  "workspace",
  "configDir",
  "gitIdentity",
  "reporting",
] as const satisfies readonly (keyof PhoebeUserConfig)[];

/** The `deployment` block's lifecycle half — strings, and bootstrapper-only. */
const DEPLOYMENT_COMMANDS = ["startCommand", "stopCommand", "stopNowCommand"] as const;

/**
 * Engine-read config fields with no env name: nothing in the catalogue covers
 * them, and leaving them out would mean an operator could not see which model a
 * provider actually resolves to.
 */
const FILE_ONLY_RECORDS = ["defaultModels", "defaultEfforts", "providerEnv"] as const;
const FILE_ONLY_SCALARS = ["creditIssueAuthor", "disabled"] as const;

// --- env layers -------------------------------------------------------------

/** A value the environment actually supplies. Blank reads as unset everywhere. */
function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The environment as the engine child would see it: what the process holds, with
 * the root `.env` and then the tenant's own written over it — the order the
 * supervisor layers them in. Blank values never overwrite, so an empty
 * `GH_TOKEN=` in a file cannot hide one the process has.
 */
function mergeLayers(layers: EnvLayers): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...layers.process };
  for (const layer of [layers.root, layers.tenant, layers.store]) {
    if (layer === undefined) continue;
    for (const [name, value] of Object.entries(layer)) {
      if (isSet(value)) merged[name] = value;
    }
  }
  return merged;
}

/** Which layer set `name` — the most specific one that did. */
function locate(layers: EnvLayers, name: string): EnvLocation {
  if (isSet(layers.store?.[name])) return "store";
  if (isSet(layers.tenant?.[name])) return "tenantEnv";
  if (isSet(layers.root?.[name])) return "rootEnv";
  return "process";
}

// --- leaves -----------------------------------------------------------------

/**
 * Build a leaf from its ladder. The head is the value; everything behind it is
 * recorded as shadowed rather than dropped. An empty ladder is a leaf nothing
 * set anywhere, which reads as `null` from the shipped default — distinct from
 * `false` or `0`, both of which are answers somebody chose.
 */
function leafFrom(candidates: readonly Candidate[], reader: LeafReader): EffectiveLeaf {
  const [winner, ...losers] = candidates;
  if (winner === undefined) return { value: null, source: "default", reader };
  // A fallback that lost is not news — every leaf anybody declared has a default
  // or a derivation under it, and listing those would bury the shadow that
  // matters (a file value an env var beat, a kind block the provider guard
  // silenced) under one of noise per line.
  const shadowed: ShadowedValue[] = losers
    .filter((candidate) => candidate.source !== "default" && candidate.source !== "derived")
    .map((candidate) => ({
      source: candidate.source,
      ...(candidate.via !== undefined ? { via: candidate.via } : {}),
      value: summarize(candidate.value),
    }));
  const opaque = !isSerializable(winner.value);
  return {
    value: summarize(winner.value),
    source: winner.source,
    ...(winner.via !== undefined ? { via: winner.via } : {}),
    ...(winner.from !== undefined ? { from: winner.from } : {}),
    reader,
    ...(shadowed.length > 0 ? { shadowed } : {}),
    ...(opaque ? { opaque: true } : {}),
  };
}

/**
 * Whether a value survives the round trip through JSON a console needs. An
 * inline work-kind definition does not: it holds the kind's own `fetch` and
 * `run` functions, and `JSON.stringify` silently drops them, which would render
 * a configured kind as an empty object.
 */
function isSerializable(value: unknown): boolean {
  if (typeof value === "function") return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(isSerializable);
  return Object.values(value as Record<string, unknown>).every(isSerializable);
}

/** A value as the leaf carries it: itself, or a summary string when it cannot be. */
function summarize(value: unknown): unknown {
  if (isSerializable(value)) return value;
  if (typeof value === "function") return `<function ${value.name || "anonymous"}>`;
  const keys = Object.keys(value as Record<string, unknown>).join(", ");
  return `<inline definition: ${keys}>`;
}

/**
 * One env name's value as the config field at this path would hold it. Booleans
 * and numbers are converted so the JSON reads like the config rather than like
 * the environment; a value that fails its own type is left as the string the
 * operator typed, because hiding a typo behind `NaN` helps nobody.
 */
function coerce(entry: Setting, raw: string): unknown {
  if (entry.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }
  if (entry.type === "number" || entry.type === "integer") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

/**
 * Every env name of `names` the environment sets, in precedence order. The
 * catalogued name is an `overlay`; an older name that still works is an `alias`,
 * which is what the top-level warnings index.
 */
function envCandidates(
  entry: Setting,
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  layers: EnvLayers,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [index, name] of names.entries()) {
    const raw = env[name];
    if (!isSet(raw)) continue;
    candidates.push({
      source: index === 0 ? "overlay" : "alias",
      via: name,
      from: locate(layers, name),
      value: coerce(entry, raw),
    });
  }
  return candidates;
}

/** A candidate for a value the config file declared, or nothing when it did not. */
function fileCandidate(value: unknown, via: string): Candidate[] {
  return value === undefined ? [] : [{ source: "file", via, value }];
}

/** A candidate that takes a shallower path's value unchanged. */
function inherit(from: EffectiveLeaf, path: string): Candidate[] {
  return [{ source: "inherited", via: path, value: from.value }];
}

/** A candidate computed from another setting rather than declared anywhere. */
function derive(value: unknown, from: string): Candidate[] {
  return value === undefined ? [] : [{ source: "derived", via: from, value }];
}

/** A candidate for the shipped default, or nothing when there is no default. */
function fallback(value: unknown): Candidate[] {
  return value === undefined ? [] : [{ source: "default", value }];
}

/** The value at a dotted path of the user's config file, or `undefined`. */
function fileValueAt(user: PhoebeUserConfig, path: string): unknown {
  let node: unknown = user;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

// --- the tenant-level leaves ------------------------------------------------

/**
 * One catalogued tenant-level setting: env (catalogued name, then permanent
 * aliases), then the config file, then the shipped default. The catalogue's one
 * rule at its shallowest — env beats file at a path.
 */
function catalogueLeaf(opts: {
  entry: Setting;
  user: PhoebeUserConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  layers: EnvLayers;
  /** Ahead of the default, for a leaf whose fallback is computed (`model`). */
  derived?: Candidate[];
}): EffectiveLeaf {
  const { entry, user, env, layers } = opts;
  const declared = entry.envOnly === true ? undefined : fileValueAt(user, entry.path);
  return leafFrom(
    [
      ...envCandidates(entry, envNames(entry), env, layers),
      ...fileCandidate(declared, opts.configPath),
      ...(opts.derived ?? []),
      ...fallback(defaultFor(entry.path)),
    ],
    entry.reader,
  );
}

/** The shipped default at a catalogued path, or `undefined` when it has none. */
function defaultFor(path: string): unknown {
  if (path in EXTRA_DEFAULTS) return EXTRA_DEFAULTS[path];
  return (CONFIG_DEFAULTS as Record<string, unknown>)[path];
}

// --- the tree ---------------------------------------------------------------

/**
 * Compute one tenant's effective config. Total: a config that will not resolve
 * comes back as the error arm rather than as a throw, because a fleet report
 * with one broken tenant in it is still a report, and `phoebe config` is exactly
 * the command an operator reaches for when a tenant is broken.
 */
export function computeEffectiveConfig(input: EffectiveConfigInput): TenantEffectiveConfig {
  const layers = input.env ?? {};
  const env = mergeLayers(layers);
  const tenant = readableSlug(input.user) ?? input.configPath;
  let config: PhoebeConfig;
  try {
    // Resolved from the *overlaid* config, because that is what the engine
    // would run: a required field supplied only by `PHOEBE_REPO_SLUG` is a
    // working tenant, and a view that called it broken would be lying. The
    // annotations below still read the raw file, which is what keeps `file`
    // distinguishable from `overlay`.
    config = resolveConfig(
      applyEnvOverlay(input.user, env),
      input.dataBase !== undefined ? { dataBase: input.dataBase } : {},
    );
  } catch (error) {
    return {
      tenant,
      error: error instanceof Error ? error.message : String(error),
      fields: null,
      env: null,
      warnings: [],
    };
  }

  const globals = globalFields({ ...input, config, env, layers });
  const fields: EffectiveFields = {
    ...globals,
    deployment: deploymentFields({ ...input, config, env, layers }),
    pipelines: pipelineFields({ ...input, config, env, layers, globals }),
  };
  return {
    tenant,
    error: null,
    fields,
    env: envSection({ config, layers, env, declaredEnv: input.declaredEnv ?? [] }),
    warnings: warningsFor(input.user, fields),
  };
}

/** The error arm, for a tenant whose config never got as far as parsing. */
export function effectiveConfigError(tenant: string, error: unknown): TenantEffectiveConfig {
  return {
    tenant,
    error: error instanceof Error ? error.message : String(error),
    fields: null,
    env: null,
    warnings: [],
  };
}

/** The tenant's own name for itself, when the file got far enough to have one. */
function readableSlug(user: PhoebeUserConfig): string | null {
  return typeof user.repoSlug === "string" && user.repoSlug.length > 0 ? user.repoSlug : null;
}

type Pass = EffectiveConfigInput & {
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  layers: EnvLayers;
};

/** The tenant-level leaves: the catalogue's own, plus the file-only fields. */
function globalFields(pass: Pass): EffectiveFields {
  const { user, config, env, layers, configPath } = pass;
  const fields: EffectiveFields = {};
  for (const entry of SETTINGS) {
    // The dotted paths belong to other sections, and the two provider-relative
    // leaves need a derivation the loop has no provider to compute yet.
    if (entry.path.includes(".") || entry === MODEL_SETTING || entry === EFFORT_SETTING) continue;
    fields[entry.path] = catalogueLeaf({ entry, user, configPath, env, layers });
  }

  // `model` and `effort` mean "for the active provider", so their fallback is
  // the per-provider record rather than a constant — the derivation #513 made
  // `PHOEBE_MODEL` a plain derived name for.
  const provider = (fields["defaultProvider"] as EffectiveLeaf).value as ProviderName;
  fields["model"] = catalogueLeaf({
    entry: MODEL_SETTING,
    user,
    configPath,
    env,
    layers,
    derived: derive(config.defaultModels[provider], `defaultModels.${provider}`),
  });
  fields["effort"] = catalogueLeaf({
    entry: EFFORT_SETTING,
    user,
    configPath,
    env,
    layers,
    derived: derive(config.defaultEfforts[provider], `defaultEfforts.${provider}`),
  });

  // The bootstrapper's own top-level blocks. `resolveConfig` drops them, which
  // is exactly why they are here: an operator debugging a deployment that will
  // not come up asks about `engine` and `workspace` far more often than about a
  // label name, and until now nothing printed them at all.
  for (const block of BOOTSTRAPPER_BLOCKS) {
    fields[block] = leafFrom(fileCandidate(user[block], configPath), "bootstrapper");
  }

  for (const key of FILE_ONLY_RECORDS) {
    const record = config[key] as Record<string, unknown>;
    const branch: EffectiveFields = {};
    for (const [name, value] of Object.entries(record)) {
      branch[name] = leafFrom(
        [
          ...fileCandidate((user[key] as Record<string, unknown> | undefined)?.[name], configPath),
          ...fallback(value),
        ],
        "engine",
      );
    }
    fields[key] = branch;
  }
  for (const key of FILE_ONLY_SCALARS) {
    fields[key] = leafFrom(
      [...fileCandidate(user[key], configPath), ...fallback(CONFIG_DEFAULTS[key])],
      "engine",
    );
  }

  // Derived, never declared: the tenant's on-disk layout is a function of its
  // slug, which is what keeps a tenant's data from drifting away from its name.
  const paths: EffectiveFields = {};
  for (const [name, value] of Object.entries(config.paths)) {
    paths[name] = leafFrom(derive(value, "repoSlug"), "both");
  }
  fields["paths"] = paths;
  return fields;
}

/** The bootstrapper's blocks: the host knobs, the lifecycle commands, and the rest. */
function deploymentFields(pass: Pass): EffectiveFields {
  const { user, config, env, layers, configPath } = pass;
  const fields: EffectiveFields = {};
  for (const entry of SETTINGS) {
    if (!entry.path.startsWith("deployment.")) continue;
    const name = entry.path.slice("deployment.".length);
    // The cap an operator does not set is `max(concurrency)` across the live
    // pipelines (bootstrap/slot-broker.ts) — a derivation, so it says so.
    const derived =
      name === "slotCap"
        ? derive(
            Math.max(1, ...Object.values(config.pipelines).map((pipeline) => pipeline.concurrency)),
            "max(pipelines.*.concurrency)",
          )
        : [];
    fields[name] = catalogueLeaf({ entry, user, configPath, env, layers, derived });
  }
  for (const command of DEPLOYMENT_COMMANDS) {
    fields[command] = leafFrom(
      fileCandidate(user.deployment?.[command], configPath),
      "bootstrapper",
    );
  }
  return fields;
}

/** One branch per pipeline, and one branch per kind beneath it. */
function pipelineFields(pass: Pass & { globals: EffectiveFields }): EffectiveFields {
  const { user, config, env, layers, configPath, globals } = pass;
  const fields: EffectiveFields = {};
  for (const [name, pipeline] of Object.entries(config.pipelines)) {
    const declared = user.pipelines?.[name];
    const isDefault = name === DEFAULT_PIPELINE_NAME;
    const owned = ownedKinds(config, name, pipeline);
    const branch: EffectiveFields = {
      // Priority, not membership: what the pipeline names first, then everything
      // else it owns. A pipeline that names nothing still has an order.
      order: leafFrom(
        [
          ...fileCandidate(declared?.order, configPath),
          ...(isDefault && user.workOrder !== undefined
            ? [{ source: "alias" as const, via: "workOrder", value: user.workOrder }]
            : []),
          ...derive(owned, "the kinds this pipeline owns"),
        ],
        "engine",
      ),
      concurrency: leafFrom(
        [
          ...fileCandidate(declared?.concurrency, configPath),
          ...fallback(PIPELINE_DEFAULTS.concurrency),
        ],
        "engine",
      ),
      // A named pipeline is file-only (#513 decision 2): the env name addresses
      // the tenant leaf this inherits from, never one pipeline.
      pollIntervalMs: leafFrom(
        [
          ...fileCandidate(declared?.pollIntervalMs, configPath),
          ...inherit(globals["pollIntervalMs"] as EffectiveLeaf, POLL_INTERVAL_SETTING.path),
        ],
        "engine",
      ),
      disabled: leafFrom(
        [...fileCandidate(declared?.disabled, configPath), ...fallback(PIPELINE_DEFAULTS.disabled)],
        "engine",
      ),
      priority: leafFrom(
        [...fileCandidate(declared?.priority, configPath), ...fallback(PIPELINE_DEFAULTS.priority)],
        "engine",
      ),
    };
    const kinds: EffectiveFields = {};
    for (const kind of owned) {
      kinds[kind] = kindFields({ kind, pipeline, pass, globals });
    }
    branch["kinds"] = kinds;
    fields[name] = branch;
  }
  return fields;
}

/**
 * The kinds a pipeline owns. An `order` naming a kind that does not exist is a
 * boot error everywhere else; here it degrades to the built-ins, because a view
 * that refuses to render is no help in finding the typo it is refusing over.
 */
function ownedKinds(
  config: PhoebeConfig,
  name: string,
  pipeline: ResolvedPipeline,
): readonly string[] {
  try {
    return pipelineOwnedKinds({ pipelines: config.pipelines, name, pipeline });
  } catch {
    return WORK_KIND_NAMES;
  }
}

/**
 * One kind's leaves. Every knob is the same ladder read at one kind's depth —
 * per-kind env, the kind's own block, then the tenant leaf it inherits — with
 * one wrinkle worth stating: a block speaks for one provider (its own, else
 * `defaultProvider`), so when an env var has moved the run to a different CLI
 * the block's `model` and `effort` drop below the inherited value instead of
 * winning. They are still listed, as shadowed, which is the whole reason an
 * operator can see that guard fire at all (it was invisible before this view).
 */
function kindFields(opts: {
  kind: string;
  pipeline: ResolvedPipeline;
  pass: Pass;
  globals: EffectiveFields;
}): EffectiveFields {
  const { kind, pipeline, globals } = opts;
  const { env, layers, configPath } = opts.pass;
  const block = workKindOverride(pipeline.kinds, kind);
  const declaration = pipeline.kinds[kind];

  const kindEnv = (entry: Setting): Candidate[] =>
    envCandidates(entry, kindEnvNames(entry, kind), env, layers);

  const providerLeaf = leafFrom(
    [
      ...kindEnv(PROVIDER_SETTING),
      ...fileCandidate(block?.provider, configPath),
      ...inherit(globals["defaultProvider"] as EffectiveLeaf, PROVIDER_SETTING.path),
    ],
    "engine",
  );
  const globalProvider = (globals["defaultProvider"] as EffectiveLeaf).value;
  const speaks = (block?.provider ?? globalProvider) === providerLeaf.value;
  // The block's rung when it speaks for this run's provider, and the rung below
  // the inherited value when it does not.
  const blockKnob = (value: unknown): { ahead: Candidate[]; behind: Candidate[] } => {
    const candidate = fileCandidate(value, configPath);
    return speaks ? { ahead: candidate, behind: [] } : { ahead: [], behind: candidate };
  };

  const model = blockKnob(block?.model);
  const effort = blockKnob(block?.effort);
  const fields: EffectiveFields = {
    provider: providerLeaf,
    model: leafFrom(
      [
        ...kindEnv(MODEL_SETTING),
        ...model.ahead,
        ...inherit(globals["model"] as EffectiveLeaf, MODEL_SETTING.path),
        ...model.behind,
      ],
      "engine",
    ),
    effort: leafFrom(
      [
        ...kindEnv(EFFORT_SETTING),
        ...effort.ahead,
        ...inherit(globals["effort"] as EffectiveLeaf, EFFORT_SETTING.path),
        ...effort.behind,
      ],
      "engine",
    ),
    runTimeoutMs: leafFrom(
      [
        ...kindEnv(RUN_TIMEOUT_SETTING),
        ...fileCandidate(block?.runTimeoutMs, configPath),
        ...inherit(globals["runTimeoutMs"] as EffectiveLeaf, RUN_TIMEOUT_SETTING.path),
      ],
      "engine",
    ),
    disabled: leafFrom(
      [...fileCandidate(block?.disabled, configPath), ...fallback(false)],
      "engine",
    ),
    promptFile: promptFileLeaf({ kind, block, pass: opts.pass }),
  };

  // Env-only, and only under the issues kind: a forced base is an escape hatch
  // for one run, never something a tenant writes down. Its name predates the
  // derivation convention, so the catalogue spells it — `PHOEBE_BASE`.
  if (kind === "issues") {
    fields["base"] = leafFrom(
      envCandidates(BASE_SETTING, envNames(BASE_SETTING), env, layers),
      "engine",
    );
  }

  // What this kind *is*, when the tenant replaced or invented it: a module path,
  // or an inline definition — the opaque case the leaf type exists for, since
  // the definition's `fetch` and `run` do not survive JSON.
  const declaredPath = modulePathOf(declaration);
  if (declaredPath !== undefined) {
    fields["path"] = leafFrom(fileCandidate(declaredPath, configPath), "engine");
  } else if (declaration !== undefined && !isBuiltInKind(kind)) {
    fields["definition"] = leafFrom(fileCandidate(declaration, configPath), "engine");
  }
  return fields;
}

function isBuiltInKind(kind: string): boolean {
  return (WORK_KIND_NAMES as readonly string[]).includes(kind);
}

/** The module path a kind declaration names, through either arm, or `undefined`. */
function modulePathOf(declaration: unknown): string | undefined {
  if (typeof declaration === "string") return declaration;
  if (typeof declaration !== "object" || declaration === null) return undefined;
  const path = (declaration as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

/**
 * Where this kind's prompt comes from: its block's `promptFile`, else the
 * deprecated `promptFiles` key that used to hold it, else the kind's own
 * shipped path. A custom kind's default lives on its definition, which is not
 * loaded here, so it reads as unset rather than as a guess.
 */
function promptFileLeaf(opts: {
  kind: string;
  block: ReturnType<typeof workKindOverride>;
  pass: Pass;
}): EffectiveLeaf {
  const { kind, block } = opts;
  const { user, configPath } = opts.pass;
  const promptKey = (PROMPT_FILE_KEY_BY_KIND as Record<string, string | undefined>)[kind];
  const aliased =
    promptKey === undefined
      ? undefined
      : (user.promptFiles as Record<string, string | undefined> | undefined)?.[promptKey];
  const shipped = (DEFAULT_PROMPT_FILE_BY_KIND as Record<string, string | undefined>)[kind];
  return leafFrom(
    [
      ...fileCandidate(block?.promptFile, configPath),
      ...(aliased !== undefined
        ? [{ source: "alias" as const, via: `promptFiles.${promptKey}`, value: aliased }]
        : []),
      ...fallback(shipped),
    ],
    "engine",
  );
}

// --- the env section --------------------------------------------------------

/**
 * Every env name this tenant needs, present or not — and never a value. This is
 * the presence half of a write-only secret: an operator confirms the key reached
 * the container without the key leaving it.
 */
function envSection(opts: {
  config: PhoebeConfig;
  layers: EnvLayers;
  env: NodeJS.ProcessEnv;
  declaredEnv: readonly string[];
}): Record<string, EnvPresence> {
  const names = [
    ...ENGINE_CREDENTIAL_KEYS,
    ...Object.values(opts.config.providerEnv),
    ...opts.declaredEnv,
    // Whatever the store holds, even a key nothing declares any more: a stale
    // entry left behind by a retired work kind is still the value a child would
    // hold, and a section that omitted it would hide it.
    ...Object.keys(opts.layers.store ?? {}),
  ];
  const section: Record<string, EnvPresence> = {};
  for (const name of names) {
    if (name in section) continue;
    const present = isSet(opts.env[name]);
    if (!present) {
      section[name] = { present };
      continue;
    }
    const from = locate(opts.layers, name);
    // The store's collision, named where an operator will look for it: a `.env`
    // or ambient value that the store outranks (#504).
    const shadowed =
      from === "store" &&
      (isSet(opts.layers.tenant?.[name]) ||
        isSet(opts.layers.root?.[name]) ||
        isSet(opts.layers.process?.[name]));
    section[name] = shadowed ? { present, from, shadowed } : { present, from };
  }
  return section;
}

// --- warnings ---------------------------------------------------------------

/**
 * The deprecated aliases in use, indexed so a console need not walk the tree.
 * Two families, and both are permanent: an env name that was renamed (#513
 * decision 4) and a config field `pipelines` replaced (#415). Neither has a
 * removal date, so the warning says "still works", not "will break".
 */
function warningsFor(user: PhoebeUserConfig, fields: EffectiveFields): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  walkLeaves(fields, (path, leaf) => {
    if (leaf.source !== "alias" || leaf.via === undefined) return;
    const setting = SETTINGS.find((entry) => envNames(entry).includes(leaf.via!));
    warnings.push({
      path,
      message:
        setting === undefined
          ? `\`${leaf.via}\` is a permanent alias and still works; the current name is on the field it replaced.`
          : `\`${leaf.via}\` is a permanent alias for \`${setting.env}\` and still works — no removal date.`,
    });
  });
  for (const { alias, replacement } of DEPRECATED_PIPELINE_ALIASES) {
    if (user[alias] === undefined) continue;
    warnings.push({
      path: alias,
      message: `\`${alias}\` is the deprecated alias for \`${replacement}\`; \`phoebe migrate\` moves it.`,
    });
  }
  if (user.maxUnitTimeouts !== undefined) {
    warnings.push({
      path: "maxUnitTimeouts",
      message: "`maxUnitTimeouts` is the deprecated alias for `maxUnproductiveRuns`.",
    });
  }
  return warnings;
}

/** Whether a node is a leaf: only a leaf carries a string `source`. */
export function isLeaf(node: unknown): node is EffectiveLeaf {
  return (
    typeof node === "object" &&
    node !== null &&
    typeof (node as { source?: unknown }).source === "string"
  );
}

/** Visit every leaf of the tree, depth first, with its dotted path. */
export function walkLeaves(
  fields: EffectiveFields,
  visit: (path: string, leaf: EffectiveLeaf) => void,
  prefix = "",
): void {
  for (const [key, node] of Object.entries(fields)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isLeaf(node)) visit(path, node);
    else walkLeaves(node, visit, path);
  }
}
