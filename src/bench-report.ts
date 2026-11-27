// The bench report (#941; spec #925, decisions #921): trials in, one row per
// contender out, as JSON (`BenchReport`, src/contracts/bench-report.ts) and as
// the terminal table `bench run` and `bench report <runId>` print.
//
// `buildBenchReport` and `renderBenchReport` are pure, so the numbers and the
// table are tested without running a trial. Reading a saved report is the only
// thing here that touches the disk.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BENCH_VERDICTS,
  type BenchContender,
  type BenchGates,
  type BenchRunConfig,
  type BenchTrial,
} from "./contracts/bench.ts";
import type {
  BenchBaselineFailure,
  BenchGateRate,
  BenchJudgeUsage,
  BenchReport,
  BenchReportRow,
  BenchUnstableFixture,
  BenchVerdictCounts,
} from "./contracts/bench-report.ts";
import type { AgentRunRecord } from "./contracts/unit-record.ts";

/** The file a run's report is saved as, in its run directory. */
export const REPORT_FILE = "report.json";

/** The middle value, or the mean of the middle two; `null` for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * A trial's tokens: input, output and cache tokens across its agent runs.
 * Reasoning tokens are left out, since some providers count them inside output
 * already. `null` when no run reported any of them.
 */
export function trialTokens(runs: readonly AgentRunRecord[]): number | null {
  let total: number | null = null;
  for (const run of runs) {
    for (const value of [
      run.inputTokens,
      run.outputTokens,
      run.cacheReadTokens,
      run.cacheWriteTokens,
    ]) {
      if (value !== null) total = (total ?? 0) + value;
    }
  }
  return total;
}

function costOn(trials: readonly BenchTrial[], basis: AgentRunRecord["costBasis"]): number | null {
  let total: number | null = null;
  for (const trial of trials) {
    for (const run of trial.agentRuns) {
      if (run.costBasis === basis && run.costUsd !== null) total = (total ?? 0) + run.costUsd;
    }
  }
  return total;
}

/**
 * How a contender's trials with commits were judged. A trial with commits the
 * judge gave no verdict on is `unjudged`; a trial with none was never judged
 * and is not counted.
 */
export function verdictCounts(trials: readonly BenchTrial[]): BenchVerdictCounts {
  const counts: BenchVerdictCounts = { better: 0, equivalent: 0, worse: 0, wrong: 0, unjudged: 0 };
  for (const trial of trials) {
    if (trial.patch === null) continue;
    const verdict = trial.judgement?.verdict ?? null;
    if (verdict === null) counts.unjudged += 1;
    else counts[verdict] += 1;
  }
  return counts;
}

/** What the judge spent across the run, apart from every contender. */
export function judgeUsage(
  judge: NonNullable<BenchRunConfig["judge"]>,
  trials: readonly BenchTrial[],
): BenchJudgeUsage {
  const runs = trials.flatMap((trial) => (trial.judgement?.run ? [trial.judgement.run] : []));
  const cost = (basis: AgentRunRecord["costBasis"]): number | null =>
    runs.reduce<number | null>(
      (total, run) =>
        run.costBasis === basis && run.costUsd !== null ? (total ?? 0) + run.costUsd : total,
      null,
    );
  return {
    provider: judge.provider,
    model: judge.model,
    runs: runs.length,
    tokens: trialTokens(runs),
    apiCostUsd: cost("api"),
    subscriptionEstimateUsd: cost("subscription-estimate"),
  };
}

function gateRate(
  trials: readonly BenchTrial[],
  command: string,
  gate: "check" | "test",
): BenchGateRate | null {
  if (command.trim() === "") return null;
  const passed = trials.filter((trial) => trial.gates[gate]?.exitCode === 0).length;
  return { passed, of: trials.length, rate: trials.length === 0 ? null : passed / trials.length };
}

/** One contender's row. */
export function contenderRow(
  contender: BenchContender,
  trials: readonly BenchTrial[],
  run: Pick<BenchRunConfig, "checkCommand" | "testCommand" | "judge">,
): BenchReportRow {
  const mine = trials.filter((trial) => trial.contender === contender.name);
  const count = (outcome: BenchTrial["outcome"]): number =>
    mine.filter((trial) => trial.outcome === outcome).length;
  return {
    contender,
    trials: mine.length,
    outcomes: {
      completed: count("completed"),
      failed: count("failed"),
      timedOut: count("timed-out"),
    },
    noChange: mine.filter((trial) => trial.outcome === "completed" && trial.change === "none")
      .length,
    check: gateRate(mine, run.checkCommand, "check"),
    test: gateRate(mine, run.testCommand, "test"),
    medianDurationMs: median(mine.flatMap((trial) => trial.durationMs ?? [])),
    medianTokens: median(mine.flatMap((trial) => trialTokens(trial.agentRuns) ?? [])),
    apiCostUsd: costOn(mine, "api"),
    subscriptionEstimateUsd: costOn(mine, "subscription-estimate"),
    verdicts: run.judge === null ? null : verdictCounts(mine),
  };
}

