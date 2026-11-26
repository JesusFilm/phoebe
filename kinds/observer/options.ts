// The `observer` kind's options block (#934), validated once at registration so
// a bad block fails the pipeline list rather than a run. Every field has a
// default, so an empty block is a working kind that never runs on its own.

import {
  everyMs,
  everyPeriod,
  EVERY_RE,
  fail,
  isRecord,
  onlyKeys,
} from "../dependencies/options.ts";

export { everyMs };

/**
 * Where proposals go. `pr` opens a PR for a convention or factory finding and
 * an issue for the rest; `issues` files every finding as an issue.
 */
export type ObserverMode = "pr" | "issues";

export type ObserverOptions = {
  /**
   * How long after its last completed run the observer runs again: `7d`,
   * `12h`. `null` means it never runs on its own.
   */
  every: string | null;
  /** How far back a run reads the other pipelines' unit history. */
  lookback: string;
  mode: ObserverMode;
  /** The most new proposals one run files. New evidence on an open one is not counted. */
  maxProposals: number;
};

export const OBSERVER_OPTION_DEFAULTS: ObserverOptions = {
  every: null,
  lookback: "14d",
  mode: "pr",
  maxProposals: 3,
};

const OPTION_KEYS: readonly (keyof ObserverOptions)[] = [
  "every",
  "lookback",
  "mode",
  "maxProposals",
];

function lookback(at: string, value: unknown): string {
  if (typeof value !== "string" || !EVERY_RE.test(value) || everyMs(value) === 0) {
    fail(at, `\`lookback\` must be a period like "14d" or "36h" — got ${JSON.stringify(value)}.`);
  }
  return value;
}

function mode(at: string, value: unknown): ObserverMode {
  if (value === "pr" || value === "issues") return value;
  fail(at, `\`mode\` must be "pr" or "issues" — got ${JSON.stringify(value)}.`);
}

function maxProposals(at: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(at, `\`maxProposals\` must be a positive integer — got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Validate the block a tenant declared and fill the defaults. `at` is the
 * config path the errors name. An unknown field is refused, as every catalog
 * kind refuses one, because a typo'd option would otherwise sit inert while
 * looking configured.
 */
export function resolveObserverOptions(raw: unknown, at: string): ObserverOptions {
  const defaults = OBSERVER_OPTION_DEFAULTS;
  if (raw === undefined) return defaults;
  if (!isRecord(raw)) fail(at, "the observer kind's options must be an object.");
  onlyKeys(at, raw, OPTION_KEYS);
  return {
    every: raw["every"] === undefined ? defaults.every : everyPeriod(at, raw["every"]),
    lookback: raw["lookback"] === undefined ? defaults.lookback : lookback(at, raw["lookback"]),
    mode: raw["mode"] === undefined ? defaults.mode : mode(at, raw["mode"]),
    maxProposals:
      raw["maxProposals"] === undefined
        ? defaults.maxProposals
        : maxProposals(at, raw["maxProposals"]),
  };
}
