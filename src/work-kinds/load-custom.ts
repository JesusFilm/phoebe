// Loading a tenant's custom work kinds (#350, flattened by #465): resolve each
// non-built-in `kinds.<name>` entry — inline definition, path string, or a
// `{ path, ...knobs, ...options }` block — into a definition, then assemble
// the registry. Path modules load with the same dynamic-import machinery as the
// config itself (native Node type-stripping), resolved against the config
// file's directory — or, for a `phoebe-agent/` path, against the engine root:
// that prefix is how a tenant declares a **catalog kind** (#473), a kind that
// ships in the engine checkout and registers only on declaration. Editing a
// kind module requires a restart: the reconcile watch fingerprints the config
// file only (documented v1 limitation).

import { statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CATALOG_KIND_PREFIX,
  WORK_KIND_NAMES,
  builtInKindPath,
  customKindEntries,
  pathEntryOptions,
  type CustomKindEntry,
  type PhoebeConfig,
} from "../config-schema.ts";
import type { AnyWorkKindDefinition } from "./definition.ts";
import { buildRegistry, type LoadedCustomKind, type WorkKindRegistry } from "./registry.ts";

/**
 * The engine checkout's root — two levels up from this file. The catalog lives
 * under it (`<root>/kinds/<name>/`), and the engine can only be running from a
 * checkout, so the path is known without configuration.
 */
export const ENGINE_ROOT = resolvePath(import.meta.dirname, "..", "..");

/**
 * Where a kind module's path lands on disk. A `phoebe-agent/` path is a catalog
 * entry: it resolves against the engine root, and a directory means its
 * `index.ts` (Node's ESM loader does not look for one itself). Every other path
 * resolves against the config file's directory, exactly as before.
 */
export function resolveKindModulePath(modulePath: string, configDir: string): string {
  if (!modulePath.startsWith(CATALOG_KIND_PREFIX)) return resolvePath(configDir, modulePath);
  const inCatalog = resolvePath(ENGINE_ROOT, modulePath.slice(CATALOG_KIND_PREFIX.length));
  try {
    if (statSync(inCatalog).isDirectory()) return join(inCatalog, "index.ts");
  } catch {
    // Absent: let the import below fail with the resolved path in its message.
  }
  return inCatalog;
}

async function importKindModule(
  at: string,
  modulePath: string,
  configDir: string,
  config: PhoebeConfig,
  options: Record<string, unknown> | undefined,
): Promise<AnyWorkKindDefinition> {
  const absolute = resolveKindModulePath(modulePath, configDir);
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
  // config and, second, the block's options, so a kind can validate its options
  // at registration and fail the boot (or `phoebe pipelines`) loudly rather
  // than mid-unit. A plain object is the definition itself.
  return typeof exported === "function"
    ? ((
        exported as (
          config: PhoebeConfig,
          options: Record<string, unknown> | undefined,
        ) => AnyWorkKindDefinition
      )(config, options) as AnyWorkKindDefinition)
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
      definition: await importKindModule(
        `kinds.${name}`,
        declared.path,
        configDir,
        config,
        declared.options,
      ),
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
      definition: await importKindModule(at, entry, configDir, config, undefined),
      options: undefined,
    };
  }
  if ("path" in entry && typeof (entry as { path?: unknown }).path === "string") {
    const block = entry as { path: string };
    const options = pathEntryOptions(block);
    return {
      name,
      definition: await importKindModule(at, block.path, configDir, config, options),
      options,
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
