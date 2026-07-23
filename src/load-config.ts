// Consumer-facing config plumbing: `loadUserConfig` (dynamic TS import via
// native Node type-stripping) and `applyEnvOverlay` (`PHOEBE_*` overrides for
// scalar fields). The `defineConfig` typing helper lives in the bootstrapper
// (bootstrap/define-config.ts), the published package surface.
//
// The Phoebe CLI (src/cli.ts) chains these: load the user's config, overlay
// env vars, then `resolveConfig` fills the shipped defaults. Kept separate from
// `config-schema.ts` so the schema stays a pure data contract and only the CLI
// path pulls in Node's fs/url runtime.

import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { PhoebeUserConfig, ProviderName } from "./config-schema.ts";
import { PROVIDER_NAMES } from "./config-schema.ts";

/**
 * Scalar-only overlay: each `PHOEBE_*` env var, when set to a non-empty
 * string, replaces the corresponding user-config field. Nested records
 * (`promptFiles`, `paths`, `defaultModels`, `providerEnv`, `workOrder`) stay
 * config-file territory — env vars are for one-off run overrides where the
 * consumer doesn't want to edit `phoebe.config.ts`, and expanding structured
 * shapes into env keys defeats the point.
 *
 * A field-scoped list (rather than magic name-mangling) keeps the surface
 * documented and predictable: users can grep for `PHOEBE_` here and see the
 * complete overlay contract.
 */
export const ENV_OVERLAY_KEYS = [
  { env: "PHOEBE_REPO_SLUG", key: "repoSlug" },
  { env: "PHOEBE_REPO_URL", key: "repoUrl" },
  { env: "PHOEBE_DEFAULT_BRANCH", key: "defaultBranch" },
  { env: "PHOEBE_BRANCH_PREFIX", key: "branchPrefix" },
  { env: "PHOEBE_READY_LABEL", key: "readyLabel" },
  { env: "PHOEBE_RESEARCH_LABEL", key: "researchLabel" },
  { env: "PHOEBE_PROCESSING_LABEL", key: "processingLabel" },
  { env: "PHOEBE_PR_OPT_OUT_LABEL", key: "prOptOutLabel" },
  { env: "PHOEBE_INSTALL_COMMAND", key: "installCommand" },
  { env: "PHOEBE_CHECK_COMMAND", key: "checkCommand" },
  { env: "PHOEBE_TEST_COMMAND", key: "testCommand" },
  { env: "PHOEBE_READY_COMMAND", key: "readyCommand" },
  { env: "PHOEBE_BLOCKED_BY_PATTERN", key: "blockedByPattern" },
  { env: "PHOEBE_REVIEWS_SUCCESS_HEADING", key: "reviewsSuccessHeading" },
] as const satisfies ReadonlyArray<{ env: string; key: keyof PhoebeUserConfig }>;

const PR_SCOPE_VALUES = ["phoebe", "all"] as const;
const DRAFT_PRS_VALUES = ["skip-non-phoebe", "skip-all", "include"] as const;

function readNonEmpty(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw;
}

/**
 * Apply the `PHOEBE_*` overlay onto a user config and return a new object.
 * The overlay is additive over what the config file declared — an unset env
 * var leaves the field untouched (so `resolveConfig` can still fall back to
 * `CONFIG_DEFAULTS` if the field was also absent from the config file).
 */
export function applyEnvOverlay(user: PhoebeUserConfig, env: NodeJS.ProcessEnv): PhoebeUserConfig {
  const overlaid: PhoebeUserConfig = { ...user };
  for (const { env: envKey, key } of ENV_OVERLAY_KEYS) {
    const value = readNonEmpty(env, envKey);
    if (value !== undefined) {
      (overlaid as Record<string, unknown>)[key] = value;
    }
  }

  const prScope = readNonEmpty(env, "PHOEBE_PR_SCOPE");
  if (prScope !== undefined) {
    if (!(PR_SCOPE_VALUES as readonly string[]).includes(prScope)) {
      throw new Error(
        `PHOEBE_PR_SCOPE must be one of ${PR_SCOPE_VALUES.join(", ")} (got "${prScope}").`,
      );
    }
    overlaid.prScope = prScope as PhoebeUserConfig["prScope"];
  }

  const draftPrs = readNonEmpty(env, "PHOEBE_DRAFT_PRS");
  if (draftPrs !== undefined) {
    if (!(DRAFT_PRS_VALUES as readonly string[]).includes(draftPrs)) {
      throw new Error(
        `PHOEBE_DRAFT_PRS must be one of ${DRAFT_PRS_VALUES.join(", ")} (got "${draftPrs}").`,
      );
    }
    overlaid.draftPrs = draftPrs as PhoebeUserConfig["draftPrs"];
  }

  const defaultProvider = readNonEmpty(env, "PHOEBE_DEFAULT_PROVIDER");
  if (defaultProvider !== undefined) {
    if (!(PROVIDER_NAMES as readonly string[]).includes(defaultProvider)) {
      throw new Error(
        `PHOEBE_DEFAULT_PROVIDER must be one of ${PROVIDER_NAMES.join(", ")} (got "${defaultProvider}").`,
      );
    }
    overlaid.defaultProvider = defaultProvider as ProviderName;
  }

  return overlaid;
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
 */
export async function loadUserConfig(configPath: string): Promise<PhoebeUserConfig> {
  const url = pathToFileURL(configPath).href;
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
