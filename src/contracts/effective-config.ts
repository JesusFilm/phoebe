// The **effective config** — every setting that changes a tenant's behaviour,
// with its value and where that value came from (#502, #513; map #497).
//
// Not "resolved config": `resolveConfig` is the narrower engine-facing step that
// fills defaults and drops the bootstrapper's fields. This is the whole picture,
// annotated, and it is what an operator sees when they run `phoebe config` and
// what section 5 of the deployment report embeds.
//
// The tree mirrors the config — global leaves, then `pipelines.<name>`, then
// `kinds.<kind>` — so a path in this object is a path in `phoebe.config.ts`.
// A node is a **leaf** when its `source` member is a string; anything else is a
// branch holding more nodes. Branch keys are pipeline and kind names, and a
// branch's own members are always objects, so that test never misfires on a
// pipeline someone called `source`.
//
// Two things deliberately do not live in the tree:
//
//   - **Secrets.** {@link EnvPresence} reports that a variable is set and where
//     it was set, never what it holds. Write-only is the whole point: an
//     operator confirms `ANTHROPIC_API_KEY` reached the container without the
//     key leaving it.
//   - **Advice.** {@link TenantEffectiveConfig.warnings} summarises the
//     deprecated aliases in use so a console need not walk the tree to find
//     them. The leaf's `source: "alias"` stays the truth; the warning is an index.

/**
 * Where a leaf's winning value came from.
 *
 *   - `default`    the shipped default — nothing said otherwise. A leaf with no
 *                  value anywhere reads `{ value: null, source: "default" }`.
 *   - `file`       the tenant's `phoebe.config.ts`; `via` is its path.
 *   - `alias`      a permanent older name — an env alias like `PHOEBE_AGENT`, or
 *                  a superseded config field like `workOrder`. `via` names it.
 *   - `overlay`    a `PHOEBE_*` variable under its catalogued name. The only env
 *                  source: the old `toggle` is gone, because after #513 there is
 *                  one precedence rule and env reads it the same way everywhere.
 *   - `derived`    computed from another setting rather than declared — a kind's
 *                  model falling through to `defaultModels[provider]`, the data
 *                  paths hanging off `repoSlug`. `via` names what it came from.
 *   - `inherited`  a shallower path's value, unchanged at this one. `via` is the
 *                  path inherited from, so a kind shows everything it will use.
 */
export type SettingSource = "default" | "file" | "alias" | "overlay" | "derived" | "inherited";

/**
 * Where an env-sourced value was read. `process` covers everything the engine
 * child inherited without a file to name — the compose file, a shell export, the
 * deployment's own environment. `store` is the tenant secret store (#504), the
 * tier above all three: a console set a value there and no file holds it.
 */
export type EnvLocation = "store" | "rootEnv" | "tenantEnv" | "process";

/**
 * Who reads a setting. `engine` and `bootstrapper` mirror the settings
 * catalogue; `both` exists for a setting either side may read, so a bootstrapper-
 * only field is always distinguishable from one the engine also sees.
 */
export type SettingReader = "engine" | "bootstrapper" | "both";

/**
 * A value that lost. Listed on the winner rather than dropped, because "why
 * isn't my file value taking effect" is the question this view exists to answer,
 * and answering it in place beats making an operator reconstruct the ladder.
 */
export type ShadowedValue = {
  source: SettingSource;
  via?: string;
  value: unknown;
};

/** One setting: what it resolves to, and the whole story of how. */
export type EffectiveLeaf = {
  /**
   * The resolved value. `null` means nothing set it anywhere — a distinct
   * answer from `false` or `0`, both of which are values an operator chose.
   * Replaced by a summary string when `opaque` is set.
   */
  value: unknown;
  source: SettingSource;
  /** The thing that supplied it: an env name, a config path, or a file path. */
  via?: string;
  /** Where an env-sourced value was read; absent unless `source` is env-ish. */
  from?: EnvLocation;
  reader: SettingReader;
  /** The losers, in the order they lost. Absent when nothing else spoke. */
  shadowed?: readonly ShadowedValue[];
  /**
   * The real value does not survive JSON — inline work-kind code, a function.
   * `value` is then a human summary string and nothing may parse it.
   */
  opaque?: boolean;
};

/** A node of the tree: a leaf, or a branch holding more nodes. */
export type EffectiveNode = EffectiveLeaf | EffectiveFields;

/** A branch of the tree, keyed the way the config is. */
export type EffectiveFields = { [key: string]: EffectiveNode };

/**
 * One env variable, presence and location only. `present` is false for a name
 * that is unset *or* set to the empty string: compose's `"${VAR:-}"` passthrough
 * writes blanks, and a blank credential is not a credential.
 *
 * `shadowed` is the store's one loud edge (#504): the secret store outranks the
 * `.env`, and a key set in both would otherwise leave an operator staring at a
 * file edit that does nothing. Flagged here, warned about by doctor, and cleared
 * by clearing the store entry — never by a silent win. Presence is still all
 * this says; a shadowed key does not reveal either value.
 */
export type EnvPresence = { present: boolean; from?: EnvLocation; shadowed?: boolean };

/** The deprecated aliases (and future non-fatal advice) this tenant is using. */
export type ConfigWarning = { path: string; message: string };

/**
 * One tenant's effective config. A tenant whose config will not load yields the
 * same shape with `fields` and `env` null and `error` set — a held tenant, an
 * invalid file and an alias conflict all report identically, because from here
 * they are the same fact: this tenant's settings are unknown.
 */
export type TenantEffectiveConfig = {
  /** The tenant's `repoSlug` when it could be read, else the config's path. */
  tenant: string;
  /**
   * The file this row's settings were read from, when the reader knows it
   * (#503, #547). Stamped by the bootstrapper, which asked one checkout about
   * one config path — so a console can tell the one editable file (the root
   * config, the only read-write mount) from a tenant config that is the
   * operator's to edit in its own checkout. Absent on a row nobody could ask
   * for, and on any answer an older bootstrapper embedded.
   */
  configPath?: string;
  /** Why the settings are unknown, or null when they are known. */
  error: string | null;
  fields: EffectiveFields | null;
  env: Record<string, EnvPresence> | null;
  warnings: readonly ConfigWarning[];
};

/**
 * The shape version of everything above — what `phoebe config --json` prints as
 * its `version` and what the deployment report's config section carries. Bump it
 * when a field's meaning changes in a way an older reader would misread; adding
 * an optional field does not move it.
 *
 * It is here rather than beside the command because two processes name it: the
 * engine that computes a tenant's tree, and the bootstrapper that embeds what
 * the engine answered. A runtime value in contracts is written twice — see
 * index.mjs.
 */
export const EFFECTIVE_CONFIG_VERSION = 1;
