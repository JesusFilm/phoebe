// What became of the units' pull requests (#935, signals and cost from #916).
// The gather reads GitHub in batches; everything after it is a pure function
// of what it read, so each flag is tested from signals alone.
//
// The cost per 20 PRs, as #916 measured it: one GraphQL query matching
// branches to PRs (only for records with no PR number), two for the PRs
// themselves (ten per query), one revert search, and one Actions REST call per
// settled PR. `statusCheckRollup` is never read: neither credential arm can
// hold Checks: read. Revert commits come from `git log` on the run's own
// read-only checkout, which costs no API call.
//
// Only settled PRs (merged or closed) earn flags: an open PR is still being
// worked, and its outcome is not known yet. Every PR is still read, because a
// unit on an observer proposal is never flagged, open or not.

import type { UnitRecord } from "../../src/contracts/unit-record.ts";
import type {
  BranchPr,
  BranchWorkflowRun,
  GitHubClient,
  ObservedCommit,
  ObservedPr,
  RevertPr,
} from "../../src/github-client.ts";
import { MARKER_TEXT, PROPOSAL_LABEL } from "./proposals.ts";

/** Why a unit's PR is evidence. Fixed, so the grouping run reads the same words every run. */
export const PR_FLAGS = [
  "changes-requested",
  "review-threads",
  "outside-commits",
  "closed-unmerged",
  "reverted",
  "actions-failed",
  "slow-merge",
] as const;
export type PrFlag = (typeof PR_FLAGS)[number];

const HOUR_MS = 3_600_000;

/** A merged PR that took longer than this from opening to merge is slow. */
export const SLOW_MERGE_MS = 7 * 24 * HOUR_MS;

/** The Actions conclusions that count as a failed run. `cancelled` is not one. */
export const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "startup_failure",
]);

/** What became of one settled PR, as numbers the grouping run can read. */
export type PrSignals = {
  number: number;
  state: "closed" | "merged";
  changesRequested: number;
  reviewThreads: number;
  /** Content commits by someone other than Phoebe, after Phoebe's first. */
  outsideCommits: number;
  /** Failed Actions runs on the branch while the PR was open. */
  failedRuns: number;
  /** Whole hours from opening to merge; `null` when it did not merge. */
  hoursToMerge: number | null;
  /** The revert PR (`#57`) or revert commit (short SHA) that undid it. */
  revertedBy: string | null;
};

/** The flags one settled PR earns. */
export function prFlagsOf(signals: PrSignals): PrFlag[] {
  const flags: PrFlag[] = [];
  if (signals.changesRequested > 0) flags.push("changes-requested");
  if (signals.reviewThreads > 0) flags.push("review-threads");
  if (signals.outsideCommits > 0) flags.push("outside-commits");
  if (signals.state === "closed") flags.push("closed-unmerged");
  if (signals.revertedBy !== null) flags.push("reverted");
  if (signals.failedRuns > 0) flags.push("actions-failed");
  if (signals.hoursToMerge !== null && signals.hoursToMerge * HOUR_MS > SLOW_MERGE_MS) {
    flags.push("slow-merge");
  }
  return flags;
}

/** `Name <email>`, email lowercased: how a git identity is compared. */
export function identityOf(commit: { authorName: string; authorEmail: string }): string {
  return `${commit.authorName} <${commit.authorEmail.toLowerCase()}>`;
}

/**
 * Phoebe's git identity from the engine's environment, which the bootstrapper
 * fills from `gitIdentity`, the tenant's `GIT_AUTHOR_*`, or the App's bot.
 * `null` when it is not set, and each PR's first commit stands in.
 */
export function phoebeIdentityFrom(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const name = env["GIT_AUTHOR_NAME"];
  const email = env["GIT_AUTHOR_EMAIL"];
  if (!name || !email) return null;
  return identityOf({ authorName: name, authorEmail: email });
}

/**
 * Commits pushed after Phoebe's first by another git identity. The login cannot
 * tell them apart on the PAT arm, where Phoebe and the operator share one, so
 * the git author does. A merge commit (the "Update branch" button, or a
 * catch-up) changes no code and is not counted.
 */
export function outsideCommitCount(
  commits: readonly ObservedCommit[],
  phoebe: string | null,
): number {
  const own = phoebe ?? (commits[0] === undefined ? null : identityOf(commits[0]));
  if (own === null) return 0;
  const first = commits.findIndex((commit) => identityOf(commit) === own);
  if (first === -1) return 0;
  return commits
    .slice(first + 1)
    .filter((commit) => commit.parents <= 1 && identityOf(commit) !== own).length;
}

