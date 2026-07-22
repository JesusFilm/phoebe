// The bootstrapper's minimal engine-source reader.
//
// The published `phoebe-agent` package is a thin bootstrapper: it materializes
// the engine (`src/`) from a git ref or a local mount, then runs it. The only
// part of the consumer's mounted `phoebe.config.ts` the bootstrapper needs is
// the `engine` field — the full config schema stays the engine's concern
// (config-schema.ts + resolveConfig). This module is that minimal reader: it
// takes the `engine` field (or a loaded config carrying it) and returns the
// resolved source with defaults applied, and nothing else.
//
// The user-facing field type (`EngineSourceField`) lives with the rest of the
// config schema in the engine so there is one source of truth for the config
// shape; this module owns only the resolution + the defaults.

import type { EngineSourceField } from "../src/config-schema.ts";

/** Repo the engine is cloned from when `source: "github"` omits `repo`. */
export const DEFAULT_ENGINE_REPO = "JesusFilm/phoebe";
/** Ref the engine is checked out at when `source: "github"` omits `ref`. */
export const DEFAULT_ENGINE_REF = "main";

/**
 * The engine source with every default applied — what the bootstrapper acts on.
 * `github` always carries a concrete `ref` and `repo`; `local` carries nothing
 * (the engine is read from its mount).
 */
export type ResolvedEngineSource =
  | { source: "github"; ref: string; repo: string }
  | { source: "local" };

/**
 * Resolve the optional `engine` field into a concrete source. An omitted field
 * (or an omitted `ref`/`repo` on a github source) falls back to the shipped
 * defaults: github, ref `main`, repo `JesusFilm/phoebe`.
 */
export function resolveEngineSource(field: EngineSourceField | undefined): ResolvedEngineSource {
  if (field === undefined || field.source === "github") {
    return {
      source: "github",
      ref: field?.ref ?? DEFAULT_ENGINE_REF,
      repo: field?.repo ?? DEFAULT_ENGINE_REPO,
    };
  }
  return { source: "local" };
}

/**
 * Whether an arbitrary value is a well-formed `engine` field. The bootstrapper
 * is the only reader of `engine` — the engine drops it (`resolveConfig`) rather
 * than validating it — so a malformed value has to be rejected here or it never
 * is. An unknown `source` must not fall through to `local`, and a non-string
 * `ref`/`repo` must not escape into a `ResolvedEngineSource` typed as strings.
 */
function isEngineSourceField(value: unknown): value is EngineSourceField {
  if (value === null || typeof value !== "object") return false;
  const field = value as Record<string, unknown>;
  if (field["source"] === "local") return true;
  return (
    field["source"] === "github" &&
    (field["ref"] === undefined || typeof field["ref"] === "string") &&
    (field["repo"] === undefined || typeof field["repo"] === "string")
  );
}

/**
 * Extract the resolved engine source from a loaded consumer config, ignoring
 * every other field. This is the whole of the bootstrapper's interest in the
 * config; the engine reads (and validates) the rest once it is materialized and
 * run. The config arrives as a dynamically-imported module value, so the param
 * is an arbitrary record — `engine`, if present, is validated before use so a
 * typo (bad `source`, numeric `ref`/`repo`) fails loudly instead of silently
 * resolving to the wrong source.
 */
export function readEngineSource(config: Record<string, unknown>): ResolvedEngineSource {
  const field = config["engine"];
  if (field !== undefined && !isEngineSourceField(field)) {
    throw new Error(
      `phoebe.config.ts \`engine\` must be { source: "github", ref?, repo? } or ` +
        `{ source: "local" } with string ref/repo (got ${JSON.stringify(field)}).`,
    );
  }
  return resolveEngineSource(field);
}
