// Spend limits (#990, decision #978): the `spend` block's validation, and the
// evaluation the bootstrapper runs beside the history summary.
//
// Everything here is a pure function of a config block, a summary, the records
// under it and a clock. The bootstrapper evaluates at boot, on each new unit
// record and hourly, which are the moments it sums the history anyway
// (bootstrap/deployment-state.ts). It writes the answer into the report and
// sends the hold to the pipelines it covers. No reader evaluates it again.
//
// Two measures. `usd` is the `costUsd.api` total and nothing else, so a
// subscription estimate, money nobody was billed, never trips a limit. `tokens`
// is input plus output tokens from every provider. Cache reads and writes are
// left out: they are not what a provider's rate limit or bill is built on, and
// a cached prompt counted again on every turn would swamp the figure.

import type {
  SpendCrossing,
  SpendField,
  SpendHold,
  SpendLimits,
  SpendMeasure,
  SpendScope,
  SpendWindow,
} from "./contracts/spend.ts";
import type { HistorySummary, HistoryWindow, UnitRecord } from "./contracts/unit-record.ts";

/** The four limits a `warn` or `ceiling` block may hold, in the order they print. */
export const SPEND_LIMIT_KEYS = ["usd24h", "usd7d", "tokens24h", "tokens7d"] as const;
export type SpendLimitKey = (typeof SPEND_LIMIT_KEYS)[number];

/** The two levels of a `spend` block. */
export const SPEND_LEVELS = ["warn", "ceiling"] as const;
export type SpendLevel = (typeof SPEND_LEVELS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** What each limit counts, and over how long. */
export const SPEND_LIMITS: Readonly<
  Record<SpendLimitKey, { measure: SpendMeasure; window: SpendWindow; windowMs: number }>
> = {
  usd24h: { measure: "usd", window: "24h", windowMs: DAY_MS },
  usd7d: { measure: "usd", window: "7d", windowMs: 7 * DAY_MS },
  tokens24h: { measure: "tokens", window: "24h", windowMs: DAY_MS },
  tokens7d: { measure: "tokens", window: "7d", windowMs: 7 * DAY_MS },
};

/** The limit key a measure and window name. */
export function spendLimitKey(measure: SpendMeasure, window: SpendWindow): SpendLimitKey {
  return `${measure}${window}` as SpendLimitKey;
}

// --- config -----------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject a malformed `spend` block. `at` is the block's dotted path, `spend` on
 * the tenant or `pipelines.<name>.spend`. Each level holds only the four limits,
 * each a positive number, and a ceiling below its matching warning limit is an
 * error that names both: the warning could never fire before the hold.
 */
export function validateSpendField(spend: unknown, at: string): void {
  const where = (path: string): string => `phoebe.config.ts \`${path}\``;
  if (!isPlainObject(spend)) {
    throw new Error(
      `${where(at)} must be an object with optional \`warn\` and \`ceiling\` — ` +
        `got ${JSON.stringify(spend)}.`,
    );
  }
  for (const key of Object.keys(spend)) {
    if (!(SPEND_LEVELS as readonly string[]).includes(key)) {
      throw new Error(
        `${where(at)} names unknown field "${key}". The block holds only \`warn\` and \`ceiling\`.`,
      );
    }
  }
  for (const level of SPEND_LEVELS) {
    const limits = spend[level];
    if (limits === undefined) continue;
    if (!isPlainObject(limits)) {
      throw new Error(
        `${where(`${at}.${level}`)} must be an object holding any of ` +
          `${SPEND_LIMIT_KEYS.join(", ")} — got ${JSON.stringify(limits)}.`,
      );
    }
    for (const [key, value] of Object.entries(limits)) {
      if (!(SPEND_LIMIT_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `${where(`${at}.${level}`)} names unknown limit "${key}". A limit is one of ` +
            `${SPEND_LIMIT_KEYS.join(", ")}.`,
        );
      }
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      ) {
        throw new Error(
          `${where(`${at}.${level}.${key}`)} must be a positive number — got ${JSON.stringify(value)}.`,
        );
      }
    }
  }
  const warn = (spend["warn"] ?? {}) as SpendLimits;
  const ceiling = (spend["ceiling"] ?? {}) as SpendLimits;
  for (const key of SPEND_LIMIT_KEYS) {
    const warnAt = warn[key];
    const holdAt = ceiling[key];
    if (warnAt === undefined || holdAt === undefined || holdAt >= warnAt) continue;
    throw new Error(
      `${where(`${at}.ceiling.${key}`)} (${holdAt}) is below ${where(`${at}.warn.${key}`)} ` +
        `(${warnAt}). A ceiling holds admission, so it must be at or above its warning limit.`,
    );
  }
}

