// What `phoebe bench select` prints (#939; spec #925, decisions #921): a pinned
// suite of fixtures, each one an issue Phoebe already solved. The operator saves
// it in the deployment directory, and `phoebe bench run` replays it later, so it
// has to carry everything a replay reads. A replay reads nothing live.
//
// Here rather than beside the verb so the reader on the far side of a file —
// `bench run`, a console, a script — shares one shape with the writer.
//
// `bench run` (#940, #941) writes the rest: one trial per line and the config
// it ran with. It also reads one file the operator keeps, the bench config that
// names the contenders. The report a run ends with is in ./bench-report.ts.

import type { AgentRunRecord, UnitRecord } from "./unit-record.ts";

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
  /**
   * ISO. When `bench select` saw the merged PR's head pass install, check and
   * test with no agent (#988). Absent when the suite was pinned with
   * `--no-baseline`, or before baselines existed.
   */
  baselinePassedAt?: string;
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
 * The gates of one trial, or of one fixture's baseline. A gate bench did not
 * reach is `null`: everything after the first failure, and `check` and `test`
 * when the agent left no commits.
 */
export type BenchGates = {
  install: BenchGateResult | null;
  check: BenchGateResult | null;
  test: BenchGateResult | null;
};

/**
 * Where a fixture's baseline failed: the first gate that exited non-zero on the
 * merged PR's head, or `checkout` when that head could not be put in a tree.
 */
export type BenchBaselineGate = "checkout" | keyof BenchGates;

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

// --- the bench config (#941) ------------------------------------------------

/**
 * One contender as the operator writes it in the bench config. Every field but
 * `name` is optional: an unset one takes the tenant's `issues` setting.
 */
export type BenchContenderSpec = {
  /** Names the contender in the report, the trial ids and the patch files. */
  name: string;
  provider?: string;
  model?: string;
  /** `null` passes no effort flag, leaving the provider CLI's own default. */
  effort?: string | null;
  /** A prompt template anywhere in the deployment directory, relative to it. */
  promptFile?: string;
};

/**
 * The judge (#942): the provider and model that compare each trial with
 * commits against the PR that merged. Both are required; the judge runs at its
 * provider CLI's default effort.
 */
export type BenchJudge = {
  provider: string;
  model: string;
};

/** The file `bench run --bench-config` reads. */
export type BenchConfig = {
  contenders: BenchContenderSpec[];
  /** How many times each fixture–contender pair is replayed. Default 1. */
  repeat?: number;
  /** Off when absent: no judge runs and the report has no verdicts. */
  judge?: BenchJudge;
};

/** The fixed scale a judge places a trial's patch on, against the merged PR. */
export const BENCH_VERDICTS = ["better", "equivalent", "worse", "wrong"] as const;

export type BenchVerdict = (typeof BENCH_VERDICTS)[number];

/**
 * The judge's reading of one trial. `verdict` and `rationale` are `null` when
 * the judge gave no verdict on the scale: its run failed, timed out, was
 * interrupted, or answered with something else. `error` then says which.
 *
 * `run` is the judge's own usage. It is kept here, apart from the trial's
 * `agentRuns`, so nothing that totals a contender's cost ever counts it.
 */
export type BenchJudgement = {
  provider: string;
  model: string;
  verdict: BenchVerdict | null;
  /** At most 500 characters. */
  rationale: string | null;
  error: string | null;
  /** `null` when the judge never started, e.g. the merged diff could not be read. */
  run: AgentRunRecord | null;
};

/**
 * The settings a trial ran with: a contender from the bench config, with the
 * tenant's `issues` settings filling what it left unset. Without a bench config
 * the one contender is the tenant's own settings, named `tenant`.
 */
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
  /** `null` when the run had no judge or the trial left no commits. */
  judgement: BenchJudgement | null;
};

/** `bench/<runId>/config.json`: what the run was set to do, written before the first trial. */
export type BenchRunConfig = {
  v: 1;
  runId: string;
  repo: string;
  /** ISO. */
  startedAt: string;
  suite: { path: string; selectedAt: string; fixtures: number[] };
  /** The bench config file as the operator named it; `null` when the run had none. */
  benchConfig: string | null;
  contenders: BenchContender[];
  repeat: number;
  /** The bench config's judge; `null` when it named none. */
  judge: BenchJudge | null;
  /** How many trials ran at once. */
  concurrency: number;
  runTimeoutMs: number;
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  engineCommit: string | null;
};
