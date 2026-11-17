// The `skill-updates` kind's options block (#877), validated once at
// registration so a bad block fails the pipeline list rather than a scan.
// Everything has a default; an empty block, or none, is a working kind.

import {
  everyMs,
  everyPeriod,
  EVERY_RE,
  fail,
  isRecord,
  nonEmptyString,
  onlyKeys,
} from "../dependencies/options.ts";

export { everyMs };

export type SkillUpdatesOptions = {
  /** How long one scan's results stand: `1d`, `12h`. */
  every: string;
  /** How old a default-branch commit must be before a SHA-pinned source moves to it. */
  minAge: string;
  /** Skill names never synced. */
  ignore: readonly string[];
  /** Where the lock is, relative to the repository root. */
  lockPath: string;
  /** Labels added to every PR the kind opens. */
  labels: readonly string[];
};

export const SKILL_UPDATES_OPTION_DEFAULTS: SkillUpdatesOptions = {
  every: "1d",
  minAge: "3d",
  ignore: [],
  lockPath: "skills-lock.json",
  labels: [],
};

const OPTION_KEYS: readonly (keyof SkillUpdatesOptions)[] = [
  "every",
  "minAge",
  "ignore",
  "lockPath",
  "labels",
];

function names(at: string, key: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    fail(at, `\`${key}\` must be an array of non-empty strings.`);
  }
  return value as string[];
}

function minAge(at: string, value: unknown): string {
  if (typeof value !== "string" || !EVERY_RE.test(value)) {
    fail(at, `\`minAge\` must be a period like "3d" or "0d" — got ${JSON.stringify(value)}.`);
  }
  return value;
}

function lockPath(at: string, value: unknown): string {
  const path = nonEmptyString(at, "lockPath", value);
  if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    fail(at, `\`lockPath\` must be a path inside the repository — got ${JSON.stringify(path)}.`);
  }
  return path;
}

/**
 * Validate the block a tenant declared and fill the defaults. `at` is the
 * config path the errors name. An unknown field is refused, as every catalog
 * kind refuses one, because a typo'd option would otherwise sit inert while
 * looking configured.
 */
export function resolveSkillUpdatesOptions(raw: unknown, at: string): SkillUpdatesOptions {
  const defaults = SKILL_UPDATES_OPTION_DEFAULTS;
  if (raw === undefined) return defaults;
  if (!isRecord(raw)) fail(at, "the skill-updates kind's options must be an object.");
  onlyKeys(at, raw, OPTION_KEYS);
  return {
    every: everyPeriod(at, raw["every"] ?? defaults.every),
    minAge: raw["minAge"] === undefined ? defaults.minAge : minAge(at, raw["minAge"]),
    ignore: raw["ignore"] === undefined ? defaults.ignore : names(at, "ignore", raw["ignore"]),
    lockPath: raw["lockPath"] === undefined ? defaults.lockPath : lockPath(at, raw["lockPath"]),
    labels: raw["labels"] === undefined ? defaults.labels : names(at, "labels", raw["labels"]),
  };
}
