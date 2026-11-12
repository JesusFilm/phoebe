// The `dependency-updates` kind's options block (ADR 0003), validated once at
// registration so a bad block fails the pipeline list rather than a scan.
// Everything has a default; an empty block, or none, is a working detector.

import {
  BOOTSTRAPPER_PIN_DEFAULT,
  BOOTSTRAPPER_PIN_MODES,
  type BootstrapperPinMode,
} from "../dependencies/bootstrapper.ts";
import { SEVERITIES, type Severity } from "../dependencies/candidate.ts";
import { STRATEGIES, type GroupOverride, type Strategy } from "../dependencies/grouping.ts";
import {
  MATURITY_DEFAULTS,
  MIN_SEVERITY_DEFAULT,
  type MaturityPolicy,
} from "../dependencies/policy.ts";
import {
  everyPeriod,
  fail,
  isRecord,
  nonEmptyString,
  nonNegativeInteger,
  oneOf,
  onlyKeys,
  sources,
} from "../dependencies/options.ts";
import { SOURCE_NAMES, type SourceName } from "../dependencies/sources/assemble.ts";

export { everyMs, EVERY_RE } from "../dependencies/options.ts";
export { SOURCE_NAMES, type SourceName };

export type DependencyUpdatesOptions = {
  /** How long a scan's results stand before the next: `1d`, `12h`. */
  every: string;
  /** The sources to run, in order of trust: an earlier one wins a conflict. */
  sources: readonly SourceName[];
  /** Package-name patterns never proposed. `*` matches any run of characters. */
  ignore: readonly string[];
  /** Days a release ages per update type, and what an undated one does. */
  maturity: Required<MaturityPolicy>;
  /**
   * The severity `dependency-security` files on its own. An advisory under it
   * lets the release that fixes it skip the maturity wait here; one at or over
   * it is left to that kind's own clock.
   */
  minSeverity: Severity;
  grouping: {
    /** The strategy for production dependencies and for development ones. */
    strategy: { prod: Strategy; dev: Strategy };
    /** Pattern overrides, ahead of the strategy. The first match wins. */
    groups: readonly GroupOverride[];
  };
  /** `individual` files every major on its own; `follow-strategy` groups it like the rest. */
  majors: "individual" | "follow-strategy";
  /** The routing label the `dependencies` kind lists. Never the tenant's ready label. */
  label: string;
  /** Open routed bundles allowed at once, issues and PRs together. `0` is no cap. */
  prConcurrentLimit: number;
  /** `skip` leaves the Dockerfile's `phoebe-agent` pin to `phoebe upgrade`; `propose` files it. */
  bootstrapperPin: BootstrapperPinMode;
};

export const DEPENDENCY_UPDATES_OPTION_DEFAULTS: DependencyUpdatesOptions = {
  every: "1d",
  sources: SOURCE_NAMES,
  ignore: [],
  maturity: MATURITY_DEFAULTS,
  minSeverity: MIN_SEVERITY_DEFAULT,
  grouping: { strategy: { prod: "by-relation", dev: "all" }, groups: [] },
  majors: "individual",
  label: "phoebe:dependencies",
  prConcurrentLimit: 5,
  bootstrapperPin: BOOTSTRAPPER_PIN_DEFAULT,
};

const OPTION_KEYS: readonly (keyof DependencyUpdatesOptions)[] = [
  "every",
  "sources",
  "ignore",
  "maturity",
  "minSeverity",
  "grouping",
  "majors",
  "label",
  "prConcurrentLimit",
  "bootstrapperPin",
];

function ignore(at: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    fail(at, `\`ignore\` must be an array of non-empty package-name patterns.`);
  }
  return value as string[];
}

function maturity(at: string, value: unknown): Required<MaturityPolicy> {
  if (!isRecord(value)) fail(at, "`maturity` must be an object.");
  const keys = ["patch", "minor", "major", "undated"] as const;
  onlyKeys(`${at}.maturity`, value, keys);
  const days = (key: "patch" | "minor" | "major") =>
    value[key] === undefined
      ? MATURITY_DEFAULTS[key]
      : nonNegativeInteger(`${at}.maturity`, key, value[key]);
  return {
    patch: days("patch"),
    minor: days("minor"),
    major: days("major"),
    undated:
      value["undated"] === undefined
        ? MATURITY_DEFAULTS.undated
        : oneOf(`${at}.maturity`, "undated", value["undated"], ["propose", "hold"] as const),
  };
}

