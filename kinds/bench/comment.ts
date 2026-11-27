// What the bench kind posts on a PR (#989): one new comment per bench, naming
// the head and the run, with `main` and `pr` side by side. A comment only:
// about ten fixtures run once each move on noise, so nothing here fails a
// check, and the reviewer decides. Pure, so every line is tested without git.

import { posix } from "node:path";
import { formatTokens, formatUsd, median, NONE, unstableLine } from "../../src/bench-report.ts";
import { BENCH_VERDICTS, type BenchTrial } from "../../src/contracts/bench.ts";
import type { BenchReport, BenchReportRow } from "../../src/contracts/bench-report.ts";
import type { AgentRunRecord } from "../../src/contracts/unit-record.ts";
import type { IssuesSettings, Side } from "./sides.ts";

/** The names the two contenders run under, in the report and the comment. */
export const MAIN_CONTENDER = "main";
export const PR_CONTENDER = "pr";

/** The hidden line every bench comment opens with. */
export function benchMarker(runId: string, headSha: string): string {
  return `<!-- phoebe-bench run=${runId} head=${headSha} -->`;
}

/** One argument, quoted for a POSIX shell when it needs it. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command a deployment with no suite at `suite` is told to run. */
export function selectCommand(suite: string): string {
  const dir = posix.dirname(suite);
  const target = shellQuote(suite);
  return dir === "."
    ? `phoebe bench select > ${target}`
    : `mkdir -p ${shellQuote(dir)} && phoebe bench select > ${target}`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

/** A total across runs, kept apart by what the provider reported it as. */
type Cost = { api: number | null; estimate: number | null };

function addRun(cost: Cost, run: AgentRunRecord): Cost {
  if (run.costUsd === null) return cost;
  if (run.costBasis === "api") return { ...cost, api: (cost.api ?? 0) + run.costUsd };
  if (run.costBasis === "subscription-estimate") {
    return { ...cost, estimate: (cost.estimate ?? 0) + run.costUsd };
  }
  return cost;
}

const NO_COST: Cost = { api: null, estimate: null };

/** `$0.41`, `$0.41 est.`, or `$0.41 + $0.10 est.` when a bench used both. */
function formatCost(cost: Cost): string {
  if (cost.api === null && cost.estimate === null) return NONE;
  if (cost.estimate === null) return formatUsd(cost.api);
  if (cost.api === null) return `${formatUsd(cost.estimate)} est.`;
  return `${formatUsd(cost.api)} + ${formatUsd(cost.estimate)} est.`;
}

/**
 * The median cost of one trial for a contender. A trial costs what its agent
 * runs reported, API and subscription estimate together, since one provider
 * reports one of the two; `est.` marks a median that includes an estimate.
 */
export function medianTrialCost(trials: readonly BenchTrial[]): string {
  const costs = trials.map((trial) => trial.agentRuns.reduce(addRun, NO_COST));
  const totals = costs.flatMap((cost) =>
    cost.api === null && cost.estimate === null ? [] : [(cost.api ?? 0) + (cost.estimate ?? 0)],
  );
  const value = median(totals);
  if (value === null) return NONE;
  return costs.some((cost) => cost.estimate !== null)
    ? `${formatUsd(value)} est.`
    : formatUsd(value);
}

/** What the bench spent: every trial's agent runs and every judge run. */
export function totalCost(trials: readonly BenchTrial[]): string {
  let cost = NO_COST;
  for (const trial of trials) {
    for (const run of trial.agentRuns) cost = addRun(cost, run);
    if (trial.judgement?.run) cost = addRun(cost, trial.judgement.run);
  }
  return formatCost(cost);
}

function rate(row: BenchReportRow): string {
  const test = row.test;
  if (test === null || test.rate === null) return NONE;
  return `${Math.round(test.rate * 100)}% (${test.passed}/${test.of})`;
}

function verdicts(row: BenchReportRow): string {
  if (row.verdicts === null) return NONE;
  const counts = row.verdicts;
  const parts = BENCH_VERDICTS.map((verdict) => `${counts[verdict]} ${verdict}`);
  if (counts.unjudged > 0) parts.push(`${counts.unjudged} unjudged`);
  return parts.join(", ");
}

function settingsCell(settings: IssuesSettings | null, row: BenchReportRow | undefined): string {
  const contender = row?.contender;
  const provider = settings?.provider ?? contender?.provider;
  const model = settings?.model ?? contender?.model;
  const effort = settings === null ? (contender?.effort ?? null) : settings.effort;
  if (provider === undefined || model === undefined) return NONE;
  return `${provider} \`${model}\`${effort === null ? "" : ` (${effort})`}`;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export type BenchCommentInput = {
  pr: { number: number; headSha: string };
  runId: string;
  report: BenchReport;
  trials: readonly BenchTrial[];
  sides: { main: Side; pr: Side };
  /** How many fixtures the suite holds, before `maxFixtures` trimmed it. */
  suiteSize: number;
  /** The PR's paths a bench does not measure (`AGENTS.md`, skills). */
  unmeasured: readonly string[];
};

/** The comment one bench posts. */
export function renderBenchComment(input: BenchCommentInput): string {
  const { report, sides } = input;
  const row = (name: string): BenchReportRow | undefined =>
    report.contenders.find((candidate) => candidate.contender.name === name);
  const main = row(MAIN_CONTENDER);
  const pr = row(PR_CONTENDER);
  const trialsOf = (name: string): BenchTrial[] =>
    input.trials.filter((trial) => trial.contender === name);
  const both = (render: (r: BenchReportRow) => string): [string, string] => [
    main === undefined ? NONE : render(main),
    pr === undefined ? NONE : render(pr),
  ];

  const fixtures = report.suite.fixtures.length;
  const rows: Array<[string, string, string]> = [
    ["Settings", settingsCell(sides.main.settings, main), settingsCell(sides.pr.settings, pr)],
    [
      "Prompt",
      `\`${sides.main.prompt.path}\``,
      sides.pr.prompt.text === sides.main.prompt.text
        ? "same as main"
        : `\`${sides.pr.prompt.path}\`, changed`,
    ],
    ["Trials", ...both((r) => String(r.trials))],
    ["Test pass rate", ...both(rate)],
    ["No change", ...both((r) => String(r.noChange))],
    ["Median tokens", ...both((r) => formatTokens(r.medianTokens))],
    [
      "Median cost",
      medianTrialCost(trialsOf(MAIN_CONTENDER)),
      medianTrialCost(trialsOf(PR_CONTENDER)),
    ],
  ];
  if (report.judge !== null) rows.push(["Judge verdicts", ...both(verdicts)]);

  const lines: string[] = [
    benchMarker(input.runId, input.pr.headSha),
    `### Bench: \`${MAIN_CONTENDER}\` against this PR`,
    "",
    `Head \`${short(input.pr.headSha)}\`, run \`${input.runId}\`, against \`${MAIN_CONTENDER}\` at ` +
      `\`${short(sides.main.sha)}\`. ${fixtures} fixture(s)` +
      `${fixtures < input.suiteSize ? ` (the newest ${fixtures} of ${input.suiteSize})` : ""}` +
      `, ${report.repeat} repeat(s) each.`,
    "",
    `| | \`${MAIN_CONTENDER}\` | \`${PR_CONTENDER}\` |`,
    "| --- | --- | --- |",
    ...rows.map(([label, left, right]) => `| ${label} | ${cell(left)} | ${cell(right)} |`),
    "",
  ];
  if (report.unstable.length > 0) lines.push(`${unstableLine(report.unstable)}.`, "");
  lines.push(
    `Total cost: ${totalCost(input.trials)}` +
      `${report.judge === null ? "" : `, the judge's ${report.judge.runs} run(s) included`}.`,
    "",
  );
  if (input.unmeasured.length > 0) {
    const listed = input.unmeasured.slice(0, 10).map((path) => `\`${path}\``);
    if (input.unmeasured.length > 10) listed.push(`and ${input.unmeasured.length - 10} more`);
    lines.push(
      `> This PR also changes ${listed.join(", ")}. Bench does not measure \`AGENTS.md\` or ` +
        "skills yet. Trials read them from each fixture's own tree, so these figures leave " +
        "that change out.",
      "",
    );
  }
  lines.push(
    "On a suite this small, a gap of one or two fixtures can be chance. This comment sets " +
      "no check status. Add the `phoebe:bench` label again to run another bench.",
  );
  return `${lines.join("\n")}\n`;
}

/** The comment a deployment with no suite posts, running nothing. */
export function renderNoSuiteComment(suite: string): string {
  return [
    "<!-- phoebe-bench no-suite -->",
    `Bench did not run. This deployment has no suite at \`${suite}\`. Pin one in the ` +
      "deployment directory, then add the `phoebe:bench` label again:",
    "",
    "```sh",
    selectCommand(suite),
    "```",
    "",
  ].join("\n");
}

/** The comment a suite that will not read posts, running nothing. */
export function renderBadSuiteComment(suite: string, error: string): string {
  return [
    "<!-- phoebe-bench bad-suite -->",
    `Bench did not run. The suite at \`${suite}\` could not be read. Fix it or pin a new one ` +
      `with \`${selectCommand(suite)}\`, then add the \`phoebe:bench\` label again.`,
    "",
    "```text",
    error,
    "```",
    "",
  ].join("\n");
}

/** The comment a PR that changes nothing bench measures posts, running nothing. */
export function renderNothingToMeasureComment(
  headSha: string,
  unmeasured: readonly string[],
): string {
  const lines = [
    `<!-- phoebe-bench nothing-to-measure head=${headSha} -->`,
    `Bench did not run on \`${short(headSha)}\`. This PR's \`issues\` prompt, provider, model ` +
      `and effort are the same as \`${MAIN_CONTENDER}\`'s, so there is nothing to measure.`,
  ];
  if (unmeasured.length > 0) {
    lines.push(
      "",
      `It changes ${unmeasured
        .slice(0, 10)
        .map((path) => `\`${path}\``)
        .join(", ")}, which bench does not measure yet.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
