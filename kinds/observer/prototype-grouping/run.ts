// PROTOTYPE (#980), throwaway. Run the observer's real flagging over a unit
// history, run each grouping-prompt variant once with the `claude` CLI in a
// read-only checkout, then score the findings and write report/index.html.
//
//   node kinds/observer/prototype-grouping/run.ts                 # fixture, all variants
//   node kinds/observer/prototype-grouping/run.ts --units dump.jsonl [--pipeline work]
//   node kinds/observer/prototype-grouping/run.ts --flag-only     # stop after flagging
//   node kinds/observer/prototype-grouping/run.ts --reuse         # rescore saved runs, no agent
//
// See README.md for every flag.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UnitRecord } from "../../../src/contracts/unit-record.ts";
import { resolveConfig } from "../../../src/config-schema.ts";
import { createGitHubClient, type GitHubClient } from "../../../src/github-client.ts";
import { buildDefaultPromptArgs, renderPrompt } from "../../../src/prompt.ts";
import { config as repoUserConfig } from "../../../.phoebe/phoebe.config.ts";
import { everyMs } from "../options.ts";
import {
  coverageOf,
  flagUnits,
  renderCoverage,
  unitsSince,
  type FlaggedUnit,
  type PipelineHistory,
} from "../evidence.ts";
import { FINDINGS_FILE, parseFindings, type Finding } from "../findings.ts";
import {
  gatherPrOutcomes,
  identityOf,
  isProposalUnit,
  parseRevertLog,
} from "../pr-outcomes.ts";
import {
  decideFinding,
  MARKER_TEXT,
  parseFindingMarker,
  type FindingDecision,
  type Proposal,
} from "../proposals.ts";
import { argValue, cached, firstParagraph, hasFlag, oneLine, PROTO_DIR, REPO_ROOT } from "./lib.ts";

const CLAUDE = process.env["CLAUDE_BIN"] ?? "/home/q/.local/bin/claude";
const CHECKOUT = "/tmp/observer-proto-checkout";
const SCRATCH_ROOT = "/tmp/observer-proto-scratch";
const REPORT_DIR = join(PROTO_DIR, "report");
const RUNS_DIR = join(REPORT_DIR, "runs");
const FLAGGED_CAP = 150;

// The model the observer runs on when nothing names one: `defaultModels.claude`
// in src/config-schema.ts, with no effort flag (`defaultEfforts` is empty).
const MODEL = argValue("--model") ?? "claude-sonnet-5-5";
const EFFORT = argValue("--effort");
const LOOKBACK = argValue("--lookback") ?? `${argValue("--days") ?? 30}d`;
const VARIANTS = (argValue("--variants") ?? "A,B,C").split(",").filter(Boolean);
const UNITS_PATH = argValue("--units") ?? join(PROTO_DIR, "fixture", "units.jsonl");
const PIPELINE_OVERRIDE = argValue("--pipeline");
const NOW = argValue("--now") === undefined ? new Date() : new Date(argValue("--now")!);
const REUSE = hasFlag("--reuse");
const FLAG_ONLY = hasFlag("--flag-only");

const config = resolveConfig(repoUserConfig);

// --- GitHub, with every read the gather makes cached on disk ------------------

// The shipped executor (createGhExecutor) leaves execFileSync's 1 MiB
// maxBuffer in place, and `branchWorkflowRuns` on a branch with ~90 Actions
// runs returns more than that: the real gather dies with ENOBUFS on this repo.
// The prototype swaps in the same call with a bigger buffer through the
// client's own seam, and says so in the report.
const live = createGitHubClient({
  config,
  env: process.env,
  internal: {
    exec: (args, opts) =>
      execFileSync("gh", [...args], {
        env: process.env,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        ...(opts?.input !== undefined ? { input: opts.input } : {}),
      }),
  },
});
const github = {
  branchPrs: (branches: readonly string[]) =>
    new Map(
      cached("branchPrs", [...branches].sort(), () => [...live.branchPrs(branches)]),
    ),
  observedPrs: (numbers: readonly number[]) =>
    cached("observedPrs", [...numbers].sort((a, b) => a - b), () => live.observedPrs(numbers)),
  revertPrs: (since: string) => cached("revertPrs", since, () => live.revertPrs(since)),
  branchWorkflowRuns: (branch: string) =>
    cached("branchWorkflowRuns", branch, () => live.branchWorkflowRuns(branch)),
  listIssuesMentioning: (text: string) =>
    cached("listIssuesMentioning", text, () => live.listIssuesMentioning(text)),
  listPrsMentioning: (text: string) =>
    cached("listPrsMentioning", text, () => live.listPrsMentioning(text)),
} as unknown as GitHubClient;

// --- Unit history -------------------------------------------------------------

function readHistories(path: string): PipelineHistory[] {
  const byPipeline = new Map<string, UnitRecord[]>();
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    let record: UnitRecord;
    try {
      record = JSON.parse(line) as UnitRecord;
    } catch {
      continue;
    }
    if (record.v !== 1) continue;
    const pipeline = PIPELINE_OVERRIDE ?? record.pipeline;
    if (!pipeline) throw new Error(`${path}: a record has no pipeline; pass --pipeline <name>.`);
    if (pipeline === "observe") continue; // the observer never reads its own pipeline
    const list = byPipeline.get(pipeline) ?? [];
    list.push(record);
    byPipeline.set(pipeline, list);
  }
  return [...byPipeline].map(([pipeline, records]) => ({ pipeline, records }));
}

