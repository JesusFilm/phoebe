// Consumer-facing config plumbing: `loadUserConfig` (dynamic TS import via
// native Node type-stripping) and `applyEnvOverlay`, which evaluates the one
// precedence rule for every tenant leaf the settings catalogue marks as
// config-built. The names come from the catalogue (src/settings-catalogue.ts),
// not from a list here — there is one contract and one place it is written.
// The `defineConfig` typing helper lives in the bootstrapper
// (bootstrap/define-config.ts), the published package surface.
//
// The Phoebe CLI (src/cli.ts) chains these: load the user's config, overlay
// env vars, then `resolveConfig` fills the shipped defaults. Kept separate from
// `config-schema.ts` so the schema stays a pure data contract and only the CLI
// path pulls in Node's fs/url runtime.

import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { PhoebeUserConfig } from "./config-schema.ts";
import {
  overlayEnvNames,
  readEnv,
  SETTINGS,
  type Setting,
  type SettingRead,
} from "./settings-catalogue.ts";

/**
 * The tenant leaves the overlay writes onto the config as it is built — the
 * `overlay: "all" | "canonical"` half of the settings catalogue (#530). Every
 * other catalogued setting is read by the module that owns its ladder, because
 * a kind block sits between the kind-level env name and the tenant leaf and
 * only that module can put it there.
 *
 * Keeping the names in the catalogue rather than in a list here is what makes
 * one grep answer "what can env set?" — this module no longer holds a second,
 * quietly divergent copy of the contract.
 */
const OVERLAY_SETTINGS = SETTINGS.filter((entry) => entry.overlay !== "none");

/**
 * Apply the `PHOEBE_*` overlay onto a user config and return a new object.
 * Additive over what the config file declared — an unset env var leaves the
 * field untouched, so `resolveConfig` can still fall back to `CONFIG_DEFAULTS`
 * when the field was absent from the file too.
 *
 * Strings are taken verbatim; enums and booleans are validated and a bad value
 * throws. Booleans stay strict `"true"`/`"false"` rather than accepting
 * `1`/`yes`/`on`: a var that silently read a typo as `false` would turn a
 * janitor off without saying so.
 */
export function applyEnvOverlay(user: PhoebeUserConfig, env: NodeJS.ProcessEnv): PhoebeUserConfig {
  const overlaid = { ...user } as PhoebeUserConfig & Record<string, unknown>;
  for (const entry of OVERLAY_SETTINGS) {
    const read = readEnv(env, overlayEnvNames(entry));
    if (read === undefined) continue;
    overlaid[entry.path] = coerce(entry, read);
  }
  return overlaid;
}

/** One env value as the field at this path holds it, or a throw naming the var. */
function coerce(entry: Setting, read: SettingRead): string | boolean {
  const { via, value } = read;
  if (entry.type === "boolean") {
    if (value !== "true" && value !== "false") {
      throw new Error(`${via} must be "true" or "false" (got "${value}").`);
    }
    return value === "true";
  }
  if (entry.type === "enum") {
    const values = entry.values ?? [];
    if (!values.includes(value)) {
      throw new Error(`${via} must be one of ${values.join(", ")} (got "${value}").`);
    }
  }
  return value;
}

/**
 * Resolve a `--config` argument (or the default) to an absolute path and
 * assert the file exists. Split from `loadUserConfig` so the CLI can print
 * a precise "file not found" message before attempting the dynamic import.
 */
export function resolveConfigPath(argPath: string | undefined, cwd: string): string {
  const candidate = argPath ?? "phoebe.config.ts";
  const absolute = isAbsolute(candidate) ? candidate : resolvePath(cwd, candidate);
  if (!existsSync(absolute)) {
    throw new Error(
      argPath
        ? `Config file not found: ${absolute} (passed via --config).`
        : `Config file not found: ${absolute}. ` +
            `Create a phoebe.config.ts in the current directory or pass --config <path>.`,
    );
  }
  return absolute;
}

/**
 * Dynamically import a `phoebe.config.ts` and return the user shape. Native
 * Node type-stripping (unflagged on Node ≥ 24, the version Phoebe requires)
 * handles the TS syntax — no bundler needed on the consumer side. Accepts
 * either a default export or a named `config` export so the pre-`defineConfig`
 * scaffold still loads.
 *
 * `reloadKey` busts Node's ESM module cache, which is keyed by URL and would
 * otherwise hand back the first import forever. The engine never needs it (each
 * run is a fresh process); `phoebe boot` does, because it re-reads the mounted
 * config in-process when the reconcile watch sees it change (#42). Pass the
 * config's fingerprint, not a counter: an unchanged config then reuses the
 * cached module instead of leaking a new registry entry per read.
 */
export async function loadUserConfig(
  configPath: string,
  opts: { reloadKey?: string } = {},
): Promise<PhoebeUserConfig> {
  const fileUrl = pathToFileURL(configPath);
  if (opts.reloadKey !== undefined) {
    fileUrl.searchParams.set("phoebe-reload", opts.reloadKey);
  }
  const url = fileUrl.href;
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (error) {
    throw new Error(
      `Failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = mod as Record<string, unknown>;
  const candidate =
    (typeof record["default"] === "object" && record["default"] !== null
      ? record["default"]
      : undefined) ??
    (typeof record["config"] === "object" && record["config"] !== null
      ? record["config"]
      : undefined);
  if (!candidate) {
    throw new Error(
      `${configPath} must export a Phoebe config as \`export default defineConfig({ ... })\` ` +
        `or a named \`export const config = { ... }\`.`,
    );
  }
  return candidate as PhoebeUserConfig;
}
