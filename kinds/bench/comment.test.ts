import { describe, expect, test } from "vite-plus/test";
import type { BenchTrial } from "../../src/contracts/bench.ts";
import type { BenchReport } from "../../src/contracts/bench-report.ts";
import type { AgentRunRecord } from "../../src/contracts/unit-record.ts";
import { medianTrialCost, renderBenchComment, totalCost } from "./comment.ts";
import type { Side } from "./sides.ts";

function run(costUsd: number | null, costBasis: AgentRunRecord["costBasis"]): AgentRunRecord {
  return { costUsd, costBasis } as AgentRunRecord;
}

function trial(contender: string, runs: AgentRunRecord[]): BenchTrial {
  return { contender, agentRuns: runs, judgement: null } as unknown as BenchTrial;
}

describe("costs", () => {
  test("a median over trials that reported a cost, marked when it includes an estimate", () => {
    expect(medianTrialCost([trial("a", [run(1, "api")]), trial("a", [run(3, "api")])])).toBe(
      "$2.00",
    );
    expect(medianTrialCost([trial("a", [run(1, "subscription-estimate")])])).toBe("$1.00 est.");
    expect(medianTrialCost([trial("a", [run(null, null)])])).toBe("—");
  });

  test("the total keeps API spend and subscription estimates apart", () => {
    expect(
      totalCost([trial("a", [run(1, "api")]), trial("b", [run(0.5, "subscription-estimate")])]),
    ).toBe("$1.00 + $0.50 est.");
  });
});

const SIDE: Side = {
  sha: "f".repeat(40),
  settings: null,
  prompt: { text: "p", path: "prompts/issues-prompt.md", fromTree: true },
};

describe("renderBenchComment", () => {
  test("lists unstable fixtures and works with no settings read", () => {
    const report = {
      runId: "r",
      repeat: 1,
      judge: null,
      suite: { path: "s", selectedAt: "x", fixtures: [1, 2] },
      unstable: [{ issue: 2, pr: 20, gate: "test", exitCode: 1, baselinePassedAt: null }],
      contenders: [],
    } as unknown as BenchReport;
    const body = renderBenchComment({
      pr: { number: 5, headSha: "e".repeat(40) },
      runId: "r",
      report,
      trials: [],
      sides: { main: SIDE, pr: { ...SIDE, prompt: { ...SIDE.prompt, text: "q" } } },
      suiteSize: 2,
      unmeasured: [],
    });
    expect(body).toContain("1 fixture(s) unstable, not scored: #2 (test exited 1).");
    expect(body).toContain("| Settings | — | — |");
    expect(body).toContain("Total cost: —.");
    expect(body).not.toContain("Bench does not measure");
  });
});