/**
 * The report for a run: its config, its fixtures' baselines, the trials it
 * recorded, and how it ended. An unstable fixture's trials never ran, so it is
 * in no rate; `planned` leaves it out too.
 */
export function buildBenchReport(opts: {
  runConfig: BenchRunConfig;
  trials: readonly BenchTrial[];
  baselines: Record<string, BenchGates>;
  unstable: readonly BenchUnstableFixture[];
  finishedAt: Date;
  interrupted: boolean;
}): BenchReport {
  const { runConfig, trials } = opts;
  const stableFixtures = runConfig.suite.fixtures.length - opts.unstable.length;
  const count = (outcome: BenchTrial["outcome"]): number =>
    trials.filter((trial) => trial.outcome === outcome).length;
  return {
    v: 1,
    runId: runConfig.runId,
    repo: runConfig.repo,
    startedAt: runConfig.startedAt,
    finishedAt: opts.finishedAt.toISOString(),
    interrupted: opts.interrupted,
    suite: runConfig.suite,
    benchConfig: runConfig.benchConfig,
    repeat: runConfig.repeat,
    concurrency: runConfig.concurrency,
    baselines: opts.baselines,
    unstable: [...opts.unstable],
    planned: stableFixtures * runConfig.contenders.length * runConfig.repeat,
    recorded: trials.length,
    outcomes: {
      completed: count("completed"),
      failed: count("failed"),
      timedOut: count("timed-out"),
      noChange: trials.filter((trial) => trial.outcome === "completed" && trial.change === "none")
        .length,
    },
    contenders: runConfig.contenders.map((contender) => contenderRow(contender, trials, runConfig)),
    judge: runConfig.judge === null ? null : judgeUsage(runConfig.judge, trials),
  };
}

// --- the table --------------------------------------------------------------

/** What a cell shows when there is no figure. */
export const NONE = "—";

function percent(rate: BenchGateRate | null): string {
  if (rate === null || rate.rate === null) return NONE;
  return `${Math.round(rate.rate * 100)}%`;
}

