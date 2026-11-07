// What the dependency detectors' options blocks share (ADR 0003): the
// validators that turn a bad field into an error naming its config path, and
// the `every` and `sources` fields both detectors carry.

import { SOURCE_NAMES, type SourceName } from "./sources/assemble.ts";

/** A count and one of s/m/h/d/w. */
export const EVERY_RE = /^(\d+)([smhdw])$/;

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `every` in milliseconds. The value has been validated. */
export function everyMs(every: string): number {
  const match = EVERY_RE.exec(every)!;
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

export function fail(at: string, problem: string): never {
  throw new Error(`${at}: ${problem}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function onlyKeys(
  at: string,
  block: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of Object.keys(block)) {
    if (!keys.includes(key)) {
      fail(at, `unknown option \`${key}\`. Expected one of: ${keys.join(", ")}.`);
    }
  }
}

export function nonEmptyString(at: string, key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(at, `\`${key}\` must be a non-empty string — got ${JSON.stringify(value)}.`);
  }
  return value;
}

export function oneOf<T extends string>(
  at: string,
  key: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(at, `\`${key}\` must be one of ${allowed.join(", ")} — got ${JSON.stringify(value)}.`);
  }
  return value as T;
}

export function nonNegativeInteger(at: string, key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(at, `\`${key}\` must be a non-negative integer — got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** A non-empty list of source names, each named once. */
export function sources(at: string, value: unknown): readonly SourceName[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(at, `\`sources\` must be a non-empty array of ${SOURCE_NAMES.join(", ")}.`);
  }
  const seen = new Set<SourceName>();
  for (const name of value) {
    const source = oneOf(at, "sources[]", name, SOURCE_NAMES);
    if (seen.has(source)) fail(at, `\`sources\` lists ${source} twice.`);
    seen.add(source);
  }
  return [...seen];
}

/** A validated `every` period. */
export function everyPeriod(at: string, value: unknown): string {
  if (typeof value !== "string" || !EVERY_RE.test(value) || everyMs(value) === 0) {
    fail(at, `\`every\` must be a period like "1d" or "12h" — got ${JSON.stringify(value)}.`);
  }
  return value;
}
