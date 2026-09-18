// The settings catalogue (#530) — every `PHOEBE_*` setting in one registry,
// under one precedence rule:
//
//   **env beats file at a path, and a more specific path beats what it would
//   inherit.**
//
// That one sentence reproduces every ladder Phoebe had grown separately. The
// old split between an "overlay" (scalars applied onto the config before
// `resolveConfig`) and "runtime toggles" (ad-hoc `process.env` reads at the
// point of use) was never two rules — it was one rule read from two places, and
// an operator could not see which name belonged to which. Here a setting is a
// config path plus one env name; the readers ask this module for the name, so
// there is no second place to look.
//
// Three consequences worth stating, because they are the parts a reader trips on:
//
//   - **Env addresses tenant-level and kind-level paths only.** `PHOEBE_<FIELD>`
//     sets the tenant leaf; `PHOEBE_<KIND>_<FIELD>` sets one kind's leaf and
//     beats the kind's config block, which in turn beats the tenant leaf. Named
//     pipelines are file-only: a pipeline's `pollIntervalMs` inherits from the
//     tenant leaf `PHOEBE_POLL_INTERVAL_MS` sets, which is what it already did.
//   - **Renames are permanent aliases**, not deprecations on a clock. The old
//     names live in `.env` files — the one file neither `migrate` nor `upgrade`
//     can edit — so a removal date would be a scheduled promise of breakage.
//   - **Env sets leaves only.** Records keyed by operator-chosen names
//     (`promptFiles`, `providerEnv`, `workOrder`) stay config-file territory.
//
// The catalogue is the contract; the derivation (camelCase path → upper snake)
// is the convention new entries follow. `settings-catalogue.test.ts` fails the
// build on a `PHOEBE_*` name that appears in the tree without being catalogued
// here or listed below as a deployment fact.

import { PROVIDER_NAMES, WORK_KIND_NAMES } from "./config-schema.ts";

/**
 * Who reads a setting: the engine's work loop, or the bootstrapper (`phoebe
 * boot` and the host lifecycle commands). Every setting today is read by
 * exactly one of the two; one read by both would need a third value here.
 */
export type SettingReader = "engine" | "bootstrapper";

/** What a setting's env value parses as. Documentation, not coercion. */
export type SettingType = "string" | "number" | "integer" | "boolean" | "enum";

export type Setting = {
  /**
   * The config path this setting sits at, dotted. `kinds.issues.base` is a path
   * under one work kind; `deployment.slotCap` a field of the bootstrapper-only
   * block.
   */
  path: string;
  /** The env name, derived from the path unless the catalogue says otherwise. */
  env: string;
  /** Earlier names, kept forever. Read after {@link env}, never before it. */
  aliases: readonly string[];
  reader: SettingReader;
  type: SettingType;
  /** The closed set of accepted values, for `type: "enum"`. */
  values?: readonly string[];
  /**
   * The field name this setting takes inside a `kinds.<kind>` block, when it
   * has a per-kind variant. `PHOEBE_<KIND>_<FIELD>` derives from it, so
   * `defaultProvider` (tenant) and `provider` (kind) name one knob at two path
   * depths.
   */
  kindField?: string;
  /** Aliases of the per-kind name, same permanence as {@link aliases}. */
  kindAliases?: readonly string[];
  /**
   * No file field lives at this path — env is the only channel, so nothing at
   * this path can be written onto the config (the catalogue test pins that).
   */
  envOnly?: boolean;
  /**
   * Which env names `applyEnvOverlay` writes onto the config field at this path
   * — in other words *where* the one rule is evaluated for this setting.
   *
   *   - `"all"`: once, as the config is built. Every reader then sees the
   *     winner, which is what a plain tenant scalar wants.
   *   - `"none"`: by the reader that owns the ladder, because a kind block sits
   *     between the kind-level env name and this tenant leaf and the reader has
   *     to see env and file separately to put it there.
   *   - `"canonical"`: the derived name writes the field (plenty of readers want
   *     `defaultProvider`) while the alias keeps the rung it has always had.
   *     `PHOEBE_AGENT` has never written the field, and the provider-mismatch
   *     guard in `selectProviderForKind` reads the field — writing it would let
   *     a kind block's cursor-specific model name reach a Claude run. Both names
   *     land the run on the same provider; the guard stays where it is.
   */
  overlay: "none" | "canonical" | "all";
};

