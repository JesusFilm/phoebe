// The unit record (#917, spec #923): one line of a pipeline's unit history,
// written once per work unit that settled or was abandoned. The writer and its
// rotation live in src/unit-record.ts; the shape lives here because the history
// reaches readers that may not load an engine — `phoebe history`, the
// deployment API, the console.
//
// Every line carries `v`. One rotated file can span an engine upgrade, so a
// reader skips a version it does not know rather than misreading it.

import type { UnitRef } from "./status-snapshot.ts";

/** The record version every line written today carries. */
export const UNIT_RECORD_VERSION = 1;

/** The most characters `detail` holds. */
export const UNIT_RECORD_DETAIL_MAX = 500;

/** The most tool names one agent run's `toolCalls` keeps before folding into `other`. */
export const TOOL_CALL_NAMES_MAX = 32;

/** Where the tool calls past {@link TOOL_CALL_NAMES_MAX} are counted. */
export const OTHER_TOOL_CALLS = "other";

/**
 * How a unit ended, as history sees it. `skipped` and `waiting-for-slot` never
 * write a record, since no work happened; a quarantine is a flag on the
 * timed-out record it follows, not an outcome of its own.
 */
export type UnitRecordOutcome = "completed" | "failed" | "timed-out" | "abandoned";

/**
 * What a cost figure is. `api` is money a key was billed; `subscription-estimate`
 * is the list-price figure Claude reports under a subscription, which nobody
 * paid. Read from the credential Phoebe put in the agent's environment, never
 * from a price table. `null` when there is no cost figure to describe.
 */
export type CostBasis = "api" | "subscription-estimate";

/**
 * The usage one agent run reported. Every number is what the provider CLI said,
 * or `null` when it said nothing — never a zero standing in for "unknown".
 */
export type AgentRunUsage = {
  /** Uncached input tokens. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Reasoning or thinking tokens, where the provider reports them. */
  reasoningTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  /** How long the provider says the run took, which is not the engine's clock. */
  providerDurationMs: number | null;
  stopReason: string | null;
  /** Every model the provider says it used, subagents included. */
  reportedModels: string[];
  /**
   * False when the run ended without its terminal usage line — killed by the run
   * budget, or crashed — so the numbers are what survived, a lower bound.
   */
  usageComplete: boolean;
  /** Every tool the agent called, by name: at most 32 names, the rest under `other`. */
  toolCalls: Record<string, number>;
};

/** One spawn of a provider CLI inside a unit. */
export type AgentRunRecord = AgentRunUsage & {
  startedAt: string;
  /** Engine wall clock from spawn to exit, or to the record when it never exited. */
  durationMs: number;
  /** `null` when the record was written before the child exited. */
  exitCode: number | null;
  /** SHA-256 of the prompt template before rendering; a tenant override hashes apart. */
  promptSha: string;
  costBasis: CostBasis | null;
};

/** One line of `state/<pipeline>/units.jsonl`. */
export type UnitRecord = {
  v: typeof UNIT_RECORD_VERSION;
  tenant: string;
  pipeline: string;
  unit: UnitRef;
  outcome: UnitRecordOutcome;
  /** This timeout was the one that quarantined the unit. */
  quarantined: boolean;
  /** Failure or timeout text, or a completed unit's summary; at most 500 characters. */
  detail: string | null;
  /** When the slot was granted — the `started` event. */
  startedAt: string;
  /** `null` when abandoned. */
  settledAt: string | null;
  /** Engine wall clock, `null` when abandoned. */
  durationMs: number | null;
  runBudgetMs: number | null;
  /** The provider, model and effort the unit was configured to run on. */
  provider: string | null;
  model: string | null;
  effort: string | null;
  branch: string | null;
  headSha: string | null;
  prNumber: number | null;
  /** The engine commit that ran the unit, `null` when it is not a git checkout. */
  engineCommit: string | null;
  agentRuns: AgentRunRecord[];
};