/** Copied from index.ts `proposalsOf`. */
function proposalsFromGitHub(): Proposal[] {
  const proposals: Proposal[] = [];
  for (const hit of github.listIssuesMentioning(MARKER_TEXT)) {
    const key = parseFindingMarker(hit.body);
    if (key === null) continue;
    proposals.push({
      number: hit.number,
      pr: false,
      key,
      body: hit.body,
      state: hit.state,
      stateReason: hit.stateReason,
      closedAt: hit.closedAt,
    });
  }
  for (const hit of github.listPrsMentioning(MARKER_TEXT)) {
    const key = parseFindingMarker(hit.body);
    if (key === null) continue;
    proposals.push({
      number: hit.number,
      pr: true,
      key,
      body: hit.body,
      state: hit.state,
      stateReason: hit.state === "open" ? null : hit.merged ? "completed" : "not_planned",
      closedAt: hit.closedAt,
    });
  }
  return proposals;
}

/** index.ts `revertCommitsSince`, against origin/main of this repo. */
function revertCommitsSince(since: Date) {
  try {
    const output = execFileSync(
      "git",
      [
        "-C",
        REPO_ROOT,
        "log",
        `origin/${config.defaultBranch}`,
        `--since=${since.toISOString()}`,
        "--grep=This reverts commit",
        "--format=%H%x1f%B%x1e",
      ],
      { encoding: "utf8" },
    );
    return parseRevertLog(output);
  } catch {
    return [];
  }
}

/** Phoebe's git identity, read off one of its PR commits (its name is "Phoebe" here). */
function phoebeIdentity(units: ReturnType<typeof unitsSince>): string | null {
  const explicit = argValue("--phoebe-identity");
  if (explicit !== undefined) return explicit;
  const pr = units.find((unit) => unit.record.prNumber !== null)?.record.prNumber;
  const numbers = [
    ...new Set(units.flatMap((unit) => (unit.record.prNumber === null ? [] : [unit.record.prNumber]))),
  ].slice(0, 20);
  if (pr === undefined) return null;
  for (const observed of github.observedPrs(numbers)) {
    const commit = observed.commits.find((c) => c.authorName === "Phoebe");
    if (commit !== undefined) return identityOf(commit);
  }
  return null;
}

// --- The scratch files, exactly as index.ts writes them -----------------------

type FlaggedRow = ReturnType<typeof flaggedRows>[number];

/** Copied from index.ts `writeFlagged`. */
function flaggedRows(flagged: readonly FlaggedUnit[]) {
  return flagged.map((unit, index) => {
    const id = `u${index + 1}`;
    const { record } = unit;
    return {
      id,
      pipeline: unit.pipeline,
      kind: record.unit.kind,
      ref: record.unit.id,
      flags: unit.flags,
      startedAt: record.startedAt,
      settledAt: record.settledAt,
      detail: record.detail,
      provider: record.provider,
      model: record.model,
      prNumber: unit.pr?.number ?? record.prNumber,
      pr: unit.pr,
    };
  });
}

/** Copied from index.ts `writeProposals`. */
function proposalRows(proposals: readonly Proposal[]) {
  return proposals.map(({ number, pr, key, state, stateReason, closedAt }) => ({
    number,
    pr,
    key,
    state,
    stateReason,
    closedAt,
  }));
}

/** Variant C: the same rows plus each proposal's title and first paragraph. */
type RichProposal = Proposal & { title: string; fake?: boolean };
function richProposalRows(proposals: readonly RichProposal[]) {
  return proposals.map((proposal) => ({
    ...proposalRows([proposal])[0],
    title: proposal.title,
    problem: firstParagraph(proposal.body.split("## What keeps going wrong")[1] ?? proposal.body),
  }));
}

/** Two invented prior proposals for variant C, so the fold path is exercised. */
function fakeProposals(): RichProposal[] {
  const path = join(PROTO_DIR, "fake-proposals.json");
  return (JSON.parse(readFileSync(path, "utf8")) as RichProposal[]).map((p) => ({
    // Code's own view of a proposal never carries `title`; only variant C shows it.
    ...p,
    fake: true,
  }));
}

// --- The agent run --------------------------------------------------------------

type RunMeta = {
  variant: string;
  model: string;
  effort: string | null;
  exitCode: number | null;
  durationMs: number;
  costUsd: number | null;
  turns: number | null;
  usage: Record<string, unknown> | null;
  result: string | null;
  /** Tool calls the permission rules refused: a read-only run should have few. */
  denials: string[];
  error: string | null;
};

function ensureCheckout(): void {
  if (existsSync(CHECKOUT)) return;
  execFileSync(
    "git",
    ["-C", REPO_ROOT, "worktree", "add", "--detach", CHECKOUT, `origin/${config.defaultBranch}`],
    { stdio: "inherit" },
  );
}

function removeCheckout(): void {
  if (!existsSync(CHECKOUT)) return;
  try {
    execFileSync("git", ["-C", REPO_ROOT, "worktree", "remove", "--force", CHECKOUT], {
      stdio: "inherit",
    });
  } catch (error) {
    console.warn(`could not remove ${CHECKOUT}: ${String(error)}`);
  }
}

/**
 * The shell commands the grouping run may use. The shipped observer runs with
 * every permission skipped; the prototype keeps it to reads, and tells it so,
 * because a first attempt with no note had every run try one `python3` call,
 * get denied, and conclude it had no shell at all (report/runs/attempt-1-no-shell).
 */
