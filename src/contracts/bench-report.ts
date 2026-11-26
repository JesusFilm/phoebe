// What a bench run ends with (#941; spec #925, decisions #921): one row per
// contender, saved as `bench/<runId>/report.json`, printed by `bench run --json`
// and reprinted by `phoebe bench report <runId>`.
//
// Its own module because it is the one bench file meant for readers outside the
// engine: a CI step that compares two runs, a console, a script. They read this
// shape and never the trial lines it was computed from.
//
// `v` moves only when an existing reader would misread a report.

import type {
  BenchBaselineGate,
  BenchContender,
  BenchGates,
  BenchJudge,
  BenchRunConfig,
  BenchVerdict,
} from "./bench.ts";

/**
 * How many of a contender's trials passed one gate. `of` counts every trial the
 * contender recorded, so a trial that made no change, failed, timed out or
 * stopped at an earlier gate counts against it. `rate` is `passed / of`, `null`
 * when there were no trials.
 */
export type BenchGateRate = {
  passed: number;
  of: number;
  rate: number | null;
};

/**
 * How a contender's trials with commits were judged: one count per verdict,
 * and `unjudged` for the trials with commits the judge gave no verdict on.
 */
export type BenchVerdictCounts = Record<BenchVerdict, number> & { unjudged: number };

/**
 * What the judge itself spent across the run. Never part of any contender's
 * row, so it cannot skew the comparison.
 */
export type BenchJudgeUsage = BenchJudge & {
  /** Judge runs started. */
  runs: number;
  /** Input, output and cache tokens across them; `null` when none reported any. */
  tokens: number | null;
  apiCostUsd: number | null;
  subscriptionEstimateUsd: number | null;
};

/** Where a baseline failed, and how. */
export type BenchBaselineFailure = {
  gate: BenchBaselineGate;
  /** `null` when the gate never exited on its own, and always for `checkout`. */
  exitCode: number | null;
};

/**
 * A fixture whose baseline failed in this run (#988): its merged PR's head no
 * longer passes the gates with no agent, so none of its trials ran and no rate
 * counts it.
 */
export type BenchUnstableFixture = BenchBaselineFailure & {
  issue: number;
  pr: number;
  /** From the suite, so drift since pinning shows; `null` when it was pinned without a baseline. */
  baselinePassedAt: string | null;
};

/** One contender's results across every fixture and repeat. */
export type BenchReportRow = {
  /** The settings the contender ran with, the tenant's filling what it left unset. */
  contender: BenchContender;
  /** Trials recorded for this contender. */
  trials: number;
  outcomes: { completed: number; failed: number; timedOut: number };
  /** Completed trials whose agent left no commits. */
  noChange: number;
  /** `null` when the tenant has no `checkCommand` (or `testCommand`) to run. */
  check: BenchGateRate | null;
  test: BenchGateRate | null;
  /** Median engine wall clock per trial, install and gates included. */
  medianDurationMs: number | null;
  /**
   * Median tokens per trial: input, output and cache tokens across the trial's
   * agent runs. Over the trials whose provider reported any; `null` when none did.
   */
  medianTokens: number | null;
  /** Total cost the provider reported as billed to an API key; `null` when none did. */
  apiCostUsd: number | null;
  /** Total list-price figure the provider reported under a subscription; `null` when none did. */
  subscriptionEstimateUsd: number | null;
  /** `null` when the run had no judge. */
  verdicts: BenchVerdictCounts | null;
};

/** `bench/<runId>/report.json`. */
export type BenchReport = {
  v: 1;
  runId: string;
  repo: string;
  /** ISO. */
  startedAt: string;
  finishedAt: string;
  /** Stopped by Ctrl-C: the trials in flight were dropped, and the rows count what finished. */
  interrupted: boolean;
  suite: BenchRunConfig["suite"];
  benchConfig: string | null;
  repeat: number;
  concurrency: number;
  /**
   * Each fixture's baseline gates, keyed by issue number: the merged PR's head
   * run through install, check and test with no agent, before any trial.
   */
  baselines: Record<string, BenchGates>;
  /** Fixtures whose baseline failed, in suite order. Their trials never ran. */
  unstable: BenchUnstableFixture[];
  /** Trials the run meant to make, for stable fixtures only, and the ones it recorded. */
  planned: number;
  recorded: number;
  /** Across every contender. */
  outcomes: { completed: number; failed: number; timedOut: number; noChange: number };
  /** One per contender, in the order the bench config lists them. */
  contenders: BenchReportRow[];
  /** The judge and what it spent; `null` when the run had no judge. */
  judge: BenchJudgeUsage | null;
};
