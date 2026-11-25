import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRecord, UnitRecord } from "./contracts/unit-record.ts";
import { readUnitHistory, summarizeHistory, summarizeWindow } from "./unit-history.ts";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    startedAt: "2026-11-25T11:00:00.000Z",
    durationMs: 1000,
    exitCode: 0,
    promptSha: "sha",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheWriteTokens: 10,
    reasoningTokens: null,
    costUsd: null,
    turns: 3,
    providerDurationMs: 900,
    stopReason: null,
    reportedModels: [],
    usageComplete: true,
    toolCalls: {},
    costBasis: null,
    ...overrides,
  };
}

function record(overrides: Partial<UnitRecord> = {}): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issue", id: "1" },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: new Date(NOW - HOUR).toISOString(),
    settledAt: new Date(NOW - HOUR / 2).toISOString(),
    durationMs: HOUR / 2,
    runBudgetMs: null,
    provider: "claude",
    model: null,
    effort: null,
    branch: null,
    headSha: null,
    prNumber: null,
    engineCommit: null,
    agentRuns: [],
    ...overrides,
  };
}

describe("summarizeWindow", () => {
  test("counts units by outcome and quarantine", () => {
    const window = summarizeWindow([
      record(),
      record({ outcome: "failed" }),
      record({ outcome: "timed-out", quarantined: true }),
      record({ outcome: "abandoned", settledAt: null, durationMs: null }),
    ]);
    expect(window.units).toBe(4);
    expect(window.outcomes).toEqual({ completed: 1, failed: 1, "timed-out": 1, abandoned: 1 });
    expect(window.quarantined).toBe(1);
  });

  test("keeps API spend and the subscription estimate apart, never summed", () => {
    const window = summarizeWindow([
      record({ agentRuns: [run({ costUsd: 0.1, costBasis: "api" })] }),
      record({
        agentRuns: [
          run({ costUsd: 0.2, costBasis: "api" }),
          run({ costUsd: 1.5, costBasis: "subscription-estimate" }),
        ],
      }),
    ]);
    expect(window.costUsd).toEqual({ api: 0.3, subscriptionEstimate: 1.5 });
  });

  test("counts units with no cost and units with partial usage", () => {
    const window = summarizeWindow([
      record({ agentRuns: [run()] }),
      record(),
      record({ agentRuns: [run({ costUsd: 0.4, costBasis: "api", usageComplete: false })] }),
      // A figure no basis describes is in neither total, so the unit has no cost.
      record({ agentRuns: [run({ costUsd: 9, costBasis: null })] }),
    ]);
    expect(window.unitsWithoutCost).toBe(3);
    expect(window.unitsWithPartialUsage).toBe(1);
    expect(window.costUsd).toEqual({ api: 0.4, subscriptionEstimate: 0 });
  });

  test("sums tokens across every agent run, a null counting as nothing", () => {
    const window = summarizeWindow([
      record({ agentRuns: [run(), run({ inputTokens: null, cacheWriteTokens: null })] }),
    ]);
    expect(window.tokens).toEqual({ input: 100, output: 100, cacheRead: 2000, cacheWrite: 10 });
  });
});

describe("summarizeHistory", () => {
  test("puts each unit in the windows it started inside, stamped with the clock", () => {
    const summary = summarizeHistory(
      [
        record({ startedAt: new Date(NOW - HOUR).toISOString() }),
        record({ startedAt: new Date(NOW - 30 * HOUR).toISOString(), outcome: "failed" }),
        record({ startedAt: new Date(NOW - 8 * 24 * HOUR).toISOString() }),
      ],
      NOW,
    );
    expect(summary.asOf).toBe("2026-11-25T12:00:00.000Z");
    expect(summary.last24h.units).toBe(1);
    expect(summary.last24h.outcomes.failed).toBe(0);
    expect(summary.last7d.units).toBe(2);
    expect(summary.last7d.outcomes.failed).toBe(1);
  });

  test("an empty history is a summary of zeros, not an absent one", () => {
    const summary = summarizeHistory([], NOW);
    expect(summary.last24h.units).toBe(0);
    expect(summary.last7d.costUsd).toEqual({ api: 0, subscriptionEstimate: 0 });
  });
});

describe("readUnitHistory", () => {
  function stateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-unit-history-test-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  test("reads both generations, the rotated one first", () => {
    const dir = stateDir();
    mkdirSync(join(dir, "work"));
    const older = record({ unit: { kind: "issue", id: "old" } });
    const newer = record({ unit: { kind: "issue", id: "new" } });
    writeFileSync(join(dir, "work", "units.1.jsonl"), `${JSON.stringify(older)}\n`);
    writeFileSync(join(dir, "work", "units.jsonl"), `${JSON.stringify(newer)}\n`);

    expect(readUnitHistory(dir, "work").map((r) => r.unit.id)).toEqual(["old", "new"]);
  });

  test("skips a torn line and a version it does not know", () => {
    const dir = stateDir();
    mkdirSync(join(dir, "work"));
    writeFileSync(
      join(dir, "work", "units.jsonl"),
      [JSON.stringify({ ...record(), v: 2 }), '{"v":1,"tenant', JSON.stringify(record()), ""].join(
        "\n",
      ),
    );

    expect(readUnitHistory(dir, "work")).toHaveLength(1);
  });

  test("a pipeline that never settled a unit has an empty history", () => {
    expect(readUnitHistory(stateDir(), "work")).toEqual([]);
  });
});