/**
 * `repoSlug` → `PHOEBE_REPO_SLUG`, `deployment.slotCap` → `PHOEBE_DEPLOYMENT_SLOT_CAP`.
 * The convention every new entry follows; the catalogue still spells each name
 * out, so a reader never has to run the derivation in their head.
 */
export function deriveEnvName(path: string): string {
  const snake = path
    .split(".")
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    .join("_");
  return `PHOEBE_${snake.toUpperCase()}`;
}

/**
 * The name of one per-kind setting, e.g. `PHOEBE_REVIEWS_MODEL`. Hyphens in a
 * (custom) kind name map to underscores — unambiguous within the kind name,
 * since `_` is outside the kind-name charset (#350); ambiguity *across* the
 * catalogue is caught by {@link assertNoEnvNameCollisions}.
 */
export function workKindEnvVar(kind: string, field: string): string {
  const knob = deriveEnvName(field).slice("PHOEBE_".length);
  return `PHOEBE_${kind.toUpperCase().replaceAll("-", "_")}_${knob}`;
}

type CatalogueEntry = Omit<Setting, "env" | "aliases"> & {
  env?: string;
  aliases?: readonly string[];
};

function setting(entry: CatalogueEntry): Setting {
  return {
    ...entry,
    env: entry.env ?? deriveEnvName(entry.path),
    aliases: entry.aliases ?? [],
  };
}

/**
 * Every setting Phoebe reads from the environment, in one list — the order the
 * configuration reference prints them in: identity, then policy, then the knobs
 * that protect the host.
 */
export const SETTINGS: readonly Setting[] = [
  // The tenant scalars: a string field, its derived name, nothing else to say.
  // Every one is tenant identity or tenant policy an operator may want to point
  // somewhere else for a single run.
  ...(
    [
      "repoSlug",
      "repoUrl",
      "defaultBranch",
      "branchPrefix",
      "readyLabel",
      "researchLabel",
      "processingLabel",
      "mergedLabel",
      "featureLabel",
      "prOptOutLabel",
      "installCommand",
      "checkCommand",
      "testCommand",
      "readyCommand",
      "blockedByPattern",
      "partOfPattern",
      "reviewsSuccessHeading",
    ] as const
  ).map((path) => setting({ path, reader: "engine", type: "string", overlay: "all" })),
  // The three whose value is checked, not taken verbatim.
  setting({
    path: "prScope",
    reader: "engine",
    type: "enum",
    values: ["phoebe", "all"],
    overlay: "all",
  }),
  setting({
    path: "draftPrs",
    reader: "engine",
    type: "enum",
    values: ["skip-non-phoebe", "skip-all", "include"],
    overlay: "all",
  }),
  setting({
    path: "featureBranchCatchUp",
    reader: "engine",
    type: "boolean",
    overlay: "all",
  }),
  // The provider trio. `model` and `effort` are global leaves meaning "for the
  // active provider" — the value `defaultModels` / `defaultEfforts` fill per
  // provider — which is what makes `PHOEBE_MODEL` and `PHOEBE_EFFORT` plain
  // derived names instead of toggles standing outside the config shape.
  setting({
    path: "defaultProvider",
    aliases: ["PHOEBE_AGENT"],
    reader: "engine",
    type: "enum",
    values: PROVIDER_NAMES,
    kindField: "provider",
    kindAliases: ["agent"],
    overlay: "canonical",
  }),
  setting({
    path: "model",
    reader: "engine",
    type: "string",
    kindField: "model",
    overlay: "none",
  }),
  setting({
    path: "effort",
    reader: "engine",
    type: "string",
    kindField: "effort",
    overlay: "none",
  }),
  setting({
    path: "runTimeoutMs",
    reader: "engine",
    type: "number",
    kindField: "runTimeoutMs",
    overlay: "none",
  }),
  setting({
    path: "maxUnproductiveRuns",
    aliases: ["PHOEBE_MAX_UNIT_TIMEOUTS"],
    reader: "engine",
    type: "integer",
    overlay: "none",
  }),
  // A tenant leaf with no tenant field: a pipeline's own `pollIntervalMs` is the
  // more specific path and outranks it, and a pipeline that declares nothing
  // inherits from here.
  setting({
    path: "pollIntervalMs",
    reader: "engine",
    type: "number",
    envOnly: true,
    overlay: "none",
  }),
  // Env-only under the issues kind: an escape hatch for one run, never a thing a
  // tenant writes down — a config pinning every issue to one base would break
  // blocker stacking on the next issue that needs it.
  setting({
    path: "kinds.issues.base",
    env: "PHOEBE_BASE",
    reader: "engine",
    type: "string",
    envOnly: true,
    overlay: "none",
  }),
  // The three host knobs, fields on the bootstrapper-only `deployment` block so
  // an operator can reach them by editing one config rather than only through an
  // env var set in a compose file they may not own.
  setting({
    path: "deployment.slotCap",
    aliases: ["PHOEBE_MAX_CONCURRENT_AGENTS"],
    reader: "bootstrapper",
    type: "integer",
    overlay: "none",
  }),
  setting({
    path: "deployment.slotFloorBudget",
    aliases: ["PHOEBE_SLOT_FLOOR_BUDGET"],
    reader: "bootstrapper",
    type: "integer",
    overlay: "none",
  }),
  setting({
    path: "deployment.reconcileIntervalMs",
    aliases: ["PHOEBE_RECONCILE_INTERVAL_MS"],
    reader: "bootstrapper",
    type: "number",
    overlay: "none",
  }),
];

