// The bench report (#941): trials in, one row per contender out, as JSON and as
// the terminal table. Pure, so the trials here are written by hand.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  buildBenchReport,
  formatDuration,
  formatTokens,
  median,
  NONE,
  readBenchReport,
  renderBenchReport,
  REPORT_FILE,
  trialTokens,
  verdictCounts,
} from "./bench-report.ts";
import type {
  BenchContender,
  BenchJudgement,
  BenchRunConfig,
  BenchTrial,
} from "./contracts/bench.ts";
import type { AgentRunRecord } from "./contracts/unit-record.ts";

function contender(name: string, provider = "claude"): BenchContender {
  return {
    name,
    provider,
    model: `${name}-model`,
    effort: null,
    promptFile: "prompts/issues-prompt.md",
    promptSha: "s".repeat(64),
  };
}

const RUN_CONFIG: BenchRunConfig = {
  v: 1,
  runId: "2026-11-25T12-00-00-000Z",
  repo: "acme/widget",
  startedAt: "2026-11-25T12:00:00.000Z",
  suite: { path: "bench/suite.json", selectedAt: "2026-11-24T00:00:00.000Z", fixtures: [7, 8] },
  benchConfig: "bench/bench.json",
  contenders: [contender("claude"), contender("codex", "codex")],
  repeat: 1,
  judge: null,
  concurrency: 1,
  runTimeoutMs: 2_700_000,
  installCommand: "pnpm install",
  checkCommand: "pnpm check",
  testCommand: "pnpm test",
  engineCommit: null,
};

function agentRun(over: Partial<AgentRunRecord>): AgentRunRecord {
  return {
    startedAt: "2026-11-25T12:00:00.000Z",
    durationMs: 1000,
    exitCode: 0,
    promptSha: "s".repeat(64),
    costBasis: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
    turns: null,
    providerDurationMs: null,
    stopReason: null,
    reportedModels: [],
    usageComplete: true,
    toolCalls: {},
    ...over,
  };
}

const PASS = { command: "x", exitCode: 0, durationMs: 1 };
const FAIL = { command: "x", exitCode: 1, durationMs: 1 };

function trial(over: Partial<BenchTrial> & Pick<BenchTrial, "contender">): BenchTrial {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "bench",
    unit: { kind: "issues", id: "issue:7" },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: "2026-11-25T12:00:00.000Z",
    settledAt: "2026-11-25T12:01:00.000Z",
    durationMs: 60_000,
    runBudgetMs: 2_700_000,
    provider: "claude",
    model: "m",
    effort: null,
    branch: "phoebe/issue-7",
    headSha: null,
    prNumber: null,
    engineCommit: null,
    agentRuns: [],
    runId: RUN_CONFIG.runId,
    fixture: { issue: 7, pr: 70, baseSha: "b".repeat(40) },
    repeat: 0,
    change: "committed",
    gates: { install: PASS, check: PASS, test: PASS },
    diff: null,
    patch: null,
    wouldHave: [],
    judgement: null,
    ...over,
  };
}

const TRIALS: BenchTrial[] = [
  trial({
    contender: "claude",
    durationMs: 60_000,
    agentRuns: [
      agentRun({
        costBasis: "api",
        costUsd: 0.5,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 5000,
        cacheWriteTokens: 300,
        reasoningTokens: 50,
      }),
    ],
  }),
  trial({
    contender: "claude",
    durationMs: 120_000,
    gates: { install: PASS, check: PASS, test: FAIL },
    agentRuns: [agentRun({ costBasis: "subscription-estimate", costUsd: 1.25, inputTokens: 100 })],
  }),
  trial({
    contender: "codex",
    provider: "codex",
    change: "none",
    gates: { install: PASS, check: null, test: null },
    durationMs: 30_000,
    agentRuns: [agentRun({ inputTokens: 40, outputTokens: 10 })],
  }),
  trial({
    contender: "codex",
    provider: "codex",
    outcome: "timed-out",
    gates: { install: PASS, check: null, test: null },
    durationMs: 90_000,
    agentRuns: [agentRun({})],
  }),
];

