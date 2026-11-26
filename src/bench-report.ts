// The bench report (#941; spec #925, decisions #921): trials in, one row per
// contender out, as JSON (`BenchReport`, src/contracts/bench-report.ts) and as
// the terminal table `bench run` and `bench report <runId>` print.
//
// `buildBenchReport` and `renderBenchReport` are pure, so the numbers and the
// table are tested without running a trial. Reading a saved report is the only
// thing here that touches the disk.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchContender, BenchRunConfig, BenchTrial } from "./contracts/bench.ts";
import type { BenchGateRate, BenchReport, BenchReportRow } from "./contracts/bench-report.ts";
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
  commands: Pick<BenchRunConfig, "checkCommand" | "testCommand">,
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
    check: gateRate(mine, commands.checkCommand, "check"),
    test: gateRate(mine, commands.testCommand, "test"),
    medianDurationMs: median(mine.flatMap((trial) => trial.durationMs ?? [])),
    medianTokens: median(mine.flatMap((trial) => trialTokens(trial.agentRuns) ?? [])),
    apiCostUsd: costOn(mine, "api"),
    subscriptionEstimateUsd: costOn(mine, "subscription-estimate"),
  };
}

/** The report for a run: its config, the trials it recorded, and how it ended. */
export function buildBenchReport(opts: {
  runConfig: BenchRunConfig;
  trials: readonly BenchTrial[];
  finishedAt: Date;
  interrupted: boolean;
}): BenchReport {
  const { runConfig, trials } = opts;
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
    planned: runConfig.suite.fixtures.length * runConfig.contenders.length * runConfig.repeat,
    recorded: trials.length,
    outcomes: {
      completed: count("completed"),
      failed: count("failed"),
      timedOut: count("timed-out"),
      noChange: trials.filter((trial) => trial.outcome === "completed" && trial.change === "none")
        .length,
    },
    contenders: runConfig.contenders.map((contender) => contenderRow(contender, trials, runConfig)),
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

const HEADERS = [
  "contender",
  "trials",
  "no change",
  "check",
  "test",
  "median time",
  "median tokens",
  "API cost",
  "subscription est.",
] as const;

/** The report as the terminal shows it: a heading, one row per contender, and each contender's settings. */
export function renderBenchReport(report: BenchReport): string {
  const rows = report.contenders.map((row) => [
    row.contender.name,
    String(row.trials),
    String(row.noChange),
    percent(row.check),
    percent(row.test),
    formatDuration(row.medianDurationMs),
    formatTokens(row.medianTokens),
    formatUsd(row.apiCostUsd),
    formatUsd(row.subscriptionEstimateUsd),
  ]);
  const widths = HEADERS.map((header, i) =>
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
    line(HEADERS),
    ...rows.map(line),
    "",
    ...report.contenders.map(
      (row) => `${row.contender.name.padEnd(widths[0]!)}  ${settingsOf(row.contender)}`,
    ),
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
  return r as BenchReport;
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
