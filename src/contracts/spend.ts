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

/**
 * What the report says about one cell's limits. Present only on a cell that a
 * tenant or pipeline `spend` block covers.
 */
export type CellSpend = {
  /** The ceiling holding this pipeline, or null when nothing holds it. */
  hold: SpendHold | null;
  /** Every warning limit this cell's spend has reached, tenant and pipeline both. */
  warnings: SpendCrossing[];
};