/**
 * The block with nothing in it dropped: no level without a limit, and no block
 * without a level. `undefined` is "no limits", which is what an absent block,
 * an empty one and `{ warn: {} }` all mean.
 */
export function normalizeSpendField(spend: SpendField | undefined): SpendField | undefined {
  if (spend === undefined) return undefined;
  const out: SpendField = {};
  for (const level of SPEND_LEVELS) {
    const limits: SpendLimits = {};
    for (const key of SPEND_LIMIT_KEYS) {
      const value = spend[level]?.[key];
      if (value !== undefined) limits[key] = value;
    }
    if (Object.keys(limits).length > 0) out[level] = limits;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A `spend` block read off a JSON answer leniently: the limits that are positive
 * numbers, nothing else. The engine validated the block before it printed it;
 * this is the bootstrapper refusing to trust a shape across a process boundary.
 */
export function readSpendField(value: unknown): SpendField | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: SpendField = {};
  for (const level of SPEND_LEVELS) {
    const limits = value[level];
    if (!isPlainObject(limits)) continue;
    const kept: SpendLimits = {};
    for (const key of SPEND_LIMIT_KEYS) {
      const limit = limits[key];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) kept[key] = limit;
    }
    out[level] = kept;
  }
  return normalizeSpendField(out);
}

/** The config path a scope's limit sits at, as an operator would edit it. */
export function spendLimitPath(
  scope: SpendScope,
  level: SpendLevel,
  key: SpendLimitKey,
  pipeline: string,
): string {
  const block = scope === "tenant" ? "spend" : `pipelines.${pipeline}.spend`;
  return `${block}.${level}.${key}`;
}

// --- measures ---------------------------------------------------------------

/** The four figures a set of limits is weighed against. */
export type SpendTotals = Record<SpendLimitKey, number>;

/** Nothing spent. */
export function zeroTotals(): SpendTotals {
  return { usd24h: 0, usd7d: 0, tokens24h: 0, tokens7d: 0 };
}

function windowUsd(window: HistoryWindow): number {
  return window.costUsd.api;
}

function windowTokens(window: HistoryWindow): number {
  return window.tokens.input + window.tokens.output;
}

/** A history summary's figures, as the limits count them. */
export function spendTotals(summary: HistorySummary): SpendTotals {
  return {
    usd24h: windowUsd(summary.last24h),
    usd7d: windowUsd(summary.last7d),
    tokens24h: windowTokens(summary.last24h),
    tokens7d: windowTokens(summary.last7d),
  };
}

/** Two sets of figures added, the way a tenant's are the sum of its cells. */
export function addTotals(a: SpendTotals, b: SpendTotals): SpendTotals {
  const out = zeroTotals();
  for (const key of SPEND_LIMIT_KEYS) out[key] = roundUsd(a[key] + b[key]);
  return out;
}