/** Failed Actions runs on the PR's branch between its opening and its close. */
export function failedRunCount(runs: readonly BranchWorkflowRun[], pr: ObservedPr): number {
  const from = Date.parse(pr.createdAt);
  const to = pr.closedAt === null ? Number.POSITIVE_INFINITY : Date.parse(pr.closedAt);
  return runs.filter((run) => {
    const at = Date.parse(run.createdAt);
    return (
      at >= from && at <= to && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)
    );
  }).length;
}

/** A commit on the default branch that says what it reverts. */
export type RevertCommit = { sha: string; reverts: string[] };

const REVERTS_COMMIT_RE = /This reverts commit ([0-9a-f]{7,40})/g;

/** `git log --format=%H%x1f%B%x1e` output, read for "This reverts commit <sha>". */
export function parseRevertLog(output: string): RevertCommit[] {
  const commits: RevertCommit[] = [];
  for (const entry of output.split("\x1e")) {
    const [sha, message] = entry.trim().split("\x1f");
    if (!sha || message === undefined) continue;
    const reverts = [...message.matchAll(REVERTS_COMMIT_RE)].map((match) => match[1]!);
    if (reverts.length > 0) commits.push({ sha, reverts });
  }
  return commits;
}

const REVERT_BODY_RE = /\bReverts\s+([\w.-]+\/[\w.-]+)?#(\d+)\b/gi;
const REVERT_BRANCH_RE = /^revert-(\d+)-/;

/** The PR numbers one merged revert PR undid: `Reverts <repo>#N` in its body, or `revert-N-…` as its head. */
export function revertedNumbers(revert: RevertPr, repoSlug: string): number[] {
  const numbers = new Set<number>();
  for (const match of revert.body.matchAll(REVERT_BODY_RE)) {
    const repo = match[1];
    if (repo !== undefined && repo.toLowerCase() !== repoSlug.toLowerCase()) continue;
    numbers.add(Number(match[2]));
  }
  const branch = REVERT_BRANCH_RE.exec(revert.headRefName);
  if (branch !== null) numbers.add(Number(branch[1]));
  return [...numbers];
}

/**
 * What reverted each PR, found from the revert side: a reverted PR's own
 * timeline carries nothing (#916). A merged revert PR names it, and a revert
 * commit names its merge commit or one of its commits.
 */
export function revertsOf(opts: {
  prs: readonly ObservedPr[];
  revertPrs: readonly RevertPr[];
  revertCommits: readonly RevertCommit[];
  repoSlug: string;
}): Map<number, string> {
  const reverted = new Map<number, string>();
  for (const revert of opts.revertPrs) {
    if (!revert.merged) continue;
    for (const number of revertedNumbers(revert, opts.repoSlug)) {
      if (number !== revert.number && !reverted.has(number)) {
        reverted.set(number, `#${revert.number}`);
      }
    }
  }
  for (const pr of opts.prs) {
    if (pr.state !== "merged" || reverted.has(pr.number)) continue;
    const shas = [pr.mergeCommitOid, ...pr.commits.map((commit) => commit.oid)].filter(
      (sha): sha is NonNullable<typeof sha> => sha !== null,
    );
    const hit = opts.revertCommits.find((commit) =>
      commit.reverts.some((prefix) => shas.some((sha) => sha.startsWith(prefix))),
    );
    if (hit !== undefined) reverted.set(pr.number, hit.sha.slice(0, 7));
  }
  return reverted;
}

