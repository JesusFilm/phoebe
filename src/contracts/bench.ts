// What `phoebe bench select` prints (#939; spec #925, decisions #921): a pinned
// suite of fixtures, each one an issue Phoebe already solved. The operator saves
// it in the deployment directory, and `phoebe bench run` replays it later, so it
// has to carry everything a replay reads. A replay reads nothing live.
//
// Here rather than beside the verb so the reader on the far side of a file —
// `bench run`, a console, a script — shares one shape with the writer.

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