describe("buildBenchReport", () => {
  const report = buildBenchReport({
    runConfig: RUN_CONFIG,
    trials: TRIALS,
    finishedAt: new Date("2026-11-25T12:10:00.000Z"),
    interrupted: false,
  });

  test("one row per contender, in the bench config's order", () => {
    expect(report.contenders.map((row) => row.contender.name)).toEqual(["claude", "codex"]);
    expect(report).toMatchObject({
      v: 1,
      runId: RUN_CONFIG.runId,
      finishedAt: "2026-11-25T12:10:00.000Z",
      planned: 4,
      recorded: 4,
      outcomes: { completed: 3, failed: 0, timedOut: 1, noChange: 1 },
    });
  });

  test("pass rates count every trial, so no change and a timeout count against", () => {
    const [claude, codex] = report.contenders;
    expect(claude).toMatchObject({
      trials: 2,
      noChange: 0,
      check: { passed: 2, of: 2, rate: 1 },
      test: { passed: 1, of: 2, rate: 0.5 },
    });
    expect(codex).toMatchObject({
      trials: 2,
      noChange: 1,
      outcomes: { completed: 1, failed: 0, timedOut: 1 },
      check: { passed: 0, of: 2, rate: 0 },
      test: { passed: 0, of: 2, rate: 0 },
    });
  });

  test("medians, and API cost apart from the subscription estimate", () => {
    const [claude, codex] = report.contenders;
    expect(claude!.medianDurationMs).toBe(90_000);
    expect(claude!.medianTokens).toBe((6500 + 100) / 2);
    expect(claude!.apiCostUsd).toBe(0.5);
    expect(claude!.subscriptionEstimateUsd).toBe(1.25);
    // A provider that reports no cost has none, rather than a zero.
    expect(codex!.apiCostUsd).toBeNull();
    expect(codex!.subscriptionEstimateUsd).toBeNull();
    // The timed-out trial reported no tokens, so the median is the one that did.
    expect(codex!.medianTokens).toBe(50);
  });

  test("a blank gate command has no rate, and a contender with no trials has no figures", () => {
    const empty = buildBenchReport({
      runConfig: { ...RUN_CONFIG, testCommand: "" },
      trials: [],
      finishedAt: new Date("2026-11-25T12:10:00.000Z"),
      interrupted: true,
    });
    expect(empty.contenders[0]).toMatchObject({
      trials: 0,
      check: { passed: 0, of: 0, rate: null },
      test: null,
      medianDurationMs: null,
      medianTokens: null,
    });
    expect(empty.interrupted).toBe(true);
  });

  test("renders a row per contender with the listed columns, and a dash for none", () => {
    const table = renderBenchReport(report);
    const lines = table.split("\n");
    const header = lines.find((line) => line.startsWith("contender"))!;
    expect(header.split(/\s{2,}/)).toEqual([
      "contender",
      "trials",
      "no change",
      "check",
      "test",
      "median time",
      "median tokens",
      "API cost",
      "subscription est.",
    ]);
    const row = (name: string): string[] =>
      lines
        .find((line) => line.startsWith(`${name} `))!
        .trim()
        .split(/\s{2,}/);
    expect(row("claude")).toEqual([
      "claude",
      "2",
      "0",
      "100%",
      "50%",
      "1m 30s",
      "3.3k",
      "$0.50",
      "$1.25",
    ]);
    expect(row("codex")).toEqual(["codex", "2", "1", "0%", "0%", "1m 00s", "50", NONE, NONE]);
    expect(table).toContain("2 fixture(s) × 2 contender(s) × 1 repeat(s): 4/4 trial(s) recorded");
    expect(table).toContain("codex · codex-model · prompts/issues-prompt.md");
  });
});

