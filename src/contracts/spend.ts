// Spend limits (#990, decision #978): the shapes a tenant's or a pipeline's
// `spend` block takes, and what the deployment report says about them.
//
// Two measures over the two windows the history summary already sums. `usd` is
// API spend only, the `costUsd.api` total, so a subscription estimate never
// counts toward it. `tokens` is input plus output tokens from every provider.
// A warning limit is reported; a ceiling holds admission on the pipelines it
// covers until the window falls back under it.

/** One set of limits. Every field is optional and, when present, a positive number. */
export type SpendLimits = {
  /** API spend in US dollars over the last 24 hours. */
  usd24h?: number;
  /** API spend in US dollars over the last 7 days. */
  usd7d?: number;
  /** Input plus output tokens over the last 24 hours. */
  tokens24h?: number;
  /** Input plus output tokens over the last 7 days. */
  tokens7d?: number;
};

/**
 * A `spend` block, on the tenant or on `pipelines.<name>`. No block, or an
 * empty one, means no limits. A ceiling below its matching warning limit is a
 * config error.
 */
export type SpendField = {
  warn?: SpendLimits;
  ceiling?: SpendLimits;
};

/** What a limit counts. */
export type SpendMeasure = "usd" | "tokens";

/** The window a limit is summed over, the history summary's own two. */
export type SpendWindow = "24h" | "7d";

/**
 * Whose block the limit came from. A tenant limit is weighed against the sum of
 * its cells and covers every pipeline the tenant runs; a pipeline limit covers
 * that pipeline only.
 */
export type SpendScope = "tenant" | "pipeline";

/** One limit a cell's spend has reached. */
export type SpendCrossing = {
  scope: SpendScope;
  measure: SpendMeasure;
  window: SpendWindow;
  /** The configured limit. */
  limit: number;
  /** What the window holds now: dollars for `usd`, tokens for `tokens`. */
  spent: number;
};

/**
 * A ceiling holding a pipeline's admission. Units already running finish; no
 * new one starts until the window falls back under the limit or a config edit
 * raises or removes it.
 */
export type SpendHold = SpendCrossing & {
  /** When the bootstrapper first saw the ceiling reached. */
  since: string;
  /** When the window is estimated to fall back under the ceiling, as spend ages out. */
  releaseAt: string;
};

/** Which half of a `spend` block a limit sits in. */
export type SpendLimitLevel = "warn" | "ceiling";

/**
 * One configured limit beside the figure it is weighed against (#991), whether
 * or not the figure has reached it. What a console draws next to the history
 * it applies to.
 */
export type SpendLimitFigure = {
  scope: SpendScope;
  level: SpendLimitLevel;
  measure: SpendMeasure;
  window: SpendWindow;
  /** The configured limit. */
  limit: number;
  /** What the window holds now: the tenant's sum for a tenant limit, the pipeline's own otherwise. */
  spent: number;
};

/**
 * What the report says about one cell's limits. Present only on a cell that a
 * tenant or pipeline `spend` block covers.
 */
export type CellSpend = {
  /** The ceiling holding this pipeline, or null when nothing holds it. */
  hold: SpendHold | null;
  /** Every warning limit this cell's spend has reached, tenant and pipeline both. */
  warnings: SpendCrossing[];
  /**
   * Every limit that covers this cell, tenant ones first, each scope in the
   * order usd24h, usd7d, tokens24h, tokens7d with a warning limit ahead of its
   * ceiling (#991). Absent from a report written before #991.
   */
  limits?: SpendLimitFigure[];
};

// --- how a limit reads -------------------------------------------------------
//
// Pure, so `phoebe status`, the companion's alerts and the console say the same
// sentence about the same limit.

/** A figure in its measure's unit: `$6.00`, `1,200 tokens`. */
export function spendFigure(measure: SpendMeasure, value: number): string {
  return measure === "usd"
    ? `$${value.toFixed(2)}`
    : `${Math.round(value).toLocaleString("en-US")} tokens`;
}

/**
 * One limit against its figure: `API spend $6.00 of $5.00 over 24h`, or
 * `1,200 tokens of 1,000 tokens over 7d`.
 */
export function spendCrossingText(crossing: Omit<SpendCrossing, "scope">): string {
  const what = crossing.measure === "usd" ? "API spend " : "";
  return (
    `${what}${spendFigure(crossing.measure, crossing.spent)} of ` +
    `${spendFigure(crossing.measure, crossing.limit)} over ${crossing.window}`
  );
}

/** When a hold should lift, to the minute: `2026-05-05 21:00 UTC`. */
export function spendReleaseText(releaseAt: string): string {
  const at = Date.parse(releaseAt);
  if (!Number.isFinite(at)) return "an unknown time";
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
