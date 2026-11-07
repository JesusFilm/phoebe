// The `dependency-security` kind's options block (ADR 0003), validated once at
// registration so a bad block fails the pipeline list rather than a scan.
// Everything has a default; an empty block, or none, is a working detector.

import { SEVERITIES, type Severity } from "../dependencies/candidate.ts";
import {
  everyPeriod,
  fail,
  isRecord,
  nonEmptyString,
  oneOf,
  onlyKeys,
  sources,
} from "../dependencies/options.ts";
import { MIN_SEVERITY_DEFAULT } from "../dependencies/policy.ts";
import { AGENT_SOURCE_NAME } from "../dependencies/sources/agent.ts";
import type { SourceName } from "../dependencies/sources/assemble.ts";
import { NATIVE_SOURCE_NAME } from "../dependencies/sources/native.ts";

export type DependencySecurityOptions = {
  /** How long one scan's results stand before the next: `1h`, `30m`. */
  every: string;
  /** The sources to run, in order of trust: an earlier one wins a conflict. */
  sources: readonly SourceName[];
  /** The lowest severity filed here. Advisories under it are left to `dependency-updates`. */
  minSeverity: Severity;
  /** The routing label the `dependencies` kind lists. Never the tenant's ready label. */
  label: string;
};

export const DEPENDENCY_SECURITY_OPTION_DEFAULTS: DependencySecurityOptions = {
  every: "1h",
  sources: [NATIVE_SOURCE_NAME, AGENT_SOURCE_NAME],
  minSeverity: MIN_SEVERITY_DEFAULT,
  label: "phoebe:dependencies",
};

const OPTION_KEYS: readonly (keyof DependencySecurityOptions)[] = [
  "every",
  "sources",
  "minSeverity",
  "label",
];

/**
 * Validate the block a tenant declared and fill the defaults. `at` is the
 * config path the errors name. An unknown field is refused, so a
 * `prConcurrentLimit` copied from the updates block fails here rather than
 * looking as if it capped anything.
 */
export function resolveDependencySecurityOptions(
  raw: unknown,
  at: string,
): DependencySecurityOptions {
  const defaults = DEPENDENCY_SECURITY_OPTION_DEFAULTS;
  if (raw === undefined) return defaults;
  if (!isRecord(raw)) fail(at, "the dependency-security kind's options must be an object.");
  onlyKeys(at, raw, OPTION_KEYS);
  return {
    every: everyPeriod(at, raw["every"] ?? defaults.every),
    sources: raw["sources"] === undefined ? defaults.sources : sources(at, raw["sources"]),
    minSeverity:
      raw["minSeverity"] === undefined
        ? defaults.minSeverity
        : oneOf(at, "minSeverity", raw["minSeverity"], SEVERITIES),
    label: raw["label"] === undefined ? defaults.label : nonEmptyString(at, "label", raw["label"]),
  };
}