const READ_ONLY_BASH = [
  "gh issue view",
  "gh issue list",
  "gh pr view",
  "gh pr diff",
  "gh pr list",
  "gh pr checks",
  "gh run view",
  "gh search issues",
  "gh search prs",
  "git log",
  "git show",
  "git diff",
  "git blame",
  "jq",
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "grep",
  "sort",
  "uniq",
];
const SANDBOX_NOTE =
  "Prototype harness note: this session's shell is limited to these read-only commands, each run " +
  "on its own (no `cd`, no `python3`, no writing redirects): " +
  READ_ONLY_BASH.map((command) => `\`${command}\``).join(", ") +
  ". `gh` reads GitHub normally. Use the Read, Grep and Glob tools for files, and the Write " +
  "tool for the findings file. A denied command means only that command is unavailable.";

function runClaude(variant: string, prompt: string, scratch: string): Promise<RunMeta> {
  const argv = [
    "--append-system-prompt",
    SANDBOX_NOTE,
    "--print",
    "--output-format",
    "json",
    "--model",
    MODEL,
    ...(EFFORT === undefined ? [] : ["--effort", EFFORT]),
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--tools",
    "Read,Grep,Glob,Bash,Write,Edit",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    ...READ_ONLY_BASH.map((command) => `Bash(${command}:*)`),
    `Write(/${scratch}/**)`,
    `Edit(/${scratch}/**)`,
    "--add-dir",
    scratch,
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, argv, { cwd: CHECKOUT, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.stdin.end(prompt);
    child.on("close", (code) => {
      writeFileSync(join(RUNS_DIR, `${variant}.claude.json`), out);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(out) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      resolve({
        variant,
        model: MODEL,
        effort: EFFORT ?? null,
        exitCode: code,
        durationMs: Date.now() - started,
        costUsd: typeof parsed?.["total_cost_usd"] === "number" ? (parsed["total_cost_usd"] as number) : null,
        turns: typeof parsed?.["num_turns"] === "number" ? (parsed["num_turns"] as number) : null,
        usage: (parsed?.["usage"] as Record<string, unknown> | undefined) ?? null,
        result: typeof parsed?.["result"] === "string" ? (parsed["result"] as string) : null,
        denials: Array.isArray(parsed?.["permission_denials"])
          ? (parsed["permission_denials"] as { tool_name: string; tool_input: unknown }[]).map(
              (d) => `${d.tool_name} ${oneLine(JSON.stringify(d.tool_input), 160)}`,
            )
          : [],
        error: code === 0 ? null : oneLine(err || out, 2000),
      });
    });
  });
}

// --- Minimum evidence and calibration ------------------------------------------

/** The thread a unit belongs to: a PR's units count as the issue it closes, when known. */
function threadOf(row: FlaggedRow, prToIssue: Map<number, string>): string {
  const prRef = /^pr:(\d+)$/.exec(row.ref);
  if (prRef !== null) return prToIssue.get(Number(prRef[1])) ?? row.ref;
  return row.ref;
}

/** Every issue or PR number a unit touches: its ref and its PR. */
function numbersOf(row: FlaggedRow): number[] {
  const numbers: number[] = [];
  const ref = /^(?:issue|pr):(\d+)$/.exec(row.ref);
  if (ref !== null) numbers.push(Number(ref[1]));
  if (row.prNumber !== null) numbers.push(row.prNumber);
  return [...new Set(numbers)];
}

const RULES = [
  { id: "M1", text: "≥2 units", test: (e: Evidence) => e.units >= 2 },
  { id: "M2", text: "≥2 distinct issues/PRs", test: (e: Evidence) => e.refs >= 2 },
  {
    id: "M3",
    text: "≥2 distinct issues/PRs across ≥2 days",
    test: (e: Evidence) => e.refs >= 2 && e.days >= 2,
  },
  { id: "M4", text: "≥3 distinct issues/PRs", test: (e: Evidence) => e.refs >= 3 },
] as const;
type Evidence = { units: number; refs: number; days: number; refList: string[] };

type Problem = {
  id: string;
  /** `none`: noise no finding should rest on. */
  expect?: "none";
  cause: string;
  category: string;
  acceptCategories?: string[];
  target: string;
  acceptTargets?: string[];
  refs: number[];
  diagnosedIn: number[];
  notes?: string;
};
type Calibration = { draft: boolean; note: string; problems: Problem[] };

type Score = {
  problem: Problem;
  /** For an `expect: none` problem, the findings that rest on it. */
  offenders: Finding[];
  finding: Finding | null;
  overlap: number[];
  categoryOk: boolean;
  targetOk: boolean;
  inFlagged: number[];
};

function targetMatches(problem: Problem, target: string): boolean {
  const want = [problem.target, ...(problem.acceptTargets ?? [])].map((t) => t.toLowerCase());
  const got = target.toLowerCase();
  return want.some((t) => t === got || got.includes(t) || t.includes(got));
}

// --- HTML ------------------------------------------------------------------------