/**
 * Names that look like settings and are not. A *fact* is something Phoebe is
 * told about where it is running — written by the scaffolded compose file,
 * reported in the deployment report, never a knob an operator turns to change
 * behaviour. A *credential* is minted, not configured. Neither belongs in the
 * catalogue, and the guard test needs the distinction written down to tell
 * "uncatalogued" from "deliberately not a setting".
 */
export const DEPLOYMENT_FACTS: readonly { name: string; why: string }[] = [
  { name: "PHOEBE_ENGINE_DIR", why: "Where the engine checkout lives; set by the compose file." },
  { name: "PHOEBE_DATA_DIR", why: "Where tenant data lives; every derived path hangs off it." },
  { name: "PHOEBE_GH_LOGIN", why: "The minted GitHub login of the running credential." },
  { name: "PHOEBE_AGENT_VERSION", why: "The container build arg pinning the bootstrapper." },
];

const BY_PATH = new Map(SETTINGS.map((entry) => [entry.path, entry]));

/** The catalogue entry at `path`. Throws on a path the catalogue does not hold. */
export function settingAt(path: string): Setting {
  const entry = BY_PATH.get(path);
  if (entry === undefined) {
    throw new Error(`No setting is catalogued at "${path}" (src/settings-catalogue.ts).`);
  }
  return entry;
}

/** Every env name a setting answers to, the derived one first. */
export function envNames(entry: Setting): readonly string[] {
  return [entry.env, ...entry.aliases];
}

/** Every per-kind env name a setting answers to for `kind`, derived one first. */
export function kindEnvNames(entry: Setting, kind: string): readonly string[] {
  if (entry.kindField === undefined) return [];
  return [
    workKindEnvVar(kind, entry.kindField),
    ...(entry.kindAliases ?? []).map((alias) => workKindEnvVar(kind, alias)),
  ];
}

/** The env names `applyEnvOverlay` writes onto the config field at this path. */
export function overlayEnvNames(entry: Setting): readonly string[] {
  if (entry.overlay === "none") return [];
  return entry.overlay === "all" ? envNames(entry) : [entry.env];
}

