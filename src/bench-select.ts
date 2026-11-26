// `phoebe bench select` (#939; spec #925, decisions #921): pin a suite of
// fixtures from issues Phoebe already solved, so a later `bench run` can replay
// each one offline against other models, efforts or prompts.
//
// A fixture is only worth replaying if the merged PR is a fair answer key for
// the issue: one `issues` unit, Phoebe's own work start to finish, landed on the
// default branch from a tree we can name. Everything else is skipped with the
// reason, so an operator can see why an issue they expected is missing:
//
//   - merged into a feature branch, or stacked on another issue's PR — the PR's
//     diff then answers for more than its own issue, or starts from a tree that
//     never sat on the default branch
//   - more than one git identity committed to it — someone pushed to it beside
//     Phoebe, so the PR is no longer only what Phoebe produced
//   - blocked mid-way — the run that finished saw a conversation the replay
//     cannot reproduce turn by turn
//
// A fixture is also only worth replaying if its answer key still passes. Before
// pinning one, selection runs its baseline (#988): the merged PR's head through
// install, check and test with no agent (src/bench-run.ts). One that fails is
// skipped with the gate that failed; one that passes records when.
// `--no-baseline` skips the check for a quick selection.
//
// Selection reads GitHub and never writes to it. The one local write is a
// `git fetch` into the hub clone, which `baseSha` needs when the PR's head is no
// longer on any branch.

import type {
  BenchComment,
  BenchFixture,
  BenchGates,
  BenchSkip,
  BenchSuite,
} from "./contracts/bench.ts";
import { baselineFailure, describeBaselineFailure } from "./bench-report.ts";
import { hasBlockedMarker, PHOEBE_BLOCKED_LABEL } from "./blocked.ts";
import { asBranchRef, type PrNumber, type Sha } from "./branded.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import type {
  BenchIssueFacts,
  BenchPrFacts,
  GitHubClient,
  MergedPrRef,
  PrCommitAuthor,
} from "./github-client.ts";

/** The tenant settings selection reads. */
export type BenchSelectConfig = {
  repoSlug: string;
  defaultBranch: string;
  branchPrefix: string;
  researchLabel: string;
};

/** What the operator asked for: named issues, or a query over merged PRs. */
export type BenchSelectRequest =
  | { by: "issues"; issues: number[] }
  | { by: "query"; since: string | null; limit: number };

/** The GitHub reads selection makes. Nothing here writes. */
export type BenchSelectGitHub = Pick<
  GitHubClient,
  "listMergedPrs" | "mergedPrsForBranch" | "benchPrFacts" | "benchIssueFacts"
>;

/** How many merged PRs a query reads before filtering to issue branches. */
export const QUERY_READ_LIMIT = 1000;

/** Default `--limit`: fixtures in a queried suite. */
export const DEFAULT_SELECT_LIMIT = 20;

