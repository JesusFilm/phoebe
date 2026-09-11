// The `sentry` kind's options block (#471/#472/#473): eleven root fields beside
// `path` and the tuning knobs, validated once at registration so a bad block
// fails the pipeline list at enumeration rather than a unit mid-cycle. Only
// the token is env; everything else lives here.

import { normalizeCollectorUrl } from "../../src/sentry-protocol.ts";

export const COLLECTORS = ["sentry", "glitchtip"] as const;
export type Collector = (typeof COLLECTORS)[number];

export type SentryKindOptions = {
  /** The organization slug in every Sentry URL. */
  org: string;
  /** The numeric project id (`project=` in a Sentry issues URL). */
  project: number;
  /** The collector's web origin; `https://sentry.io` unless self-hosted. */
  url: string;
  /** Which read-surface policy the adapter applies (#470). */
  collector: Collector;
  /** The stats window a candidate must have been seen in — `24h`, `7d`. */
  window: string;
  /** Minimum events in the window before a group is a candidate. */
  minEvents: number;
  /** Environments a candidate must have been seen in. */
  environments: readonly string[];
  /** Levels a candidate may carry. */
  levels: readonly string[];
  /** Label every filed issue wears, for humans to filter by. */
  label: string;
  /** Label a ready verdict wears when `applyReadyLabel` is off. */
  triagedLabel: string;
  /** Apply the tenant's `readyLabel` to a ready verdict directly. */
  applyReadyLabel: boolean;
};

export const SENTRY_OPTION_DEFAULTS = {
  url: "https://sentry.io",
  collector: "sentry" as Collector,
  window: "24h",
  minEvents: 2,
  environments: ["production"] as readonly string[],
  levels: ["error", "fatal"] as readonly string[],
  label: "sentry",
  triagedLabel: "triaged",
  applyReadyLabel: false,
} as const;

const OPTION_KEYS: readonly (keyof SentryKindOptions)[] = [
  "org",
  "project",
  "url",
  "collector",
  "window",
  "minEvents",
  "environments",
  "levels",
  "label",
  "triagedLabel",
  "applyReadyLabel",
];

/** Sentry's relative-period grammar: a count and one of s/m/h/d/w. */
export const WINDOW_RE = /^(\d+)([smhdw])$/;

function fail(at: string, problem: string): never {
  throw new Error(`${at}: ${problem}`);
}

function nonEmptyString(at: string, key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(at, `\`${key}\` must be a non-empty string — got ${JSON.stringify(value)}.`);
  }
  return value;
}

function stringList(at: string, key: string, value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((v) => typeof v !== "string" || v.trim().length === 0)
  ) {
    fail(at, `\`${key}\` must be a non-empty array of strings — got ${JSON.stringify(value)}.`);
  }
  return value as string[];
}

/**
 * Validate the block a tenant declared and fill the defaults. `at` is the
 * config path the errors name (`pipelines.intake.kinds.sentry`). An unknown
 * root field is refused: with `path` and the knobs already reserved, a typo'd
 * option would otherwise sit inert while looking configured.
 */
export function resolveSentryOptions(raw: unknown, at: string): SentryKindOptions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(at, "the sentry kind needs an options block with at least `org` and `project`.");
  }
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!(OPTION_KEYS as readonly string[]).includes(key)) {
      fail(at, `unknown option \`${key}\`. The sentry kind takes: ${OPTION_KEYS.join(", ")}.`);
    }
  }

  const org = nonEmptyString(at, "org", block["org"]);
  const project = block["project"];
  if (typeof project !== "number" || !Number.isInteger(project) || project <= 0) {
    fail(
      at,
      `\`project\` must be the numeric project id (the \`project=\` value in a Sentry issues ` +
        `URL) — got ${JSON.stringify(project)}.`,
    );
  }

  let url: string;
  try {
    url = normalizeCollectorUrl(
      block["url"] === undefined
        ? SENTRY_OPTION_DEFAULTS.url
        : nonEmptyString(at, "url", block["url"]),
    );
  } catch (error) {
    fail(at, `\`url\`: ${error instanceof Error ? error.message : String(error)}`);
  }

  const collector = block["collector"] ?? SENTRY_OPTION_DEFAULTS.collector;
  if (!(COLLECTORS as readonly unknown[]).includes(collector)) {
    fail(
      at,
      `\`collector\` must be one of ${COLLECTORS.join(", ")} — got ${JSON.stringify(collector)}.`,
    );
  }

  const window = block["window"] === undefined ? SENTRY_OPTION_DEFAULTS.window : block["window"];
  if (typeof window !== "string" || !WINDOW_RE.test(window)) {
    fail(at, `\`window\` must be a period like "24h" or "7d" — got ${JSON.stringify(window)}.`);
  }

  const minEvents = block["minEvents"] ?? SENTRY_OPTION_DEFAULTS.minEvents;
  if (typeof minEvents !== "number" || !Number.isInteger(minEvents) || minEvents < 1) {
    fail(at, `\`minEvents\` must be a positive integer — got ${JSON.stringify(minEvents)}.`);
  }

  const applyReadyLabel = block["applyReadyLabel"] ?? SENTRY_OPTION_DEFAULTS.applyReadyLabel;
  if (typeof applyReadyLabel !== "boolean") {
    fail(at, `\`applyReadyLabel\` must be a boolean — got ${JSON.stringify(applyReadyLabel)}.`);
  }

  return {
    org,
    project,
    url,
    collector: collector as Collector,
    window,
    minEvents,
    environments:
      block["environments"] === undefined
        ? SENTRY_OPTION_DEFAULTS.environments
        : stringList(at, "environments", block["environments"]),
    levels:
      block["levels"] === undefined
        ? SENTRY_OPTION_DEFAULTS.levels
        : stringList(at, "levels", block["levels"]),
    label:
      block["label"] === undefined
        ? SENTRY_OPTION_DEFAULTS.label
        : nonEmptyString(at, "label", block["label"]),
    triagedLabel:
      block["triagedLabel"] === undefined
        ? SENTRY_OPTION_DEFAULTS.triagedLabel
        : nonEmptyString(at, "triagedLabel", block["triagedLabel"]),
    applyReadyLabel,
  };
}