/** `4m 12s`, `38s`, `1h 03m`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return NONE;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `950`, `35.2k`, `1.24M`. */
export function formatTokens(tokens: number | null): string {
  if (tokens === null) return NONE;
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(usd: number | null): string {
  return usd === null ? NONE : `$${usd.toFixed(2)}`;
}

function settingsOf(contender: BenchContender): string {
  return [contender.provider, contender.model, contender.effort ?? "", contender.promptFile]
    .filter((part) => part !== "")
    .join(" · ");
}

const GATE_HEADERS = ["contender", "trials", "no change", "check", "test"] as const;
const VERDICT_HEADERS = BENCH_VERDICTS;
const USAGE_HEADERS = ["median time", "median tokens", "API cost", "subscription est."] as const;

function judgeLine(judge: BenchJudgeUsage, unjudged: number): string {
  const tokens = judge.tokens === null ? "" : `, ${formatTokens(judge.tokens)} tokens`;
  const costs = [
    ...(judge.apiCostUsd === null ? [] : [`API cost ${formatUsd(judge.apiCostUsd)}`]),
    ...(judge.subscriptionEstimateUsd === null
      ? []
      : [`subscription est. ${formatUsd(judge.subscriptionEstimateUsd)}`]),
  ];
  return (
    `Judge: ${judge.provider} ${judge.model}, ${judge.runs} run(s)${tokens}` +
    `${costs.length === 0 ? "" : `, ${costs.join(", ")}`}, not in any contender's columns.` +
    (unjudged === 0 ? "" : ` ${unjudged} trial(s) with commits got no verdict.`)
  );
}

// --- baselines (#988) -------------------------------------------------------

/** The first gate a baseline failed, or `null` when every gate it ran passed. */
export function baselineFailure(gates: BenchGates): BenchBaselineFailure | null {
  for (const gate of ["install", "check", "test"] as const) {
    const result = gates[gate];
    if (result !== null && result.exitCode !== 0) return { gate, exitCode: result.exitCode };
  }
  return null;
}

/** `test exited 1`, `install exited without a code`, `checkout failed`. */
export function describeBaselineFailure(failure: BenchBaselineFailure): string {
  if (failure.gate === "checkout") return "checkout failed";
  return `${failure.gate} exited ${failure.exitCode ?? "without a code"}`;
}

/** What `bench run` says, exiting 1, when it had no stable fixture to run. */
export const NO_STABLE_FIXTURE = "no stable fixture: nothing to compare";

/** Every fixture in the suite failed its baseline, so no trial ran. */
export function everyFixtureUnstable(report: BenchReport): boolean {
  return (
    report.suite.fixtures.length > 0 && report.unstable.length === report.suite.fixtures.length
  );
}

/** `2 fixture(s) unstable, not scored: #412 (test exited 1), #430 (install exited 1)`. */
export function unstableLine(unstable: readonly BenchUnstableFixture[]): string {
  return (
    `${unstable.length} fixture(s) unstable, not scored: ` +
    unstable.map((entry) => `#${entry.issue} (${describeBaselineFailure(entry)})`).join(", ")
  );
}

/**
 * The report as the terminal shows it: a heading, one row per contender, and
 * each contender's settings. With a judge, a column per verdict after the
 * gates, and a line for what the judge spent.
 */
export function renderBenchReport(report: BenchReport): string {
  const judge = report.judge ?? null;
  const headers: readonly string[] = [
    ...GATE_HEADERS,
    ...(judge === null ? [] : VERDICT_HEADERS),
    ...USAGE_HEADERS,
  ];
  const rows = report.contenders.map((row) => [
    row.contender.name,
    String(row.trials),
    String(row.noChange),
    percent(row.check),
    percent(row.test),
    ...(judge === null
      ? []
      : VERDICT_HEADERS.map((verdict) => (row.verdicts ? String(row.verdicts[verdict]) : NONE))),
    formatDuration(row.medianDurationMs),
    formatTokens(row.medianTokens),
    formatUsd(row.apiCostUsd),
    formatUsd(row.subscriptionEstimateUsd),
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]!.length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();

  const { outcomes } = report;
  const out = [
    `Bench run ${report.runId} on ${report.repo}${report.interrupted ? " (interrupted)" : ""}`,
    `${report.suite.fixtures.length} fixture(s) × ${report.contenders.length} contender(s) × ` +
      `${report.repeat} repeat(s): ${report.recorded}/${report.planned} trial(s) recorded, ` +
      `${outcomes.failed} failed, ${outcomes.timedOut} timed out.`,
    "",
    line(headers),
    ...rows.map(line),
    ...(judge === null
      ? []
      : [
          "",
          judgeLine(
            judge,
            report.contenders.reduce((sum, row) => sum + (row.verdicts?.unjudged ?? 0), 0),
          ),
        ]),
    "",
    ...report.contenders.map(
      (row) => `${row.contender.name.padEnd(widths[0]!)}  ${settingsOf(row.contender)}`,
    ),
    ...(report.unstable.length === 0 ? [] : ["", unstableLine(report.unstable)]),
  ];
  return `${out.join("\n")}\n`;
}

// --- reading a saved report -------------------------------------------------

/** Read a report file, refusing one this engine would misread. */
export function parseBenchReport(text: string, where: string): BenchReport {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${where} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const r = report as Partial<BenchReport> | null;
  if (r === null || typeof r !== "object" || r.v !== 1 || !Array.isArray(r.contenders)) {
    throw new Error(`${where} is not a bench report this engine reads (expected \`v: 1\`).`);
  }
  // A report saved before the judge (#942) has neither field; it had no judge.
  // One saved before baselines (#988) ran none and had no unstable fixture.
  return {
    ...(r as BenchReport),
    baselines: r.baselines ?? {},
    unstable: r.unstable ?? [],
    judge: r.judge ?? null,
    contenders: r.contenders.map((row) => ({ ...row, verdicts: row.verdicts ?? null })),
  };
}

/** A run id names a directory under the bench root, and nothing outside it. */
function isRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) && runId !== "." && runId !== "..";
}

/** The run ids under the bench root, oldest first. */
export function listRuns(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Read `<root>/<runId>/report.json`, naming the runs there are when it is not one of them. */
export function readBenchReport(root: string, runId: string): BenchReport {
  const runs = listRuns(root);
  const path = join(root, runId, REPORT_FILE);
  if (!isRunId(runId) || !existsSync(path)) {
    const known = runs.filter((run) => existsSync(join(root, run, REPORT_FILE)));
    throw new Error(
      `No bench report for run \`${runId}\`. ` +
        (known.length === 0
          ? "This tenant has no saved runs."
          : `Saved runs, newest last: ${known.join(", ")}.`),
    );
  }
  return parseBenchReport(readFileSync(path, "utf8"), path);
}
