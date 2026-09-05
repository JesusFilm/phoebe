// Loading a tenant's custom work kinds (#350, flattened by #465): resolve each
// non-built-in `kinds.<name>` entry — inline definition, path string, or a
// `{ path, ...knobs, ...options }` block — into a definition, then assemble
// the registry. Path modules load with the same dynamic-import machinery as the
// config itself (native Node type-stripping), resolved against the config
// file's directory. Editing a kind module requires a restart: the reconcile
// watch fingerprints the config file only (documented v1 limitation).

import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  WORK_KIND_NAMES,
  builtInKindPath,
  customKindEntries,
  pathEntryOptions,
  type CustomKindEntry,
  type PhoebeConfig,
} from "../config-schema.ts";
import type { AnyWorkKindDefinition } from "./definition.ts";
import { buildRegistry, type LoadedCustomKind, type WorkKindRegistry } from "./registry.ts";

async function importKindModule(
  at: string,
  modulePath: string,
  configDir: string,
  config: PhoebeConfig,
): Promise<AnyWorkKindDefinition> {
  const absolute = resolvePath(configDir, modulePath);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(absolute).href);
  } catch (error) {
    throw new Error(
      `${at}: failed to load kind module ${modulePath} (resolved to ${absolute}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const exported = (mod as Record<string, unknown>)["default"];
  if (exported === undefined || exported === null) {
    throw new Error(
      `${at}: kind module ${modulePath} must \`export default\` a work-kind definition ` +
        `or a \`(config) => definition\` factory.`,
    );
  }
  // A factory — the same shape the built-in modules use — gets the resolved
  // config; a plain object is the definition itself.
  return typeof exported === "function"
    ? ((exported as (config: PhoebeConfig) => AnyWorkKindDefinition)(
        config,
      ) as AnyWorkKindDefinition)
    : (exported as AnyWorkKindDefinition);
}

/**
 * Resolve every declared kind module to `{ name, definition, options }`: the
 * custom kinds, plus any built-in whose block declares a replacement `path`
 * (#465) — the same loading machinery for both, so a replaced built-in is a
 * custom kind that happens to claim a shipped name. The entries' *shape* was
 * already validated by `resolveConfig`; definition members are validated at
 * registry assembly.
 */
export async function loadCustomKinds(
  config: PhoebeConfig,
  configDir: string,
): Promise<LoadedCustomKind[]> {
  const loaded: LoadedCustomKind[] = [];
  for (const [name, entry] of Object.entries(customKindEntries(config.workKinds))) {
    const at = `kinds.${name}`;
    loaded.push(await resolveEntry(at, name, entry, configDir, config));
  }
  for (const name of WORK_KIND_NAMES) {
    const declared = builtInKindPath(config.workKinds, name);
    if (declared === undefined) continue;
    loaded.push({
      name,
      definition: await importKindModule(`kinds.${name}`, declared.path, configDir, config),
      options: declared.options,
    });
  }
  return loaded;
}

async function resolveEntry(
  at: string,
  name: string,
  entry: CustomKindEntry,
  configDir: string,
  config: PhoebeConfig,
): Promise<LoadedCustomKind> {
  if (typeof entry === "string") {
    return {
      name,
      definition: await importKindModule(at, entry, configDir, config),
      options: undefined,
    };
  }
  if ("path" in entry && typeof (entry as { path?: unknown }).path === "string") {
    const block = entry as { path: string };
    return {
      name,
      definition: await importKindModule(at, block.path, configDir, config),
      options: pathEntryOptions(block),
    };
  }
  return { name, definition: entry as AnyWorkKindDefinition, options: undefined };
}

/**
 * The boot step (#350 Q6): load config → **load kind modules → validate
 * definitions → assemble the registry** → validate the work order against the
 * registry's names → assert prompt files. This function is the bold middle.
 *
 * It used to warn about a custom kind missing from `workOrder`. Since #415 the
 * order is priority, not membership: a declared kind its pipeline owns is
 * scheduled whether or not it is named there, so there is nothing left to warn
 * about. Taking one out of rotation is `kinds.<name>.disabled`.
 */
export async function createWorkKindRegistry(
  config: PhoebeConfig,
  configDir: string,
): Promise<WorkKindRegistry> {
  const customs = await loadCustomKinds(config, configDir);
  return buildRegistry(config, customs);
}