/**
 * Every catalogued name an engine child may inherit from the supervisor, and the
 * per-tenant/deployment-global line (bootstrap/engine-child-env.ts builds its
 * allowlist from this).
 *
 * Two exclusions, both structural. A `reader: "bootstrapper"` knob is read by
 * boot itself and a child has no use for it. An `overlay: "all"` setting is
 * tenant identity — `repoSlug`, `installCommand`, the label names — and a
 * deployment-wide value would write *every* tenant's field identically, which is
 * never what an operator meant. What is left is policy: the provider trio, the
 * timeouts, the cadence, the forced base. Those have always been set once for a
 * whole deployment, and each keeps its permanent alias here too.
 */
export function deploymentGlobalEnvNames(
  kinds: readonly string[] = WORK_KIND_NAMES,
): readonly string[] {
  const names: string[] = [];
  for (const entry of SETTINGS) {
    if (entry.reader === "bootstrapper" || entry.overlay === "all") continue;
    names.push(...envNames(entry));
    for (const kind of kinds) names.push(...kindEnvNames(entry, kind));
  }
  return names;
}

/** One env name and the value read from it. */
export type SettingRead = { via: string; value: string };

/**
 * Every name of `names` the environment sets, in precedence order. An empty
 * string reads as unset throughout, so compose's `"${VAR:-}"` passthrough never
 * forces a blank value.
 *
 * Plural on purpose: a reader that validates — a positive integer, a known
 * provider name — falls through to the next name when the first fails its own
 * test, which is how a deprecated alias behaved before the catalogue.
 */
export function readEnvNames(env: NodeJS.ProcessEnv, names: readonly string[]): SettingRead[] {
  const reads: SettingRead[] = [];
  for (const via of names) {
    const value = env[via];
    if (typeof value === "string" && value.length > 0) reads.push({ via, value });
  }
  return reads;
}

/** The first name of `names` the environment sets, or `undefined`. */
export function readEnv(env: NodeJS.ProcessEnv, names: readonly string[]): SettingRead | undefined {
  return readEnvNames(env, names)[0];
}

/** The tenant-level value of `entry`, or `undefined` when no name of it is set. */
export function readSetting(env: NodeJS.ProcessEnv, entry: Setting): SettingRead | undefined {
  return readEnv(env, envNames(entry));
}

/** The `kind`-level value of `entry`, or `undefined` when no name of it is set. */
export function readKindSetting(
  env: NodeJS.ProcessEnv,
  entry: Setting,
  kind: string,
): SettingRead | undefined {
  return readEnv(env, kindEnvNames(entry, kind));
}

/**
 * The first number among `names` that passes the test, else `undefined`. A name
 * set to a value that fails is not an answer, so the next name is asked — the
 * behaviour a deprecated alias has always had.
 *
 * Bounds: `min` is inclusive, `above` exclusive, and with neither the bound is
 * `above: 0` — every knob catalogued as a number is a duration or a count, and
 * zero of either is not a value an operator can have meant.
 *
 * The name comes back with the number so a log line can quote whichever of the
 * permanent aliases the operator actually set.
 */
export function readNumberFrom(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  opts: { integer?: boolean; min?: number; above?: number } = {},
): { via: string; value: number } | undefined {
  const above = opts.min === undefined ? (opts.above ?? 0) : undefined;
  for (const { via, value } of readEnvNames(env, names)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    if (opts.integer === true && !Number.isInteger(parsed)) continue;
    if (opts.min !== undefined && parsed < opts.min) continue;
    if (above !== undefined && parsed <= above) continue;
    return { via, value: parsed };
  }
  return undefined;
}

/** {@link readNumberFrom} without the name — the common case. */
export function readNumber(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  opts: { integer?: boolean; min?: number; above?: number } = {},
): number | undefined {
  return readNumberFrom(env, names, opts)?.value;
}