const STACKED_BODY_RE = /Stacked on PR #(\d+)/i;
const STACKED_COMMENT_RE = /⛓️ Blocked by #(\d+)/;
const BLOCKED_ACK_RE = /^<!--\s*phoebe-blocked-ack\s*-->/im;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The issue number an `issues` unit's branch names, or null for any other branch. */
export function issueNumberFromBranch(branchPrefix: string, branch: string): number | null {
  const match = new RegExp(`^${escapeRegExp(branchPrefix)}issue-(\\d+)$`).exec(branch);
  return match === null ? null : Number(match[1]);
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The issue as it read when the PR opened: comments posted later are left out. */
export function issueSnapshot(issue: BenchIssueFacts, prOpenedAt: string): BenchFixture["issue"] {
  const opened = Date.parse(prOpenedAt);
  const comments: BenchComment[] = issue.comments
    .filter((comment) => Date.parse(comment.createdAt) < opened)
    .map((comment) => ({
      author: comment.authorLogin,
      createdAt: comment.createdAt,
      body: comment.body,
    }));
  return { number: issue.number, title: issue.title, body: issue.body, comments };
}

/**
 * Why this PR is not a fixture, or `null` when it is one. Pure: every fact it
 * judges is already read. The order is the order a reason is most useful in —
 * where the PR landed first, then how it got there.
 */
export function skipReason(opts: {
  issueNumber: number;
  pr: BenchPrFacts;
  issue: BenchIssueFacts;
  config: BenchSelectConfig;
}): string | null {
  const { issueNumber, pr, issue, config } = opts;
  if (!pr.merged || pr.mergeCommitOid === null) return `PR #${pr.number} did not merge`;

  const expectedHead = `${config.branchPrefix}issue-${issueNumber}`;
  if (pr.headRefName !== expectedHead) {
    return `PR #${pr.number} came from ${pr.headRefName}, not ${expectedHead}`;
  }

  if (pr.baseRefName !== config.defaultBranch) {
    if (pr.baseRefName.startsWith(`${config.branchPrefix}feature-`)) {
      return `on a feature branch: PR #${pr.number} merged into ${pr.baseRefName}, not ${config.defaultBranch}`;
    }
    if (issueNumberFromBranch(config.branchPrefix, pr.baseRefName) !== null) {
      return `stacked: PR #${pr.number} merged into ${pr.baseRefName}, not ${config.defaultBranch}`;
    }
    return `PR #${pr.number} merged into ${pr.baseRefName}, not ${config.defaultBranch}`;
  }

  const stackedBody = STACKED_BODY_RE.exec(pr.body);
  if (stackedBody !== null) return `stacked: PR #${pr.number} sat on PR #${stackedBody[1]}`;
  const stackedComment = pr.commentBodies
    .map((body) => STACKED_COMMENT_RE.exec(body))
    .find((match) => match !== null);
  if (stackedComment !== undefined && stackedComment !== null) {
    return `stacked: PR #${pr.number} waited on #${stackedComment[1]}`;
  }
  if (pr.baseRefChanged) {
    return `stacked: PR #${pr.number} was retargeted onto ${config.defaultBranch} after it opened`;
  }

  const others = pr.closingIssues.filter((number) => number !== issueNumber);
  if (others.length > 0) {
    return `PR #${pr.number} also closes ${others.map((number) => `#${number}`).join(", ")}`;
  }

  if (pr.commits.length === 0) return `PR #${pr.number} has no commits`;
  if (pr.commitsTruncated) {
    return `PR #${pr.number} has more commits than one read covers, so its authors cannot all be checked`;
  }
  // Only Phoebe's commits means one git identity across the PR. Which identity
  // is Phoebe's is not something the PR says: a deployment can commit as
  // "Phoebe" with its PAT owner's email, so the GitHub login is the same for
  // Phoebe and for the person whose token it runs on, and a person may start
  // the branch. Two identities on one PR is the fact that can be read, so the
  // reason names both and leaves the operator to say which was Phoebe.
  const identity = (commit: PrCommitAuthor): string =>
    `${commit.authorName} <${commit.authorEmail.toLowerCase()}>`;
  const first = pr.commits[0]!;
  const foreign = pr.commits.find((commit) => identity(commit) !== identity(first));
  if (foreign !== undefined) {
    return (
      `more than one author pushed to PR #${pr.number}: ` +
      `${first.authorName} <${first.authorEmail}> (${shortSha(first.oid)}) and ` +
      `${foreign.authorName} <${foreign.authorEmail}> (${shortSha(foreign.oid)})`
    );
  }

  if ([...issue.labels, ...issue.labelsEverAdded].includes(config.researchLabel)) {
    return `a research ticket (${config.researchLabel}), not an issues unit`;
  }

  if ([...issue.labels, ...issue.labelsEverAdded].includes(PHOEBE_BLOCKED_LABEL)) {
    return `blocked mid-way: the issue was labelled ${PHOEBE_BLOCKED_LABEL}`;
  }
  const blockedComment = issue.comments.find(
    (comment) => hasBlockedMarker(comment.body) || BLOCKED_ACK_RE.test(comment.body),
  );
  if (blockedComment !== undefined) {
    return `blocked mid-way: a run stopped for a person on ${blockedComment.createdAt}`;
  }
  return null;
}

/**
 * The commit the PR started from: the merge-base of its head and the merge
 * commit's first parent, computed in the hub clone.
 *
 * For a squash or merge commit the first parent is the default branch just
 * before the PR landed, so the merge-base is where the PR's branch left it (or
 * last caught up with it). The PR head and the merge commit are fetched only
 * when the clone lacks them — a merged PR's branch is usually deleted, but
 * `refs/pull/<n>/head` keeps its head.
 */
export function computeBaseSha(opts: {
  repoDir: string;
  prNumber: PrNumber | number;
  headSha: string;
  mergeSha: string;
  defaultBranch: string;
  git?: GitRunner;
}): Sha {
  const git = opts.git ?? defaultGit;
  const cwd = opts.repoDir;
  const has = (sha: string): boolean => {
    try {
      git(["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!has(opts.headSha) || !has(opts.mergeSha)) {
    git(
      [
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "origin",
        `refs/pull/${opts.prNumber}/head`,
        opts.defaultBranch,
      ],
      { cwd, stdio: "pipe" },
    );
  }
  const parent = git(["rev-parse", "--verify", `${opts.mergeSha}^1`], { cwd }).trim();
  return git(["merge-base", opts.headSha, parent], { cwd }).trim() as Sha;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

/** One issue judged: a fixture, or the reason it is not one. */
type Judged = { fixture: BenchFixture } | { skip: BenchSkip };

/**
 * Runs a fixture's baseline and returns its gates; throws when the merged
 * head cannot be checked out.
 */
export type BenchSelectBaseline = (fixture: BenchFixture) => Promise<BenchGates>;

async function judge(opts: {
  issueNumber: number;
  pr: MergedPrRef;
  github: BenchSelectGitHub;
  config: BenchSelectConfig;
  baseShaOf: (pr: BenchPrFacts) => string;
  baseline: BenchSelectBaseline | null;
  now: () => Date;
}): Promise<Judged> {
  const { issueNumber, config } = opts;
  const skip = (reason: string): Judged => ({
    skip: { issue: issueNumber, pr: opts.pr.number, reason },
  });
  let facts: BenchPrFacts;
  let issue: BenchIssueFacts;
  try {
    facts = opts.github.benchPrFacts(opts.pr.number);
    issue = opts.github.benchIssueFacts(issueNumber);
  } catch (error) {
    return skip(`could not read it from GitHub: ${errorText(error)}`);
  }
  const reason = skipReason({ issueNumber, pr: facts, issue, config });
  if (reason !== null) return skip(reason);

  let baseSha: string;
  try {
    baseSha = opts.baseShaOf(facts);
  } catch (error) {
    return skip(`could not compute baseSha in the hub clone: ${errorText(error)}`);
  }
  const fixture: BenchFixture = {
    issue: issueSnapshot(issue, facts.createdAt),
    pr: { number: facts.number, headSha: facts.headRefOid, mergeSha: facts.mergeCommitOid! },
    baseSha,
  };
  if (opts.baseline === null) return { fixture };

  let gates: BenchGates;
  try {
    gates = await opts.baseline(fixture);
  } catch (error) {
    return skip(`its baseline could not run: ${errorText(error)}`);
  }
  const failure = baselineFailure(gates);
  if (failure !== null) {
    return skip(`its merged PR no longer passes: ${describeBaselineFailure(failure)}`);
  }
  return { fixture: { ...fixture, baselinePassedAt: opts.now().toISOString() } };
}

/**
 * Build the suite. `--issues` judges each named issue by its one merged PR on
 * `<branchPrefix>issue-<n>`. A query walks merged PRs on issue branches, newest
 * merge first, until `limit` fixtures qualify; the issues it skipped on the way
 * are listed, the ones it never reached are not.
 *
 * With `baseline`, each candidate that passes every other check runs its
 * baseline, one at a time, and only one that passes is pinned. `null` pins
 * without running gates, and the fixtures carry no `baselinePassedAt`.
 */
export async function selectSuite(opts: {
  github: BenchSelectGitHub;
  config: BenchSelectConfig;
  request: BenchSelectRequest;
  baseShaOf: (pr: BenchPrFacts) => string;
  baseline: BenchSelectBaseline | null;
  now?: () => Date;
}): Promise<BenchSuite> {
  const { github, config, request } = opts;
  const now = opts.now ?? (() => new Date());
  const judgeOne = (issueNumber: number, pr: MergedPrRef): Promise<Judged> =>
    judge({
      issueNumber,
      pr,
      github,
      config,
      baseShaOf: opts.baseShaOf,
      baseline: opts.baseline,
      now,
    });
  const fixtures: BenchFixture[] = [];
  const skipped: BenchSkip[] = [];
  const take = (judged: Judged): void => {
    if ("fixture" in judged) fixtures.push(judged.fixture);
    else skipped.push(judged.skip);
  };
  const ambiguous = (issueNumber: number, prs: readonly MergedPrRef[]): BenchSkip => ({
    issue: issueNumber,
    pr: null,
    reason:
      `${prs.length} merged PRs came from ${config.branchPrefix}issue-${issueNumber} ` +
      `(${prs.map((pr) => `#${pr.number}`).join(", ")}); a fixture needs exactly one`,
  });

  if (request.by === "issues") {
    for (const issueNumber of [...new Set(request.issues)]) {
      const branch = asBranchRef(`${config.branchPrefix}issue-${issueNumber}`);
      let prs: MergedPrRef[];
      try {
        prs = github.mergedPrsForBranch(branch).filter((pr) => pr.headRefName === branch);
      } catch (error) {
        skipped.push({
          issue: issueNumber,
          pr: null,
          reason: `could not list its PRs: ${errorText(error)}`,
        });
        continue;
      }
      if (prs.length === 0) {
        skipped.push({ issue: issueNumber, pr: null, reason: `no merged PR came from ${branch}` });
      } else if (prs.length > 1) {
        skipped.push(ambiguous(issueNumber, prs));
      } else {
        take(await judgeOne(issueNumber, prs[0]!));
      }
    }
  } else {
    const byIssue = new Map<number, MergedPrRef[]>();
    for (const pr of github.listMergedPrs({ since: request.since, limit: QUERY_READ_LIMIT })) {
      const issueNumber = issueNumberFromBranch(config.branchPrefix, pr.headRefName);
      if (issueNumber === null) continue;
      byIssue.set(issueNumber, [...(byIssue.get(issueNumber) ?? []), pr]);
    }
    for (const [issueNumber, prs] of byIssue) {
      if (fixtures.length >= request.limit) break;
      if (prs.length > 1) {
        skipped.push(ambiguous(issueNumber, prs));
        continue;
      }
      take(await judgeOne(issueNumber, prs[0]!));
    }
  }

  return {
    v: 1,
    repo: config.repoSlug,
    selectedAt: now().toISOString(),
    selection:
      request.by === "issues"
        ? { by: "issues", issues: [...new Set(request.issues)] }
        : { by: "query", since: request.since, limit: request.limit },
    fixtures,
    skipped,
  };
}