function esc(text: unknown): string {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Just enough Markdown for problem/fix text: code spans, bold, paragraphs, bullets. */
function md(text: string): string {
  const inline = (line: string) =>
    esc(line)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/#(\d+)\b/g, '<a href="https://github.com/JesusFilm/phoebe/issues/$1">#$1</a>');
  const blocks = text.split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((line) => /^\s*([-*]|\d+\.)\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

function ghLink(ref: string): string {
  const match = /^(issue|pr):(\d+)$/.exec(ref);
  if (match === null) return esc(ref);
  return `<a href="https://github.com/JesusFilm/phoebe/${match[1] === "pr" ? "pull" : "issues"}/${match[2]}">${esc(ref)}</a>`;
}

/** The first attempt, run before the harness note existed, kept for the record. */
function attemptOneNote(): string {
  const dir = join(RUNS_DIR, "attempt-1-no-shell");
  if (!existsSync(dir)) return "";
  const parts = VARIANTS.flatMap((variant) => {
    const metaPath = join(dir, `${variant}.meta.json`);
    const findingsPath = join(dir, `${variant}.findings.json`);
    if (!existsSync(metaPath)) return [];
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as RunMeta;
    const findings = existsSync(findingsPath)
      ? (JSON.parse(readFileSync(findingsPath, "utf8")) as { findings: { category: string; target: string }[] }).findings
      : [];
    return [
      `${variant}: ${findings.length} findings (${findings.map((f) => `<code>${esc(f.category)}:${esc(f.target)}</code>`).join(", ") || "none"}), $${meta.costUsd?.toFixed(2) ?? "?"}, ${Math.round(meta.durationMs / 1000)}s`,
    ];
  });
  return `<div class="note"><strong>Attempt 1, discarded.</strong> The first run of all three variants had no harness note. Each agent's first shell call (<code>cd …; python3 …</code>) was denied, every one concluded it had no shell at all, and none ran <code>gh</code> on any issue or PR, so they grouped from <code>flagged.json</code> alone. The runs above add one appended system-prompt line, the same for every variant, listing the read-only commands allowed. Attempt 1 is kept in <code>report/runs/attempt-1-no-shell/</code>: ${parts.join("; ")}.</div>`;
}

// --- Main ------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(RUNS_DIR, { recursive: true });
  if (argValue("--units") === undefined && (!existsSync(UNITS_PATH) || hasFlag("--rebuild"))) {
    execFileSync(
      process.execPath,
      [join(PROTO_DIR, "build-fixture.ts"), "--days", argValue("--days") ?? "30"],
      { stdio: "inherit" },
    );
  }
  const lookbackMs = everyMs(LOOKBACK);
  const histories = readHistories(UNITS_PATH);
  const coverage = renderCoverage(
    histories.map((history) => coverageOf(history, NOW, lookbackMs)),
    LOOKBACK,
  );
  const units = unitsSince(histories, new Date(NOW.getTime() - lookbackMs));
  const realProposals = proposalsFromGitHub();
  const proposalIssues = new Set(realProposals.map((proposal) => proposal.number));
  const phoebe = phoebeIdentity(units);
  const outcomes = gatherPrOutcomes({
    units,
    github,
    revertCommits: revertCommitsSince,
    proposalIssues,
    phoebe,
    repoSlug: config.repoSlug,
    ignoredBranches: new Set([config.defaultBranch, `${config.branchPrefix}workspace`]),
    now: NOW,
  });
  const allFlagged = flagUnits(units, {
    onProposal: (unit) => isProposalUnit(unit.record, proposalIssues),
    prOutcome: (unit) => outcomes.get(unit.key),
  });
  const capped = allFlagged.length > FLAGGED_CAP;
  const flagged = capped ? allFlagged.slice(0, FLAGGED_CAP) : allFlagged;
  const rows = flaggedRows(flagged);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const unitById = new Map(flagged.map((unit, index) => [`u${index + 1}`, unit]));

  // A PR's units count as the issue it closes: read that off the fixture's own records.
  const prToIssue = new Map<number, string>();
  for (const unit of units) {
    if (unit.record.prNumber !== null && /^issue:\d+$/.test(unit.record.unit.id)) {
      prToIssue.set(unit.record.prNumber, unit.record.unit.id);
    }
  }

  // Counts.
  const byOutcome = new Map<string, number>();
  for (const unit of units) {
    const key = `${unit.pipeline}/${unit.record.unit.kind} ${unit.record.outcome}`;
    byOutcome.set(key, (byOutcome.get(key) ?? 0) + 1);
  }
  const byFlag = new Map<string, number>();
  for (const unit of allFlagged) for (const flag of unit.flags) byFlag.set(flag, (byFlag.get(flag) ?? 0) + 1);
  const prUnits = units.filter((unit) => outcomes.get(unit.key)?.signals != null).length;
  const prCount = new Set(
    [...outcomes.values()].flatMap((o) => (o.signals === null ? [] : [o.signals.number])),
  ).size;
  const flaggedPrs = new Map<string, Set<number>>();
  for (const unit of allFlagged) {
    if (unit.pr === null) continue;
    for (const flag of unit.flags) {
      const set = flaggedPrs.get(flag) ?? new Set<number>();
      set.add(unit.pr.number);
      flaggedPrs.set(flag, set);
    }
  }

  console.log(`units in lookback ${LOOKBACK}: ${units.length} (${coverage})`);
  console.log(`settled PRs read: ${prCount} (${prUnits} units on them); phoebe identity: ${phoebe}`);
  console.log(`flagged: ${allFlagged.length}${capped ? ` (capped to ${FLAGGED_CAP})` : ""}`);
  for (const [flag, count] of [...byFlag].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flag.padEnd(18)} ${String(count).padStart(4)} units, ${flaggedPrs.get(flag)?.size ?? 0} PRs`);
  }
  writeFileSync(join(RUNS_DIR, "flagged.json"), `${JSON.stringify(rows, null, 2)}\n`);
  if (FLAG_ONLY) return;

  // Variants.
  const fakes = fakeProposals();
  const calibration = JSON.parse(
    readFileSync(join(PROTO_DIR, "calibration.json"), "utf8"),
  ) as Calibration;
  const flaggedNumbers = new Set(rows.flatMap(numbersOf));

  type VariantResult = {
    variant: string;
    meta: RunMeta | null;
    findings: Finding[];
    dropped: string[];
    parseError: string | null;
    decisions: Map<string, FindingDecision>;
    evidence: Map<string, Evidence>;
    scores: Score[];
    unlabelled: Finding[];
    proposals: RichProposal[];
  };

  const pending: Promise<void>[] = [];
  const metas = new Map<string, RunMeta | null>();
  const variantProposals = new Map<string, RichProposal[]>();
  if (!REUSE) ensureCheckout();
  try {
    for (const variant of VARIANTS) {
      const template = readFileSync(join(PROTO_DIR, "variants", `${variant}.md`), "utf8");
      const scratch = join(SCRATCH_ROOT, variant);
      rmSync(scratch, { recursive: true, force: true });
      mkdirSync(scratch, { recursive: true });
      const flaggedPath = join(scratch, "flagged.json");
      const proposalsPath = join(scratch, "proposals.json");
      const findingsPath = join(scratch, FINDINGS_FILE);
      writeFileSync(flaggedPath, `${JSON.stringify(rows, null, 2)}\n`);
      const rich = variant === "C";
      const proposals: RichProposal[] = rich
        ? [...realProposals.map((p) => ({ ...p, title: "" })), ...fakes]
        : realProposals.map((p) => ({ ...p, title: "" }));
      variantProposals.set(variant, proposals);
      writeFileSync(
        proposalsPath,
        `${JSON.stringify(rich ? richProposalRows(proposals) : proposalRows(proposals), null, 2)}\n`,
      );
      const prompt = renderPrompt(
        template,
        {
          ...buildDefaultPromptArgs(config),
          OBSERVER_LOOKBACK: LOOKBACK,
          OBSERVER_COVERAGE: coverage,
          FLAGGED_COUNT: String(rows.length),
          FLAGGED_JSON: flaggedPath,
          PROPOSALS_JSON: proposalsPath,
          FINDINGS_JSON: findingsPath,
          SCRATCH_DIR: scratch,
        },
        (command) => {
          throw new Error(`prompt asked to run ${command}`);
        },
      );
      writeFileSync(join(RUNS_DIR, `${variant}.prompt.md`), prompt);
      writeFileSync(join(RUNS_DIR, `${variant}.proposals.json`), readFileSync(proposalsPath));
      if (REUSE) {
        const metaPath = join(RUNS_DIR, `${variant}.meta.json`);
        metas.set(variant, existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as RunMeta) : null);
        continue;
      }
      console.log(`running variant ${variant} on ${MODEL}…`);
      pending.push(
        runClaude(variant, prompt, scratch).then((meta) => {
          metas.set(variant, meta);
          writeFileSync(join(RUNS_DIR, `${variant}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
          if (existsSync(findingsPath)) {
            writeFileSync(join(RUNS_DIR, `${variant}.findings.json`), readFileSync(findingsPath));
          }
          console.log(
            `variant ${variant}: exit ${meta.exitCode}, ${Math.round(meta.durationMs / 1000)}s, ` +
              `$${meta.costUsd?.toFixed(2) ?? "?"}, ${meta.turns ?? "?"} turns`,
          );
        }),
      );
    }
    await Promise.all(pending);
  } finally {
    if (!REUSE) removeCheckout();
  }

  const results: VariantResult[] = [];
  for (const variant of VARIANTS) {
    const findingsPath = join(RUNS_DIR, `${variant}.findings.json`);
    let findings: Finding[] = [];
    let dropped: string[] = [];
    let parseError: string | null = null;
    if (!existsSync(findingsPath)) {
      parseError = `no ${FINDINGS_FILE} was written`;
    } else {
      try {
        const parsed = parseFindings(readFileSync(findingsPath, "utf8"), new Set(rowById.keys()));
        findings = [...parsed.findings].sort((a, b) => b.units.length - a.units.length);
        dropped = parsed.dropped;
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }
    const proposals = variantProposals.get(variant) ?? [];
    const decisions = new Map<string, FindingDecision>();
    const evidence = new Map<string, Evidence>();
    for (const finding of findings) {
      decisions.set(
        finding.key,
        decideFinding(
          proposals.filter((proposal) => proposal.key === finding.key),
          NOW,
        ),
      );
      const findingRows = finding.units.map((id) => rowById.get(id)!);
      const refs = new Set(findingRows.map((row) => threadOf(row, prToIssue)));
      const days = new Set(findingRows.map((row) => row.startedAt.slice(0, 10)));
      evidence.set(finding.key, {
        units: findingRows.length,
        refs: refs.size,
        days: days.size,
        refList: [...refs],
      });
    }
    const matched = new Set<string>();
    const numbersOfFinding = (finding: Finding) =>
      new Set(finding.units.flatMap((id) => numbersOf(rowById.get(id)!)));
    const scores: Score[] = calibration.problems.map((problem) => {
      if (problem.expect === "none") {
        // A finding rests on noise when at least half its issues/PRs are the noise's refs.
        const offenders = findings.filter((finding) => {
          const numbers = [...numbersOfFinding(finding)];
          const inside = numbers.filter((n) => problem.refs.includes(n)).length;
          return numbers.length > 0 && inside / numbers.length >= 0.5;
        });
        for (const finding of offenders) matched.add(finding.key);
        return {
          problem,
          offenders,
          finding: null,
          overlap: [],
          categoryOk: false,
          targetOk: false,
          inFlagged: problem.refs.filter((n) => flaggedNumbers.has(n)),
        };
      }
      let best: Finding | null = null;
      let bestOverlap: number[] = [];
      for (const finding of findings) {
        const numbers = numbersOfFinding(finding);
        const overlap = problem.refs.filter((n) => numbers.has(n));
        if (overlap.length > 0) matched.add(finding.key);
        if (overlap.length > bestOverlap.length) {
          best = finding;
          bestOverlap = overlap;
        }
      }
      const categories = [problem.category, ...(problem.acceptCategories ?? [])];
      return {
        problem,
        offenders: [],
        finding: best,
        overlap: bestOverlap,
        categoryOk: best !== null && categories.includes(best.category),
        targetOk: best !== null && targetMatches(problem, best.target),
        inFlagged: problem.refs.filter((n) => flaggedNumbers.has(n)),
      };
    });
    results.push({
      variant,
      meta: metas.get(variant) ?? null,
      findings,
      dropped,
      parseError,
      decisions,
      evidence,
      scores,
      unlabelled: findings.filter((finding) => !matched.has(finding.key)),
      proposals,
    });
  }

  // --- stdout summary ---
  console.log("");
  for (const result of results) {
    const positives = result.scores.filter((s) => s.problem.expect !== "none");
    const hits = positives.filter((s) => s.finding !== null);
    const noisy = result.scores.filter((s) => s.problem.expect === "none" && s.offenders.length > 0);
    console.log(
      `variant ${result.variant}: ${result.findings.length} findings, ` +
        `$${result.meta?.costUsd?.toFixed(2) ?? "?"}, ${Math.round((result.meta?.durationMs ?? 0) / 1000)}s; ` +
        `calibration ${hits.length}/${positives.length} covered ` +
        `(${hits.filter((s) => s.categoryOk).length} right category, ` +
        `${hits.filter((s) => s.targetOk).length} right target), ` +
        `${noisy.length} noise problems turned into findings, ` +
        `${result.unlabelled.length} unlabelled findings` +
        (result.parseError === null ? "" : ` [${result.parseError}]`),
    );
    for (const finding of result.findings) {
      const e = result.evidence.get(finding.key)!;
      const pass = RULES.filter((rule) => rule.test(e)).map((rule) => rule.id).join(",") || "none";
      const decision = result.decisions.get(finding.key)!;
      console.log(
        `  ${finding.key} — ${finding.units.length} units, ${e.refs} refs, ${e.days} days; ` +
          `passes ${pass}; code would ${decision.action}${decision.action === "fold" ? ` into #${decision.into.number}` : ""}`,
      );
    }
    for (const line of result.dropped) console.log(`  dropped ${line}`);
  }

  // --- HTML report ---
  const meta = existsSync(join(PROTO_DIR, "fixture", "meta.json"))
    ? (JSON.parse(readFileSync(join(PROTO_DIR, "fixture", "meta.json"), "utf8")) as {
        builtAt: string;
        notes: string[];
      })
    : null;
  const section: string[] = [];
  section.push(`<section><h2>Input</h2>
<p>History file <code>${esc(UNITS_PATH.replace(REPO_ROOT + "/", ""))}</code>${
    meta === null ? "" : `, built ${esc(meta.builtAt.slice(0, 16))} UTC`
  }. Lookback <strong>${esc(LOOKBACK)}</strong> ending ${esc(NOW.toISOString().slice(0, 16))} UTC, ${esc(coverage)}.
Grouping model <code>${esc(MODEL)}</code>${EFFORT === undefined ? " (no effort flag)" : `, effort ${esc(EFFORT)}`}.
Phoebe's git identity for <code>outside-commits</code>: <code>${esc(phoebe)}</code>.</p>
${meta === null ? "" : `<ul>${meta.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`}
<div class="grid">
<div><h3>Units by kind and outcome (${units.length})</h3><table><tbody>${[...byOutcome]
    .sort()
    .map(([key, count]) => `<tr><td>${esc(key)}</td><td class="n">${count}</td></tr>`)
    .join("")}</tbody></table></div>
<div><h3>Flags (${allFlagged.length} units flagged${capped ? `, <strong>capped to the newest ${FLAGGED_CAP}</strong>` : ""})</h3>
<p class="muted">${prCount} settled PRs read for ${prUnits} units.</p>
<table><thead><tr><th>flag</th><th>units</th><th>PRs</th></tr></thead><tbody>${[...byFlag]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([flag, count]) =>
        `<tr><td>${esc(flag)}</td><td class="n">${count}</td><td class="n">${flaggedPrs.get(flag)?.size ?? "–"}</td></tr>`,
    )
    .join("")}</tbody></table></div>
</div>
<details><summary>All ${rows.length} flagged units as the agent saw them</summary>
<table class="units"><thead><tr><th>id</th><th>kind</th><th>ref</th><th>PR</th><th>flags</th><th>started</th><th>detail</th></tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr><td>${row.id}</td><td>${esc(row.kind)}</td><td>${ghLink(row.ref)}</td><td>${row.prNumber === null ? "" : ghLink(`pr:${row.prNumber}`)}</td><td>${esc(row.flags.join(", "))}</td><td>${esc(row.startedAt.slice(0, 16))}</td><td class="detail">${esc(oneLine(row.detail ?? "", 200))}</td></tr>`,
    )
    .join("")}</tbody></table></details></section>`);

  // Run cost table.
  section.push(`<section><h2>Runs</h2><table><thead><tr><th>variant</th><th>findings</th><th>exit</th><th>duration</th><th>turns</th><th>cost (USD)</th><th>input / output / cache read / cache write tokens</th><th>denied tool calls</th></tr></thead><tbody>${results
    .map((r) => {
      const u = (r.meta?.usage ?? {}) as Record<string, number | undefined>;
      return `<tr><td><a href="#v-${r.variant}">${r.variant}</a></td><td class="n">${r.findings.length}</td><td>${r.meta?.exitCode ?? "–"}</td><td class="n">${r.meta === null ? "–" : `${Math.round(r.meta.durationMs / 1000)}s`}</td><td class="n">${r.meta?.turns ?? "–"}</td><td class="n">${r.meta?.costUsd?.toFixed(2) ?? "–"}</td><td class="n">${[u["input_tokens"], u["output_tokens"], u["cache_read_input_tokens"], u["cache_creation_input_tokens"]].map((v) => (v === undefined ? "–" : v.toLocaleString("en-US"))).join(" / ")}</td><td>${(r.meta?.denials ?? []).length === 0 ? "0" : `<details><summary>${r.meta!.denials.length}</summary><ul>${r.meta!.denials.map((d) => `<li><code>${esc(d)}</code></li>`).join("")}</ul></details>`}</td></tr>`;
    })
    .join("")}</tbody></table>
<p class="muted">Cost is what the CLI reports (<code>total_cost_usd</code>); on a subscription it is a list-price estimate nobody paid.</p>${attemptOneNote()}</section>`);

  // Calibration scorecard.
  section.push(`<section><h2>Calibration scorecard <span class="badge">DRAFT labels</span></h2>
<p>${esc(calibration.note)}</p>
<table class="score"><thead><tr><th>problem</th><th>expected</th><th>in flagged set</th>${results
    .map((r) => `<th>${r.variant}</th>`)
    .join("")}</tr></thead><tbody>${calibration.problems
    .map((problem, index) => {
      const cells = results
        .map((r) => {
          const s = r.scores[index]!;
          if (problem.expect === "none") {
            return s.offenders.length === 0
              ? `<td class="hit">clean</td>`
              : `<td class="miss">rests on it: ${s.offenders.map((f) => `<code>${esc(f.key)}</code>`).join(", ")}</td>`;
          }
          if (s.finding === null) return `<td class="miss">miss</td>`;
          return `<td class="${s.categoryOk ? "hit" : "partial"}"><code>${esc(s.finding.key)}</code><br>category ${s.categoryOk ? "✓" : "✗"}, target ${s.targetOk ? "✓" : "✗"}<br>refs ${s.overlap.map((n) => `#${n}`).join(" ")} of ${s.inFlagged.length}</td>`;
        })
        .join("");
      return `<tr><td><strong>${esc(problem.id)}</strong>${problem.expect === "none" ? ' <span class="badge">noise</span>' : ""} ${esc(problem.cause)}<br><span class="muted">diagnosed in ${problem.diagnosedIn.map((n) => `<a href="https://github.com/JesusFilm/phoebe/issues/${n}">#${n}</a>`).join(", ")}${problem.notes ? ` · ${esc(problem.notes)}` : ""}</span></td><td>${problem.expect === "none" ? "no finding" : `<code>${esc(problem.category)}:${esc(problem.target)}</code>${problem.acceptCategories ? `<br><span class="muted">or ${esc(problem.acceptCategories.join(", "))}</span>` : ""}`}</td><td>${problem.refs
        .map((n) => (flaggedNumbers.has(n) ? `#${n}` : `<s title="not flagged">#${n}</s>`))
        .join(" ")}</td>${cells}</tr>`;
    })
    .join("")}
<tr><td colspan="3"><strong>Covered · right category · right target · noise turned into findings · unlabelled findings</strong></td>${results
    .map((r) => {
      const positives = r.scores.filter((s) => s.problem.expect !== "none");
      const hits = positives.filter((s) => s.finding !== null);
      const noisy = r.scores.filter((s) => s.problem.expect === "none" && s.offenders.length > 0);
      return `<td>${hits.length}/${positives.length} · ${hits.filter((s) => s.categoryOk).length} · ${hits.filter((s) => s.targetOk).length} · ${noisy.length} · ${r.unlabelled.length}</td>`;
    })
    .join("")}</tr></tbody></table>
<p class="muted">A problem is covered when some finding lists a unit whose issue or PR is one of the problem's refs; the cell shows the finding with the largest overlap. A struck-through ref was never flagged, so no prompt could cover it. "Unlabelled" findings match no labelled problem: false positives or discoveries, for a person to judge.</p></section>`);

  // Matrix of findings x rules.
  section.push(`<section><h2>Minimum evidence</h2><p>Each rule is applied in code to every finding. Refs count a PR's units as the issue the PR closes, so the run that opened a PR and the reviews run on it are one ref.</p>${results
    .map(
      (r) => `<h3>Variant ${r.variant}</h3><table class="matrix"><thead><tr><th>finding</th><th>units</th><th>refs</th><th>days</th>${RULES.map((rule) => `<th title="${esc(rule.text)}">${rule.id}<br><span class="muted">${esc(rule.text)}</span></th>`).join("")}<th>code would</th></tr></thead><tbody>${r.findings
        .map((finding) => {
          const e = r.evidence.get(finding.key)!;
          const d = r.decisions.get(finding.key)!;
          return `<tr><td><code>${esc(finding.key)}</code></td><td class="n">${e.units}</td><td class="n">${e.refs}</td><td class="n">${e.days}</td>${RULES.map((rule) => (rule.test(e) ? `<td class="hit">pass</td>` : `<td class="miss">cut</td>`)).join("")}<td>${esc(d.action)}${d.action === "fold" ? ` into #${d.into.number}` : d.action === "skip" ? `: ${esc(d.reason)}` : ""}</td></tr>`;
        })
        .join("")}<tr><td><strong>survive</strong></td><td></td><td></td><td></td>${RULES.map((rule) => `<td class="n"><strong>${r.findings.filter((f) => rule.test(r.evidence.get(f.key)!)).length}/${r.findings.length}</strong></td>`).join("")}<td></td></tr></tbody></table>`,
    )
    .join("")}</section>`);

  // Per variant findings.
  for (const r of results) {
    const proposalNote =
      r.variant === "C"
        ? `<div class="note"><strong>Fake prior proposals.</strong> This variant's <code>proposals.json</code> carries each proposal's title and first problem paragraph, and two invented proposals that do not exist on GitHub: ${r.proposals
            .filter((p) => p.fake)
            .map((p) => `<code>${esc(p.key)}</code> (#${p.number}, ${esc(p.state)}${p.stateReason ? ` ${esc(p.stateReason)}` : ""}: “${esc(p.title)}”)`)
            .join(" and ")}.</div>`
        : "";
    section.push(`<section id="v-${r.variant}"><h2>Variant ${r.variant}: ${r.findings.length} findings</h2>${proposalNote}${
      r.parseError === null ? "" : `<p class="miss">Parse error: ${esc(r.parseError)}</p>`
    }${r.dropped.length === 0 ? "" : `<p class="muted">Dropped by parseFindings: ${r.dropped.map(esc).join("; ")}</p>`}${
      r.meta?.error ? `<p class="miss">Run error: ${esc(r.meta.error)}</p>` : ""
    }${r.findings
      .map((finding) => {
        const e = r.evidence.get(finding.key)!;
        const d = r.decisions.get(finding.key)!;
        const labelled = r.scores
          .filter((s) => s.finding?.key === finding.key || s.offenders.some((f) => f.key === finding.key))
          .map((s) => (s.problem.expect === "none" ? `${s.problem.id} (noise)` : s.problem.id));
        return `<article class="finding"><header><span class="cat cat-${esc(finding.category)}">${esc(finding.category)}</span> <code>${esc(finding.target)}</code> <span class="muted">${e.units} units · ${e.refs} refs · ${e.days} days · code would ${esc(d.action)}${d.action === "fold" ? ` into #${d.into.number}` : ""}${labelled.length > 0 ? ` · matches ${labelled.join(", ")}` : " · unlabelled"}</span></header>
<h3>${esc(finding.title)}</h3>
<h4>Problem</h4>${md(finding.problem)}<h4>Fix</h4>${md(finding.fix)}
<details><summary>${finding.units.length} units</summary><table class="units"><tbody>${finding.units
          .map((id) => {
            const row = rowById.get(id)!;
            const unit = unitById.get(id)!;
            return `<tr><td>${id}</td><td>${esc(row.kind)}</td><td>${ghLink(row.ref)}</td><td>${row.prNumber === null ? "" : ghLink(`pr:${row.prNumber}`)}</td><td>${esc(unit.flags.join(", "))}</td><td>${esc(row.startedAt.slice(0, 16))}</td><td class="detail">${esc(oneLine(row.detail ?? "", 240))}</td></tr>`;
          })
          .join("")}</tbody></table></details></article>`;
      })
      .join("")}${
      r.meta?.result ? `<details><summary>The run's final message</summary><pre>${esc(r.meta.result)}</pre></details>` : ""
    }</section>`);
  }

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Observer grouping prototype</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#deddd8;--card:#fff;--code:#f0efeb;--hit:#dcefdc;--miss:#f6dddd;--partial:#f6edd2;--accent:#3c5a99}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#e8e7e2;--muted:#9a9993;--line:#343431;--card:#1f1f1d;--code:#2a2a27;--hit:#1f3a22;--miss:#432222;--partial:#3f3720;--accent:#8fa8e0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.25rem;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:1.05rem;margin:12px 0 4px}h4{font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:12px 0 2px}
a{color:var(--accent)}code{background:var(--code);padding:1px 4px;border-radius:3px;font-size:.88em}pre{white-space:pre-wrap;background:var(--code);padding:12px;border-radius:6px;font-size:.85em}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:.9em}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--code)}td.n{text-align:right;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.muted{color:var(--muted)}.hit{background:var(--hit)}.miss{background:var(--miss)}.partial{background:var(--partial)}
.finding{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}.finding p{margin:4px 0}.cat{font-weight:600;padding:1px 6px;border-radius:4px;background:var(--code)}
.banner{background:var(--partial);border:1px solid var(--line);padding:8px 12px;border-radius:6px}.note{background:var(--code);padding:8px 12px;border-radius:6px;margin:8px 0}.badge{font-size:.7em;background:var(--partial);padding:2px 6px;border-radius:4px;vertical-align:middle}
td.detail{max-width:520px;word-break:break-word}table.units{font-size:.82em}.score td{min-width:120px}
@media (max-width:700px){table{display:block;overflow-x:auto}}
</style></head><body><main>
<h1>Observer grouping prototype</h1>
<p class="banner"><strong>PROTOTYPE, throwaway</strong>, for <a href="https://github.com/JesusFilm/phoebe/issues/980">#980</a>. The unit history is reconstructed from GitHub (see <code>kinds/observer/prototype-grouping/README.md</code>), not read from a running observer. Generated ${esc(new Date().toISOString().slice(0, 16))} UTC.</p>
${section.join("\n")}
</main></body></html>
`;
  writeFileSync(join(REPORT_DIR, "index.html"), html);
  console.log(`\nreport: ${join(REPORT_DIR, "index.html")}`);
}

await main();
