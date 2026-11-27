// The history export's mapping (#992): one CSV row per unit with its usage
// summed across agent runs, API spend and the subscription estimate in columns
// of their own, and JSON Lines as the records themselves. Both entries of
// `phoebe-agent/contracts` hand out this one implementation.

import { describe, expect, test } from "vite-plus/test";
import type { HistoryRecord } from "./history.ts";
import {
  HISTORY_CSV_COLUMNS,
  historyCsvFields,
  historyExportHead,
  historyExportLines,
} from "./history-export.mjs";
import * as typed from "./index.ts";
import * as shipped from "./index.mjs";
import type { AgentRunRecord } from "./unit-record.ts";

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    startedAt: "2026-11-25T10:00:00.000Z",
    durationMs: 60_000,
    exitCode: 0,
    promptSha: "a".repeat(64),
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 5,
    reasoningTokens: null,
    costUsd: 0.1,
    turns: 3,
    providerDurationMs: null,
    stopReason: null,
    reportedModels: [],
    usageComplete: true,
    toolCalls: {},
    costBasis: "api",
    ...overrides,
  };
}

function record(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    cell: "/etc/phoebe#work",
    unit: { kind: "issues", id: "42" },
    outcome: "completed",
    quarantined: false,
    detail: "Opened a PR, with a comma",
    startedAt: "2026-11-25T10:00:00.000Z",
    settledAt: "2026-11-25T10:30:00.000Z",
    durationMs: 1_800_000,
    runBudgetMs: 3_600_000,
    provider: "claude",
    model: "claude-opus-5-5",
    effort: null,
    branch: "phoebe/issue-42",
    headSha: null,
    prNumber: 77,
    engineCommit: null,
    agentRuns: [run()],
    ...overrides,
  };
}

/** The row as column name → cell, so a test reads by name. */
function row(r: HistoryRecord): Record<string, string> {
  const fields = historyCsvFields(r);
  return Object.fromEntries(HISTORY_CSV_COLUMNS.map((name, i) => [name, fields[i]!]));
}

describe("a CSV row", () => {
  test("sums usage across the unit's agent runs", () => {
    const fields = row(
      record({
        agentRuns: [
          run(),
          run({
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 25,
            cacheWriteTokens: 0,
            costUsd: 0.2,
          }),
        ],
      }),
    );
    expect(fields).toMatchObject({
      agent_runs: "2",
      input_tokens: "1500",
      output_tokens: "300",
      cache_read_tokens: "75",
      cache_write_tokens: "5",
      api_cost_usd: "0.3",
      estimated_cost_usd: "",
      partial_usage: "false",
    });
  });

  test("keeps API spend and the subscription estimate in separate columns, never added", () => {
    const fields = row(
      record({
        agentRuns: [
          run({ costUsd: 0.25, costBasis: "api" }),
          run({ costUsd: 1.5, costBasis: "subscription-estimate" }),
          run({ costUsd: 0.5, costBasis: "subscription-estimate" }),
        ],
      }),
    );
    expect(fields["api_cost_usd"]).toBe("0.25");
    expect(fields["estimated_cost_usd"]).toBe("2");
  });

  test("leaves a figure no run reported empty, never 0", () => {
    const fields = row(
      record({
        agentRuns: [
          run({ inputTokens: null, cacheWriteTokens: null, costUsd: null, costBasis: null }),
          run({ inputTokens: null, cacheWriteTokens: null, costUsd: null, costBasis: null }),
        ],
      }),
    );
    expect(fields["input_tokens"]).toBe("");
    expect(fields["cache_write_tokens"]).toBe("");
    expect(fields["output_tokens"]).toBe("400");
    expect(fields["api_cost_usd"]).toBe("");
    expect(fields["estimated_cost_usd"]).toBe("");
  });

  test("an abandoned unit with no runs has no end, no usage, and no PR link without a PR", () => {
    const fields = row(
      record({ outcome: "abandoned", settledAt: null, prNumber: null, agentRuns: [] }),
    );
    expect(fields).toMatchObject({
      outcome: "abandoned",
      ended: "",
      agent_runs: "0",
      input_tokens: "",
      partial_usage: "false",
      pr_link: "",
    });
  });

  test("carries the identity, the flags and the PR link", () => {
    const fields = row(
      record({
        outcome: "timed-out",
        quarantined: true,
        agentRuns: [run({ usageComplete: false })],
      }),
    );
    expect(fields).toMatchObject({
      cell: "/etc/phoebe#work",
      kind: "issues",
      unit: "42",
      outcome: "timed-out",
      quarantined: "true",
      started: "2026-11-25T10:00:00.000Z",
      ended: "2026-11-25T10:30:00.000Z",
      provider: "claude",
      model: "claude-opus-5-5",
      partial_usage: "true",
      pr_link: "https://github.com/acme/widget/pull/77",
    });
  });

  test("a tenant that is not owner/repo has no PR link", () => {
    expect(row(record({ tenant: "/srv/checkout" }))["pr_link"]).toBe("");
  });
});

describe("an export file", () => {
  test("CSV is the header, then one line per unit, quoting what needs it", () => {
    const text =
      historyExportHead("csv") +
      historyExportLines("csv", [record(), record({ cell: 'odd,"cell"' })]);
    const lines = text.split("\n");
    expect(lines[0]).toBe(HISTORY_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(lines[2]!.startsWith('"odd,""cell""",issues,42,')).toBe(true);
    expect(text).not.toContain("with a comma");
    expect(text).not.toContain("phoebe/issue-42");
  });

  test("JSON Lines is one full record per line, with no header", () => {
    const records = [record(), record({ unit: { kind: "reviews", id: "pr:9" } })];
    expect(historyExportHead("jsonl")).toBe("");
    const lines = historyExportLines("jsonl", records).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual(records);
  });
});

describe("the subpath", () => {
  test("hands out the one implementation from both entries", () => {
    expect(shipped.historyExportLines).toBe(typed.historyExportLines);
    expect(shipped.historyExportHead).toBe(typed.historyExportHead);
    expect(shipped.HISTORY_MAX_LIMIT).toBe(typed.HISTORY_MAX_LIMIT);
    expect(shipped.HISTORY_CSV_COLUMNS).toBe(typed.HISTORY_CSV_COLUMNS);
    expect(shipped.HISTORY_EXPORT_FORMATS).toBe(typed.HISTORY_EXPORT_FORMATS);
  });
});
