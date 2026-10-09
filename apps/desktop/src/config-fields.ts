// The settings a config form can offer, read off a config's source.
//
// A workspace root and a tenant are two different configs. The root says which
// engine runs, where the fleet is and where Phoebe reports its own faults, and
// nothing else in it is read; a tenant says what one repository's work looks
// like. So the form over each is its own list, and a solo install, whose one
// config is both, gets both.
//
// A tenant's rows are the settings catalogue's (src/settings-catalogue.ts):
// every setting a file can carry at the top of the config. The deployment's are
// the handful of leaves a root holds. Two of its blocks are closed to `config
// set`, so their rows are shown and not offered for change, with the reason.
//
// Read as source, never loaded, for the reason install-facts.ts gives: loading a
// config runs the operator's TypeScript in the companion's own process. So a
// value that is not a plain literal is handed over as it is written, and the
// form shows it without offering to replace it.

import type { ConfigFieldFacts } from "phoebe-agent/contracts";
import { DEFAULT_ENGINE_REPO } from "../../../bootstrap/engine-source.ts";
import { editConfigGetFieldAt } from "../../../src/config-handle.ts";
import { CONFIG_DEFAULTS } from "../../../src/config-schema.ts";
import { SETTINGS } from "../../../src/settings-catalogue.ts";

/** Which config this is: a workspace's root, one of its children, or a solo install's. */
export type ConfigRole = "workspace" | "tenant" | "solo";

type Row = Pick<
  ConfigFieldFacts,
  | "path"
  | "scope"
  | "type"
  | "values"
  | "suggestions"
  | "env"
  | "locked"
  | "via"
  | "listAlternative"
> & {
  fallback?: string | number | boolean;
  /**
   * The config path a fresh list for this row starts from (#655), straight off
   * the catalogue. Resolved against the file being read, so the prefill is this
   * config's value and not the shipped default when the file states one.
   */
  prefillFrom?: string;
};

/**
 * What a text box is worth offering before anything is typed. Not a closed set:
 * a model name the provider gained yesterday is as good as any here.
 */
const SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  model: Object.values(CONFIG_DEFAULTS.defaultModels),
  effort: ["low", "medium", "high", "xhigh", "max"],
  defaultBranch: ["main", "master", "develop"],
};

/**
 * The leaves of the closed `engine` block the companion writes with `config
 * set` (verb-dispatch.ts). The ref is not one: it goes through `upgrade`.
 */
export const LOCAL_OPEN_PATHS: readonly string[] = ["engine.source", "engine.repo"];

const FLEET_LOCK = "The fleet declaration is a git edit.";

/** What a root config says about the deployment, in the order the template writes it. */
const DEPLOYMENT_ROWS: readonly Row[] = [
  {
    path: "engine.source",
    scope: "deployment",
    type: "enum",
    values: ["github", "local"],
    fallback: "github",
  },
  {
    path: "engine.repo",
    scope: "deployment",
    type: "string",
    suggestions: [DEFAULT_ENGINE_REPO],
    fallback: DEFAULT_ENGINE_REPO,
  },
  // Saved through `upgrade`, so the new ref's migrations run with the move.
  { path: "engine.ref", scope: "deployment", type: "string", fallback: "main", via: "upgrade" },
  { path: "reporting.maintainers", scope: "deployment", type: "boolean", fallback: false },
  { path: "reporting.dsn", scope: "deployment", type: "string" },
  { path: "reporting.includeRef", scope: "deployment", type: "boolean", fallback: false },
];

/** The fleet's own rows, which only a workspace root has. */
const FLEET_ROWS: readonly Row[] = [
  {
    path: "workspace.depth",
    scope: "deployment",
    type: "integer",
    fallback: 1,
    locked: FLEET_LOCK,
  },
  { path: "workspace.tenants", scope: "deployment", type: "string", locked: FLEET_LOCK },
];

/** The catalogue's settings a tenant's form offers: a file field, at the top of the config. */
const TENANT_ROWS: readonly Row[] = SETTINGS.filter(
  (setting) => setting.envOnly !== true && !setting.path.includes("."),
).map((setting) => {
  const fallback = (CONFIG_DEFAULTS as Record<string, unknown>)[setting.path];
  return {
    path: setting.path,
    scope: "tenant" as const,
    type: setting.type,
    env: setting.env,
    ...(setting.values === undefined ? {} : { values: setting.values }),
    ...(setting.listAlternative === undefined ? {} : { listAlternative: setting.listAlternative }),
    ...(setting.listPrefillFrom === undefined ? {} : { prefillFrom: setting.listPrefillFrom }),
    ...(SUGGESTIONS[setting.path] === undefined ? {} : { suggestions: SUGGESTIONS[setting.path] }),
    ...(typeof fallback === "string" ||
    typeof fallback === "number" ||
    typeof fallback === "boolean"
      ? { fallback }
      : {}),
  };
});

/**
 * What a fresh list on this row starts from: the value the file states at the
 * path the catalogue named, else that path's shipped default. Empty when
 * neither is a string, which leaves the box empty rather than prefilled with a
 * guess.
 */
function listPrefillOf(source: string, prefillFrom: string): readonly string[] {
  const read = editConfigGetFieldAt(source, prefillFrom.split("."));
  const stated = read.ok && read.found ? read.literal : undefined;
  const value =
    typeof stated === "string" ? stated : (CONFIG_DEFAULTS as Record<string, unknown>)[prefillFrom];
  return typeof value === "string" && value !== "" ? [value] : [];
}

const ROWS: Record<ConfigRole, readonly Row[]> = {
  workspace: [...DEPLOYMENT_ROWS, ...FLEET_ROWS],
  tenant: TENANT_ROWS,
  solo: [...DEPLOYMENT_ROWS, ...TENANT_ROWS],
};

/**
 * Every row this config's form has, with what `source` says about each. Empty
 * when the config will not parse: a form over a file nobody could read would
 * be a form of guesses, and the file view is still there.
 *
 * A locked row the file does not set is left out. There is nothing to show and
 * nothing to change, so it would be a row about a field that is not there.
 */
export function configFieldsOf(
  source: string,
  role: ConfigRole,
  offer: { engineRefs?: readonly string[] } = {},
): ConfigFieldFacts[] {
  const fields: ConfigFieldFacts[] = [];
  // The refs worth offering are the caller's to know: the tip, and the release
  // this companion is. Any branch, tag or commit can still be typed.
  const engineRefs = offer.engineRefs ?? ["main"];
  for (const { fallback, prefillFrom, ...declared } of ROWS[role]) {
    const withRefs =
      declared.path === "engine.ref" ? { ...declared, suggestions: engineRefs } : declared;
    const row =
      prefillFrom === undefined
        ? withRefs
        : { ...withRefs, listPrefill: listPrefillOf(source, prefillFrom) };
    const read = editConfigGetFieldAt(source, row.path.split("."));
    if (!read.ok) {
      // The file itself does not parse: no form. A block that is computed is
      // only that block's rows gone, and the rest of the form stands.
      if (!row.path.includes(".")) return [];
      continue;
    }
    if (!read.found && row.locked !== undefined) continue;
    fields.push({
      ...row,
      ...(!read.found
        ? { state: "unset" as const }
        : read.literal === undefined
          ? { state: "computed" as const, raw: read.raw }
          : { state: "set" as const, value: read.literal }),
      ...(fallback === undefined ? {} : { default: fallback }),
    });
  }
  return fields;
}