/** Float sums of cents drift, the same rounding the summary uses. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** What one unit record counts toward each measure. */
export function recordSpend(record: UnitRecord): Record<SpendMeasure, number> {
  let usd = 0;
  let tokens = 0;
  for (const run of record.agentRuns) {
    if (run.costBasis === "api" && run.costUsd !== null) usd += run.costUsd;
    tokens += (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  }
  return { usd, tokens };
}

/**
 * When the window is expected to fall back under `limit`: the moment enough of
 * the oldest units inside it have aged out. A unit counts by when it started,
 * as the summary does, so it leaves the window `windowMs` after its start.
 * Past the last unit the window holds nothing, so that is the latest it can be.
 */
export function estimateRelease(opts: {
  records: readonly UnitRecord[];
  measure: SpendMeasure;
  windowMs: number;
  limit: number;
  total: number;
  asOf: number;
}): number {
  const inside = opts.records
    .map((record) => ({ at: Date.parse(record.startedAt), record }))
    .filter(({ at }) => Number.isFinite(at) && at > opts.asOf - opts.windowMs)
    .sort((a, b) => a.at - b.at);
  let remaining = opts.total;
  let last = opts.asOf - opts.windowMs;
  for (const { at, record } of inside) {
    remaining -= recordSpend(record)[opts.measure];
    last = at;
    if (remaining < opts.limit) return at + opts.windowMs;
  }
  return Math.max(last + opts.windowMs, opts.asOf);
}

// --- evaluation -------------------------------------------------------------

/**
 * When each ceiling was first seen reached, so a hold's `since` stays put
 * across the re-evaluations that follow. Kept in the bootstrapper's memory: a
 * restart starts the clock again at the first evaluation that sees it.
 */
export type SpendClock = {
  /** The moment `key` was first seen reached, `at` if this is that moment. */
  since: (key: string, at: number) => number;
  /** Forget every key not asked about since the last sweep. */
  sweep: () => void;
};

export function createSpendClock(): SpendClock {
  const first = new Map<string, number>();
  const seen = new Set<string>();
  return {
    since(key, at) {
      seen.add(key);
      const known = first.get(key);
      if (known !== undefined) return known;
      first.set(key, at);
      return at;
    },
    sweep() {
      for (const key of first.keys()) if (!seen.has(key)) first.delete(key);
      seen.clear();
    },
  };
}

/** What one scope's limits make of its figures. */
export type ScopeEvaluation = { holds: SpendHold[]; warnings: SpendCrossing[] };

/**
 * Weigh one scope's limits against its figures. A limit is reached when the
 * window holds at least that much; a ceiling stops holding once it holds less.
 */
export function evaluateSpend(opts: {
  scope: SpendScope;
  /** Distinguishes two tenants' or two pipelines' clocks. */
  clockKey: string;
  limits: SpendField | undefined;
  totals: SpendTotals;
  /** The records under the totals, for the release estimate. */
  records: readonly UnitRecord[];
  asOf: number;
  clock: SpendClock;
}): ScopeEvaluation {
  const holds: SpendHold[] = [];
  const warnings: SpendCrossing[] = [];
  if (opts.limits === undefined) return { holds, warnings };
  for (const key of SPEND_LIMIT_KEYS) {
    const { measure, window, windowMs } = SPEND_LIMITS[key];
    const spent = opts.totals[key];
    const warnAt = opts.limits.warn?.[key];
    if (warnAt !== undefined && spent >= warnAt) {
      warnings.push({ scope: opts.scope, measure, window, limit: warnAt, spent });
    }
    const holdAt = opts.limits.ceiling?.[key];
    if (holdAt === undefined || spent < holdAt) continue;
    const since = opts.clock.since(`${opts.clockKey}|${key}`, opts.asOf);
    const releaseAt = estimateRelease({
      records: opts.records,
      measure,
      windowMs,
      limit: holdAt,
      total: spent,
      asOf: opts.asOf,
    });
    holds.push({
      scope: opts.scope,
      measure,
      window,
      limit: holdAt,
      spent,
      since: new Date(since).toISOString(),
      releaseAt: new Date(releaseAt).toISOString(),
    });
  }
  return { holds, warnings };
}

/**
 * The hold that binds when several ceilings are reached at once: the one that
 * lets go last, since admission resumes only when every one has.
 */
export function bindingHold(holds: readonly SpendHold[]): SpendHold | null {
  let binding: SpendHold | null = null;
  for (const hold of holds) {
    if (binding === null || Date.parse(hold.releaseAt) > Date.parse(binding.releaseAt)) {
      binding = hold;
    }
  }
  return binding;
}

/** A figure in its measure's unit. */
export function formatSpend(measure: SpendMeasure, value: number): string {
  return measure === "usd"
    ? `$${value.toFixed(2)}`
    : `${Math.round(value).toLocaleString("en-US")} tokens`;
}

/**
 * A hold as one sentence an operator can act on: which limit, where it is set,
 * what the window holds, and when it should let go.
 */
export function describeSpendHold(hold: SpendHold, pipeline: string): string {
  const path = spendLimitPath(
    hold.scope,
    "ceiling",
    spendLimitKey(hold.measure, hold.window),
    pipeline,
  );
  const what = hold.measure === "usd" ? "API spend" : "tokens";
  return (
    `the spend ceiling \`${path}\` is reached: ${what} over the last ${hold.window} is ` +
    `${formatSpend(hold.measure, hold.spent)} against a ceiling of ` +
    `${formatSpend(hold.measure, hold.limit)}. Held until about ${hold.releaseAt}, ` +
    `or until the ceiling is raised or removed`
  );
}