/** The signals of one settled PR; `null` while it is open. */
export function signalsOf(opts: {
  pr: ObservedPr;
  runs: readonly BranchWorkflowRun[];
  revertedBy: string | null;
  phoebe: string | null;
}): PrSignals | null {
  const { pr } = opts;
  if (pr.state === "open") return null;
  return {
    number: pr.number,
    state: pr.state,
    changesRequested: pr.changesRequested,
    reviewThreads: pr.reviewThreads,
    outsideCommits: outsideCommitCount(pr.commits, opts.phoebe),
    failedRuns: failedRunCount(opts.runs, pr),
    hoursToMerge:
      pr.mergedAt === null
        ? null
        : Math.floor((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / HOUR_MS),
    revertedBy: opts.revertedBy,
  };
}

/** A PR that is an observer proposal, or that works one. Grading it would be self-grading. */
export function isProposalPr(pr: ObservedPr, proposalIssues: ReadonlySet<number>): boolean {
  return (
    pr.labels.includes(PROPOSAL_LABEL) ||
    pr.body.includes(MARKER_TEXT) ||
    pr.closingIssues.some((number) => proposalIssues.has(number))
  );
}

const ISSUE_REF_RE = /^issue:(\d+)$/;

/** A unit that ran on an observer proposal's issue. */
export function isProposalUnit(record: UnitRecord, proposalIssues: ReadonlySet<number>): boolean {
  const match = ISSUE_REF_RE.exec(record.unit.id);
  return match !== null && proposalIssues.has(Number(match[1]));
}

/**
 * The PR a record with only a branch worked: the newest one on that branch
 * that was open at some point during the unit. A PR opened after the unit
 * settled, or closed before it started, belongs to some other run.
 */
export function branchPrFor(
  record: UnitRecord,
  candidates: readonly BranchPr[],
  now: Date,
): BranchPr | null {
  const started = Date.parse(record.startedAt);
  const settled = record.settledAt === null ? now.getTime() : Date.parse(record.settledAt);
  let best: BranchPr | null = null;
  for (const pr of candidates) {
    if (Date.parse(pr.createdAt) > settled) continue;
    if (pr.closedAt !== null && Date.parse(pr.closedAt) < started) continue;
    if (best === null || Date.parse(pr.createdAt) > Date.parse(best.createdAt)) best = pr;
  }
  return best;
}

/** One unit's PR, as the flagging reads it. */
export type UnitPrOutcome = {
  /** The PR is an observer proposal or works one: never flag the unit. */
  proposal: boolean;
  /** `null` while the PR is open. */
  signals: PrSignals | null;
  flags: PrFlag[];
};

/** The reads the gather makes. */
export type PrOutcomeSource = Pick<
  GitHubClient,
  "branchPrs" | "observedPrs" | "revertPrs" | "branchWorkflowRuns"
>;

/** A unit in the lookback, with the stable key the flagging files it under. */
export type WindowUnit = { key: string; record: UnitRecord };

/**
 * Read what became of every PR the units worked and turn it into flags, keyed
 * by unit. A unit with no PR has no entry.
 */
export function gatherPrOutcomes(opts: {
  units: readonly WindowUnit[];
  github: PrOutcomeSource;
  /** Revert commits on the default branch since a date; may be empty. */
  revertCommits: (since: Date) => RevertCommit[];
  proposalIssues: ReadonlySet<number>;
  phoebe: string | null;
  repoSlug: string;
  /** Branches that are never a PR's head: the default branch, the workspace branch. */
  ignoredBranches: ReadonlySet<string>;
  now: Date;
}): Map<string, UnitPrOutcome> {
  const { units, github } = opts;

  const branches = [
    ...new Set(
      units.flatMap(({ record }) =>
        record.prNumber === null &&
        record.branch !== null &&
        !opts.ignoredBranches.has(record.branch)
          ? [record.branch]
          : [],
      ),
    ),
  ];
  const onBranch =
    branches.length === 0 ? new Map<string, BranchPr[]>() : github.branchPrs(branches);

  const prNumberOf = new Map<string, number>();
  for (const { key, record } of units) {
    if (record.prNumber !== null) {
      prNumberOf.set(key, record.prNumber);
      continue;
    }
    if (record.branch === null) continue;
    const pr = branchPrFor(record, onBranch.get(record.branch) ?? [], opts.now);
    if (pr !== null) prNumberOf.set(key, pr.number);
  }
  if (prNumberOf.size === 0) return new Map();

  const prs = github.observedPrs([...new Set(prNumberOf.values())]);
  const proposal = new Map(
    prs.map((pr) => [pr.number as number, isProposalPr(pr, opts.proposalIssues)]),
  );
  const settled = prs.filter((pr) => pr.state !== "open" && !proposal.get(pr.number));

  const merged = settled.filter((pr) => pr.state === "merged");
  let reverted = new Map<number, string>();
  if (merged.length > 0) {
    const since = new Date(Math.min(...merged.map((pr) => Date.parse(pr.createdAt))));
    reverted = revertsOf({
      prs: merged,
      revertPrs: github.revertPrs(since.toISOString().slice(0, 10)),
      revertCommits: opts.revertCommits(since),
      repoSlug: opts.repoSlug,
    });
  }

  const byNumber = new Map<number, UnitPrOutcome>();
  for (const pr of prs) {
    if (proposal.get(pr.number)) {
      byNumber.set(pr.number, { proposal: true, signals: null, flags: [] });
      continue;
    }
    const signals =
      pr.state === "open"
        ? null
        : signalsOf({
            pr,
            runs: github.branchWorkflowRuns(pr.headRefName),
            revertedBy: reverted.get(pr.number) ?? null,
            phoebe: opts.phoebe,
          });
    byNumber.set(pr.number, {
      proposal: false,
      signals,
      flags: signals === null ? [] : prFlagsOf(signals),
    });
  }

  const outcomes = new Map<string, UnitPrOutcome>();
  for (const [key, number] of prNumberOf) {
    const outcome = byNumber.get(number);
    if (outcome !== undefined) outcomes.set(key, outcome);
  }
  return outcomes;
}
