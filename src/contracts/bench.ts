// What `phoebe bench select` prints (#939; spec #925, decisions #921): a pinned
// suite of fixtures, each one an issue Phoebe already solved. The operator saves
// it in the deployment directory, and `phoebe bench run` replays it later, so it
// has to carry everything a replay reads. A replay reads nothing live.
//
// Here rather than beside the verb so the reader on the far side of a file —
// `bench run`, a console, a script — shares one shape with the writer.
//
// `bench run` (#940) writes the rest: one trial per line, the config it ran
// with, and a summary of how far it got.

import type { UnitRecord } from "./unit-record.ts";

/** One issue comment as it stood when the PR opened. */
export type BenchComment = {
  /** `null` for a deleted account. */
  author: string | null;
  /** ISO. */
  createdAt: string;
  body: string;
};

/**
 * One issue Phoebe solved, pinned. Everything a replay needs to set the agent
 * the same task: the issue as the agent saw it, and the commit its work started
 * from.
 */
export type BenchFixture = {
  issue: {
    number: number;
    title: string;
    body: string;
    /** Only the comments posted before the PR opened, oldest first. */
    comments: BenchComment[];
  };
  pr: {
    number: number;
    /** The PR's head commit as it merged. */
    headSha: string;
    /** The commit the merge put on the default branch. */
    mergeSha: string;
  };
  /**
   * The merge-base of the PR head and the merge commit's first parent, computed
   * in the hub clone: the tree the PR started from (or last caught up with).
   */
  baseSha: string;
};

/** An issue the selection looked at and left out, and why. */
export type BenchSkip = {
  issue: number;
  /** The PR it was judged by, or `null` when none was found. */
  pr: number | null;
  reason: string;
};

/** How the suite was chosen, so a reader can tell a hand-picked one from a query. */
export type BenchSelection =
  | { by: "issues"; issues: number[] }
  | { by: "query"; since: string | null; limit: number };

/** The suite file. `v` moves only when an existing reader would misread it. */
export type BenchSuite = {
  v: 1;
  /** `owner/repo`. */
  repo: string;
  /** ISO. */
  selectedAt: string;
  selection: BenchSelection;
  fixtures: BenchFixture[];
  skipped: BenchSkip[];
};

// --- bench run (#940) -------------------------------------------------------

/**
 * One gate bench ran itself in the trial's worktree: `installCommand` before the
 * agent, `checkCommand` and `testCommand` after it. `exitCode` is `null` when
 * the command never exited on its own — killed by its timeout or an interrupt.
 */
export type BenchGateResult = {
  command: string;
  exitCode: number | null;
  durationMs: number;
};

/**
 * The gates of one trial. A gate bench did not reach is `null`: everything
 * after the first failure, and `check` and `test` when the agent left no
 * commits.
 */
export type BenchGates = {
  install: BenchGateResult | null;
  check: BenchGateResult | null;
  test: BenchGateResult | null;
};

/** What the trial's commits changed, measured from `baseSha`. */
export type BenchDiffStats = {
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

/**
 * A GitHub write the agent attempted through the trial's `gh` shim, which
 * answered with a plausible success and sent nothing anywhere.
 */
export type BenchWouldHave = {
  /** ISO. */
  at: string;
  /** `gh` subcommand, e.g. `pr create`, `issue comment`, `api`. */
  command: string;
  argv: string[];
  /** The text a `--body-file` (or `-F body=@file`) named, read when the call was made. */
  bodyFile?: string;
};

/** The settings a trial ran with. In a one-contender run, the tenant's own `issues` settings. */
export type BenchContender = {
  name: string;
  provider: string;
  model: string;
  effort: string | null;
  promptFile: string;
  /** SHA-256 of the prompt template before rendering, as unit records carry it. */
  promptSha: string;
};

/**
 * One line of `bench/<runId>/trials.jsonl`: a unit record under the `bench`
 * pipeline, plus what makes it a trial. It never enters a pipeline's
 * `units.jsonl`.
 */
export type BenchTrial = UnitRecord & {
  pipeline: "bench";
  runId: string;
  fixture: { issue: number; pr: number; baseSha: string };
  contender: string;
  /** 0-based. */
  repeat: number;
  /** `none` when the agent left no commits, so no gate after install ran. */
  change: "committed" | "none";
  gates: BenchGates;
  diff: BenchDiffStats | null;
  /** The trial's patch, relative to the run directory; `null` with no commits. */
  patch: string | null;
  wouldHave: BenchWouldHave[];
};

/** `bench/<runId>/config.json`: what the run was set to do, written before the first trial. */
export type BenchRunConfig = {
  v: 1;
  runId: string;
  repo: string;
  /** ISO. */
  startedAt: string;
  suite: { path: string; selectedAt: string; fixtures: number[] };
  contenders: BenchContender[];
  repeat: number;
  runTimeoutMs: number;
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  engineCommit: string | null;
};

/**
 * `bench/<runId>/report.json` as a one-contender run writes it: how far the
 * run got. `interrupted` marks a run stopped by Ctrl-C, whose trial in flight
 * was dropped.
 */
export type BenchRunSummary = {
  v: 1;
  runId: string;
  repo: string;
  /** ISO. */
  startedAt: string;
  finishedAt: string;
  interrupted: boolean;
  /** Trials the run meant to make, and the ones it recorded. */
  planned: number;
  recorded: number;
  outcomes: { completed: number; failed: number; timedOut: number; noChange: number };
};