/**
 * Every env name the catalogue claims, tenant-level and kind-level, for the
 * kinds given. Read by the supervisor's child-env allowlist and by the guard
 * test; `kinds` defaults to the built-ins, because a custom kind's names are
 * only knowable once its tenant config is loaded.
 */
export function catalogueEnvNames(kinds: readonly string[] = WORK_KIND_NAMES): readonly string[] {
  const names: string[] = [];
  for (const entry of SETTINGS) {
    names.push(...envNames(entry));
    for (const kind of kinds) names.push(...kindEnvNames(entry, kind));
  }
  return names;
}

/** Wrap `items` into indented lines no wider than `width`. */
function wrap(items: readonly string[], indent: string, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const candidate = line.length === 0 ? item : `${line}, ${item}`;
    if (indent.length + candidate.length > width && line.length > 0) {
      lines.push(`${indent}${line},`);
      line = item;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) lines.push(`${indent}${line}`);
  return lines.join("\n");
}

/**
 * The catalogue as `phoebe --help` prints it: one rule, one list of names, and
 * the two families that are derived rather than spelled out. Generated so the
 * help can never fall behind the registry — the drift between the old help text
 * and the code was one of the things #530 set out to end.
 */
export function settingsHelp(): string {
  const kindFields = SETTINGS.filter((entry) => entry.kindField !== undefined);
  const aliased = SETTINGS.filter((entry) => entry.aliases.length > 0);
  return [
    "Settings (PHOEBE_*). One rule: env beats the config file at a path, and a more",
    "specific path beats what it would inherit. Full reference: docs/configuration.md.",
    "",
    wrap(
      SETTINGS.map((entry) => entry.env),
      "  ",
      88,
    ),
    "",
    "  Per work kind, outranking that kind's config block:",
    wrap(
      kindFields.map(
        (entry) => `PHOEBE_<KIND>_${deriveEnvName(entry.kindField!).slice("PHOEBE_".length)}`,
      ),
      "    ",
      88,
    ),
    `    where <KIND> is ${WORK_KIND_NAMES.map((kind) => kind.toUpperCase()).join("|")} or a custom`,
    "    kind's name with hyphens as underscores (stale-pr-nudger → STALE_PR_NUDGER).",
    "",
    "  Permanent aliases (no removal date):",
    ...aliased.flatMap((entry) => entry.aliases.map((alias) => `    ${alias} → ${entry.env}`)),
    ...kindFields
      .filter((entry) => (entry.kindAliases ?? []).length > 0)
      .flatMap((entry) =>
        (entry.kindAliases ?? []).map(
          (alias) =>
            `    PHOEBE_<KIND>_${deriveEnvName(alias).slice("PHOEBE_".length)} → ` +
            `PHOEBE_<KIND>_${deriveEnvName(entry.kindField!).slice("PHOEBE_".length)}`,
        ),
      ),
  ].join("\n");
}

/**
 * Reject a kind set whose derived env names collide — with each other, with a
 * tenant-level name, or with an alias. A tenant declaring a custom kind named
 * `default` derives `PHOEBE_DEFAULT_PROVIDER`, which already addresses the
 * tenant leaf; one name would then mean two things depending on which reader
 * asked. A boot error, not a warning: the ambiguity has no safe arm.
 */
export function assertNoEnvNameCollisions(kinds: readonly string[] = WORK_KIND_NAMES): void {
  const owner = new Map<string, string>();
  const claim = (name: string, by: string): void => {
    const held = owner.get(name);
    if (held !== undefined && held !== by) {
      throw new Error(
        `Env name ${name} is claimed by both ${held} and ${by}. ` +
          `One env name addresses one setting — rename the work kind.`,
      );
    }
    owner.set(name, by);
  };
  for (const entry of SETTINGS) {
    for (const name of envNames(entry)) claim(name, `the setting at \`${entry.path}\``);
  }
  for (const kind of kinds) {
    for (const entry of SETTINGS) {
      for (const name of kindEnvNames(entry, kind)) {
        claim(name, `\`kinds.${kind}.${entry.kindField}\``);
      }
    }
  }
}