function grouping(at: string, value: unknown): DependencyUpdatesOptions["grouping"] {
  const defaults = DEPENDENCY_UPDATES_OPTION_DEFAULTS.grouping;
  if (!isRecord(value)) fail(at, "`grouping` must be an object.");
  const here = `${at}.grouping`;
  onlyKeys(here, value, ["strategy", "groups"]);

  let strategy = defaults.strategy;
  const raw = value["strategy"];
  if (typeof raw === "string") {
    const one = oneOf(here, "strategy", raw, STRATEGIES);
    strategy = { prod: one, dev: one };
  } else if (isRecord(raw)) {
    onlyKeys(`${here}.strategy`, raw, ["prod", "dev"]);
    strategy = {
      prod:
        raw["prod"] === undefined
          ? defaults.strategy.prod
          : oneOf(`${here}.strategy`, "prod", raw["prod"], STRATEGIES),
      dev:
        raw["dev"] === undefined
          ? defaults.strategy.dev
          : oneOf(`${here}.strategy`, "dev", raw["dev"], STRATEGIES),
    };
  } else if (raw !== undefined) {
    fail(here, `\`strategy\` must be one of ${STRATEGIES.join(", ")}, or { prod, dev }.`);
  }

  const groups = value["groups"] ?? [];
  if (
    !Array.isArray(groups) ||
    groups.some(
      (g) =>
        !isRecord(g) ||
        Object.keys(g).some((k) => k !== "pattern" && k !== "group") ||
        typeof g["pattern"] !== "string" ||
        g["pattern"].trim() === "" ||
        typeof g["group"] !== "string" ||
        g["group"].trim() === "",
    )
  ) {
    fail(here, "`groups` must be an array of { pattern, group } with non-empty strings.");
  }
  return { strategy, groups: groups as GroupOverride[] };
}

/**
 * Validate the block a tenant declared and fill the defaults. `at` is the
 * config path the errors name. No block at all is fine; an unknown field is
 * refused, as the sentry kind refuses one, because a typo'd option would
 * otherwise sit inert while looking configured.
 */
export function resolveDependencyUpdatesOptions(
  raw: unknown,
  at: string,
): DependencyUpdatesOptions {
  const defaults = DEPENDENCY_UPDATES_OPTION_DEFAULTS;
  if (raw === undefined) return defaults;
  if (!isRecord(raw)) fail(at, "the dependency-updates kind's options must be an object.");
  onlyKeys(at, raw, OPTION_KEYS);

  return {
    every: everyPeriod(at, raw["every"] ?? defaults.every),
    sources: raw["sources"] === undefined ? defaults.sources : sources(at, raw["sources"]),
    ignore: raw["ignore"] === undefined ? defaults.ignore : ignore(at, raw["ignore"]),
    maturity: raw["maturity"] === undefined ? defaults.maturity : maturity(at, raw["maturity"]),
    minSeverity:
      raw["minSeverity"] === undefined
        ? defaults.minSeverity
        : oneOf(at, "minSeverity", raw["minSeverity"], SEVERITIES),
    grouping: raw["grouping"] === undefined ? defaults.grouping : grouping(at, raw["grouping"]),
    majors:
      raw["majors"] === undefined
        ? defaults.majors
        : oneOf(at, "majors", raw["majors"], ["individual", "follow-strategy"] as const),
    label: raw["label"] === undefined ? defaults.label : nonEmptyString(at, "label", raw["label"]),
    prConcurrentLimit:
      raw["prConcurrentLimit"] === undefined
        ? defaults.prConcurrentLimit
        : nonNegativeInteger(at, "prConcurrentLimit", raw["prConcurrentLimit"]),
    bootstrapperPin:
      raw["bootstrapperPin"] === undefined
        ? defaults.bootstrapperPin
        : oneOf(at, "bootstrapperPin", raw["bootstrapperPin"], BOOTSTRAPPER_PIN_MODES),
  };
}
