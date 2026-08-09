// The boot → engine handoff: a canonical, versioned, non-secret JSON snapshot
// of a resolved configuration. Boot resolves once and passes the snapshot to
// its child via `BOOTSTRAP_RESOLVED_CONFIG_ENV` so engine source and runtime
// config are one atomic resolution even across an in-between edit; a directly
// invoked engine (no boot) resolves the authored files itself instead.

import { resolveEngineSource } from "../../bootstrap/engine-source.ts";
import { resolveConfig, type ResolvedConfiguration } from "./resolve.ts";
import {
  validateEngineSourceField,
  validateWorkOrder,
  type PathsConfig,
  type PhoebeUserConfig,
} from "./types.ts";

export type { ResolvedConfiguration } from "./resolve.ts";

/** Internal handoff that freezes boot's resolution for the child engine. */
export const BOOTSTRAP_RESOLVED_CONFIG_ENV = "PHOEBE_BOOTSTRAP_RESOLVED_CONFIG";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reject a malformed `paths` block. `paths` is resolved-only (#127): it never
 * comes from an authored config, so the only shape check it needs is
 * structural, matching {@link PathsConfig} — no roster/enum/pattern validation
 * applies the way it does for authored fields.
 */
function validatePathsField(value: unknown, context: string): asserts value is PathsConfig {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const keys = ["repoDir", "worktreesDir", "stateDir"] as const;
  const unknown = Object.keys(value).filter((key) => !(keys as readonly string[]).includes(key));
  const invalid = keys.filter((key) => typeof value[key] !== "string");
  if (unknown.length > 0 || invalid.length > 0) {
    const details = [
      ...unknown.map((key) => `unknown field ${context}.${key}`),
      ...invalid.map((key) => `${context}.${key} must be a string`),
    ];
    throw new Error(`${context} is malformed: ${details.join("; ")}.`);
  }
}

/**
 * `schemaVersion` compatibility policy, mirroring `contracts/README.md`'s in
 * miniature: unknown *additive* `config` fields are forward-compatible — a
 * field neither the roster nor `paths` allowlists is simply one this parser
 * doesn't act on. Only a structural or breaking change (a field's meaning
 * changes, a required field is removed, an existing field's shape changes
 * incompatibly) bumps `schemaVersion`. `parseResolvedConfigurationSnapshot`
 * enforces this by accepting exactly `schemaVersion === 1` today and
 * rejecting anything else outright.
 *
 * Canonical, versioned and non-secret representation for deployment validation.
 * Only resolved config values and environment-variable names are included;
 * process environment values are never serialized.
 */
export function formatResolvedConfiguration(resolved: ResolvedConfiguration): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      config: {
        ...resolved.config,
        engine: resolved.engine,
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Read the non-secret snapshot passed from boot to its child engine. The child
 * uses this instead of re-reading mutable authored files, so engine source and
 * runtime config are one atomic resolution even across an in-between edit.
 *
 * `paths` is adopted verbatim from the snapshot rather than re-derived
 * (#127): re-deriving it here would only agree with what boot originally
 * wrote as long as `PHOEBE_DATA_DIR` happens to be threaded identically to
 * this process, which is an environment-matching invariant a snapshot is
 * supposed to make unnecessary. `paths` is the one resolved-only field
 * (src/config/roster.ts has none); everything else still flows through
 * `resolveConfig` for its usual default-filling and shape validation.
 */
export function parseResolvedConfigurationSnapshot(contents: string): ResolvedConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid ${BOOTSTRAP_RESOLVED_CONFIG_ENV}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1 || !isRecord(parsed["config"])) {
    throw new Error(
      `${BOOTSTRAP_RESOLVED_CONFIG_ENV} must be a schemaVersion 1 resolved configuration.`,
    );
  }
  const { engine, paths, ...runtime } = parsed["config"];
  validateEngineSourceField(engine, `${BOOTSTRAP_RESOLVED_CONFIG_ENV}.config.engine`);
  validatePathsField(paths, `${BOOTSTRAP_RESOLVED_CONFIG_ENV}.config.paths`);
  const config = resolveConfig(runtime as PhoebeUserConfig);
  validateWorkOrder(config.workOrder);
  return { config: { ...config, paths }, engine: resolveEngineSource(engine) };
}