describe("with a judge", () => {
  const JUDGE = { provider: "claude", model: "judge-model" };

  function judged(
    verdict: BenchJudgement["verdict"],
    run: AgentRunRecord | null = agentRun({}),
  ): BenchJudgement {
    return {
      ...JUDGE,
      verdict,
      rationale: verdict === null ? null : "because",
      error: verdict === null ? "the judge's reply held no verdict on the scale" : null,
      run,
    };
  }

  const JUDGED: BenchTrial[] = [
    trial({
      contender: "claude",
      patch: "patches/a.patch",
      agentRuns: [agentRun({ costBasis: "api", costUsd: 0.5, inputTokens: 100 })],
      judgement: judged(
        "better",
        agentRun({ costBasis: "api", costUsd: 2, inputTokens: 9000, outputTokens: 1000 }),
      ),
    }),
    trial({
      contender: "claude",
      patch: "patches/b.patch",
      judgement: judged(
        "wrong",
        agentRun({ costBasis: "subscription-estimate", costUsd: 3, inputTokens: 5 }),
      ),
    }),
    trial({ contender: "claude", patch: "patches/c.patch", judgement: judged(null) }),
    trial({ contender: "codex", change: "none", patch: null }),
    trial({ contender: "codex", patch: "patches/d.patch", judgement: judged("equivalent") }),
  ];

  const report = buildBenchReport({
    runConfig: { ...RUN_CONFIG, judge: JUDGE },
    trials: JUDGED,
    finishedAt: new Date("2026-11-25T12:10:00.000Z"),
    interrupted: false,
  });

  test("counts verdicts per contender over the trials with commits", () => {
    const [claude, codex] = report.contenders;
    expect(claude!.verdicts).toEqual({ better: 1, equivalent: 0, worse: 0, wrong: 1, unjudged: 1 });
    expect(codex!.verdicts).toEqual({ better: 0, equivalent: 1, worse: 0, wrong: 0, unjudged: 0 });
  });

  test("keeps the judge's usage and cost out of every contender's columns", () => {
    const [claude] = report.contenders;
    expect(claude!.apiCostUsd).toBe(0.5);
    expect(claude!.subscriptionEstimateUsd).toBeNull();
    expect(claude!.medianTokens).toBe(100);
    expect(report.judge).toEqual({
      provider: "claude",
      model: "judge-model",
      runs: 4,
      tokens: 10_005,
      apiCostUsd: 2,
      subscriptionEstimateUsd: 3,
    });
  });

  test("renders a column per verdict and a line for the judge", () => {
    const table = renderBenchReport(report);
    const lines = table.split("\n");
    const header = lines.find((line) => line.startsWith("contender"))!;
    expect(header.split(/\s{2,}/)).toEqual([
      "contender",
      "trials",
      "no change",
      "check",
      "test",
      "better",
      "equivalent",
      "worse",
      "wrong",
      "median time",
      "median tokens",
      "API cost",
      "subscription est.",
    ]);
    const row = (name: string): string[] =>
      lines
        .find((line) => line.startsWith(`${name} `))!
        .trim()
        .split(/\s{2,}/);
    expect(row("claude").slice(5, 9)).toEqual(["1", "0", "0", "1"]);
    expect(row("claude").slice(11)).toEqual(["$0.50", NONE]);
    expect(row("codex").slice(5, 9)).toEqual(["0", "1", "0", "0"]);
    expect(table).toContain(
      "Judge: claude judge-model, 4 run(s), 10.0k tokens, API cost $2.00, subscription est. $3.00, " +
        "not in any contender's columns. 1 trial(s) with commits got no verdict.",
    );
  });

  test("without a judge there are no verdicts and no verdict column", () => {
    const plain = buildBenchReport({
      runConfig: RUN_CONFIG,
      trials: JUDGED,
      finishedAt: new Date("2026-11-25T12:10:00.000Z"),
      interrupted: false,
    });
    expect(plain.judge).toBeNull();
    expect(plain.contenders.map((row) => row.verdicts)).toEqual([null, null]);
    const table = renderBenchReport(plain);
    expect(table).not.toMatch(/better|equivalent|Judge:/);
  });

  test("verdictCounts skips trials with no commits", () => {
    expect(verdictCounts([trial({ contender: "x", patch: null })])).toEqual({
      better: 0,
      equivalent: 0,
      worse: 0,
      wrong: 0,
      unjudged: 0,
    });
  });
});

describe("pieces", () => {
  test("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  test("trialTokens leaves reasoning out and reads no report as none", () => {
    expect(trialTokens([])).toBeNull();
    expect(trialTokens([agentRun({})])).toBeNull();
    expect(
      trialTokens([
        agentRun({ inputTokens: 1, reasoningTokens: 99 }),
        agentRun({ outputTokens: 2 }),
      ]),
    ).toBe(3);
  });

  test("formats", () => {
    expect(formatDuration(null)).toBe(NONE);
    expect(formatDuration(38_400)).toBe("38s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(35_200)).toBe("35.2k");
    expect(formatTokens(1_240_000)).toBe("1.24M");
  });

  test("readBenchReport reads a saved run and names the saved ones when asked for another", () => {
    const root = mkdtempSync(join(tmpdir(), "phoebe-bench-report-"));
    try {
      const report = buildBenchReport({
        runConfig: RUN_CONFIG,
        trials: TRIALS,
        finishedAt: new Date("2026-11-25T12:10:00.000Z"),
        interrupted: false,
      });
      mkdirSync(join(root, RUN_CONFIG.runId));
      writeFileSync(join(root, RUN_CONFIG.runId, REPORT_FILE), JSON.stringify(report));
      mkdirSync(join(root, "2026-11-24T00-00-00-000Z"));
      expect(readBenchReport(root, RUN_CONFIG.runId)).toEqual(report);
      expect(() => readBenchReport(root, "../etc")).toThrow(
        `Saved runs, newest last: ${RUN_CONFIG.runId}.`,
      );
      expect(() => readBenchReport(join(root, "none"), "x")).toThrow(/no saved runs/);
      // A report saved before the judge existed reads as one without a judge.
      const { judge: _judge, ...older } = report;
      writeFileSync(
        join(root, RUN_CONFIG.runId, REPORT_FILE),
        JSON.stringify({
          ...older,
          contenders: older.contenders.map(({ verdicts: _verdicts, ...row }) => row),
        }),
      );
      expect(readBenchReport(root, RUN_CONFIG.runId)).toEqual(report);
      writeFileSync(join(root, RUN_CONFIG.runId, REPORT_FILE), JSON.stringify({ v: 1 }));
      expect(() => readBenchReport(root, RUN_CONFIG.runId)).toThrow(/not a bench report/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
