// The engine's GitHub client — every `gh` spawn the loop makes, behind methods
// named for what the loop wants rather than for the transport underneath.
//
// The loop asks for `listReadyIssues()` or `reviewThreads(pr)`; argv, the
// `-R <repoSlug>` pin, `--json` field lists, GraphQL pagination, the merge-state
// retry and error enrichment are all implementation. That is what makes the
// cycle testable: a test hands `main.ts` an object literal holding only the
// methods it touches, with no canned `gh` output anywhere. See
// docs/research/engine-runtime-seam.md for the seam's rationale, the rejected
// shapes (thin transport, loop-shaped `WorkSource`) and why it stays synchronous.
//
// Two things deliberately stay outside:
//   • src/gh-error.ts — pure classification, usable by anything that shells out.
//   • the executor seam below — internal, for this module's own tests only.

import { execFileSync } from "node:child_process";
import { withBackoffSync, type SleepSync } from "./backoff.ts";
import {
  asBranchRef,
  asPrNumber,
  asSha,
  type BranchRef,
  type PrNumber,
  type Sha,
} from "./branded.ts";
import type { GitHubUser } from "./co-author.ts";
import type { PhoebeConfig } from "./config-schema.ts";
import {
  featureBranch,
  parseFeatureIssueNumber,
  type IntegrationPr,
  type IssueGraphNode,
} from "./feature-branch.ts";
import type { MergedMemberPr } from "./feature-closes.ts";
import { classifyGhError, describeGhError, isTransientGhError } from "./gh-error.ts";
import {
  isCompletedBlockerIssue,
  isPrInScope,
  issueBranch,
  type BlockerPrState,
  type Issue,
  type ReviewThread,
  type WorkflowRunItem,
} from "./orchestrator.ts";
import {
  issueContentBaseline,
  parseUnitTimeoutMarker,
  PHOEBE_QUARANTINE_LABEL,
} from "./quarantine.ts";

// Never let a `gh` child block the loop forever (rate-limit backoff, credential
// prompt, network partition). Mirrors the git-side bound in main.ts; the two are
// separate knobs because a `gh` call and a `git` call fail differently.
const CHILD_PROCESS_TIMEOUT_MS = 120_000;
// GitHub computes mergeability server-side and answers UNKNOWN while it works,
// so a first read on a freshly-pushed PR routinely says nothing useful. That is
// a GitHub quirk, not loop knowledge, which is why the retry lives here.
const MERGEABLE_RETRY_MS = 5_000;
const MERGEABLE_RETRY_COUNT = 3;
// GitHub 5xx / network blips heal in seconds, and without a retry one costs a
// whole cycle (a failed unit) or an engine restart (a failed gather). Two
// retries, 2s then 8s: enough to outlive a blip, short enough that a real
// outage still fails this cycle rather than stalling the loop.
const TRANSIENT_RETRY_SCHEDULE_MS = [2_000, 8_000];

// ---------------------------------------------------------------------------
// Data the loop reads
// ---------------------------------------------------------------------------

/**
 * Which GitHub object a write addresses — `gh issue …` vs `gh pr …`. Deliberately
 * not called a "kind": that word is taken by the work kinds (CONTEXT.md), and a
 * `conflicts` unit and a `checks` unit are both a `pr` here.
 */
export type UnitTarget = { objectType: "issue" | "pr"; id: number };

/**
 * An open PR inside this tenant's configured scope. `authorLogin` is `null` when
 * the PR has no author — a deleted account, which `gh` reports as an empty login.
 */
export type OpenPhoebePr = {
  number: PrNumber;
  headRefName: BranchRef;
  authorLogin: string | null;
};

/**
 * What came of asking GitHub to stack a PR natively. `stacked: false` is an
 * outcome, not an error: the Stacks API is a public preview (2026-07) and a
 * host without it answers 404 — the caller falls back to the banner flow.
 */
export type StackPrOutcome =
  | { stacked: true; stackNumber: number }
  | { stacked: false; reason: string };

/**
 * What came of asking GitHub to remove a PR from its native stack.
 * `unstacked: false` with `reason: "not-in-stack"` is the normal result for a
 * PR that was never stacked or was already removed; other reasons are errors.
 */
export type UnstackPrOutcome =
  | { unstacked: true; stackNumber: number }
  | { unstacked: false; reason: string };

/**
 * An open integration PR sitting on a feature branch, as the `Closes` sweep
 * reads it: the PR to edit, the feature whose members it collects, and the body
 * the sweep maintains one block of.
 */
export type FeatureIntegrationPr = {
  number: PrNumber;
  /** The feature's parent issue number, read back out of the head branch. */
  featureIssueNumber: number;
  body: string;
  /** Label names, read so `prOptOutLabel` here can take the whole feature out of janitor scope. */
  labels: readonly string[];
};

/**
 * An open Phoebe PR whose base targets another Phoebe issue branch — a PR in a
 * native stack. Returned by `listNativelyStackedPrs` for the stale-stack sweep.
 */
export type StackedPhoebePr = {
  number: PrNumber;
  headRefName: BranchRef;
  /** The Phoebe issue branch this PR sits on top of in the stack. */
  baseRefName: BranchRef;
};

export type PrMergeInfo = {
  number: PrNumber;
  headRefName: BranchRef;
  headRefOid: Sha;
  mergeable: string;
  mergeStateStatus: string;
};

/**
 * One comment on an issue or PR. A deleted account has no login, which reads
 * here as `null`: nobody's login, so it can never compare equal to Phoebe's own
 * (which is always a resolved, non-empty string wherever the two meet). The
 * placeholder `""` this used to carry could not make that promise — it read as a
 * login, and an unresolved Phoebe login was the same `""`.
 */
export type GhComment = { body: string; createdAt: string; authorLogin: string | null };

export type UnitTimeoutInputs = {
  /** Comments (body + createdAt + authorLogin), oldest-first — fed to `decideTimeoutRecord`. */
  comments: GhComment[];
  /** Extra external-activity instant (a PR head push), or null — a further reset signal. */
  extraActivityAt: string | null;
  /** Recorded in the escalation comment for the future auto-un-stick sweep. */
  baseline: string;
};

export type QuarantinedUnit = {
  target: UnitTarget;
  /** The unit's content right now — a PR head SHA, or an issue body fingerprint. */
  currentBaseline: string;
  comments: Array<{ body: string }>;
};

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export type GitHubClient = {
  // Issues
  listReadyIssues(): Issue[];
  listResearchIssues(): Issue[];
  /** Open issues carrying `label` — the general listing custom issue-keyed
   *  producers build on; the two methods above are its fixed-label views. */
  listLabeledIssues(label: string): Issue[];
  issueBody(issueNumber: number): string;
  blockerPrState(blockerIssueNumber: number): BlockerPrState;
  /**
   * One issue as the feature-membership walk reads it (#341): its labels, body,
   * open/closed state, and its native sub-issue parent. REST rather than
   * `gh issue view` — the parent link is `parent_issue_url` on the REST payload
   * and `--json` exposes no field for it.
   */
  issueGraphNode(issueNumber: number): IssueGraphNode;
  /**
   * The PR on a feature's integration branch, or `null` when there is none yet.
   * An open one always wins: a feature is live while a PR on its branch is open,
   * whatever closed PRs the branch accumulated before it.
   */
  featureIntegrationPr(featureIssueNumber: number): IntegrationPr | null;
  /**
   * Ensure the feature integration branch exists on origin; create it from
   * `origin/<defaultBranch>` when it does not. Idempotent: a 422 (reference
   * already exists) is swallowed.
   */
  createFeatureBranch(featureIssueNumber: number): void;
  /**
   * Ensure the draft integration PR for a feature exists; create it when it
   * does not. Idempotent: checks for an existing open PR on the branch first.
   * Phoebe never undrafts, merges, or closes this PR — those are human acts.
   */
  ensureDraftIntegrationPr(featureIssueNumber: number, featureIssueTitle: string): void;
  /**
   * Every open PR whose head is a feature integration branch — one entry per
   * live feature, whatever state its members are in. The `Closes` sweep's
   * starting point.
   */
  listFeatureIntegrationPrs(): FeatureIntegrationPr[];
  /**
   * The member PRs that have merged into a feature's branch. Merged only:
   * a member PR closed unmerged put no work on the branch, so it earns no
   * `Closes` line.
   */
  listMergedMemberPrs(featureIssueNumber: number): MergedMemberPr[];

  // Pull requests
  /**
   * Every open PR the janitors may work: the ones based on `defaultBranch`,
   * plus the members of each live feature branch — one listing per feature, all
   * of them through the same `isPrInScope` filter.
   */
  listOpenPhoebePrs(): OpenPhoebePr[];
  /**
   * A PR's merge state, read fresh every call. The cycle client's `mergeInfo` is
   * the one to use during discovery; this is for the re-check after an agent has
   * run, where a memo taken before the run would answer the wrong question.
   */
  currentMergeInfo(prNumber: PrNumber): PrMergeInfo;
  /** Every comment body on a PR, oldest first — the raw input to every watermark parse. */
  prCommentBodies(prNumber: PrNumber): string[];
  commitCheckItems(headSha: Sha): WorkflowRunItem[];
  /** Every review thread on a PR — paginated internally, so callers see one list. */
  reviewThreads(prNumber: PrNumber): ReviewThread[];
  reviewSummaryComments(prNumber: PrNumber): GhComment[];
  /** The open PR on this issue's Phoebe branch, or null when there is none. */
  findIssuePr(issueNumber: number): PrNumber | null;
  createPr(opts: { head: BranchRef; base: string; title: string; body: string }): void;
  /**
   * Put a PR into its blocker PR's native stack — joining the blocker's
   * existing stack, or founding one (blocker at the bottom) when it has none.
   * Never throws: an unavailable Stacks API is a `stacked: false` outcome.
   */
  stackPrOnto(prNumber: PrNumber, blockerPrNumber: PrNumber): StackPrOutcome;
  /** Rewrite a PR's base branch (`gh pr edit --base`). */
  retargetPr(prNumber: PrNumber, base: string): void;
  /**
   * Open Phoebe PRs whose base is another Phoebe issue branch — the ones that
   * are natively stacked and have not yet been retargeted to the default branch.
   * Used by the stale-stack sweep to find PRs whose blocker completed without
   * merging.
   */
  listNativelyStackedPrs(): StackedPhoebePr[];
  /**
   * Remove a PR from its native stack. Returns the stack number when the PR was
   * in a stack and was removed, or a reason when it was not.
   * Never throws: an unavailable Stacks API is an `unstacked: false` outcome.
   */
  unstackPr(prNumber: PrNumber): UnstackPrOutcome;

  // Quarantine + timeouts
  listQuarantinedIssues(): QuarantinedUnit[];
  listQuarantinedPrs(): QuarantinedUnit[];
  issueTimeoutInputs(issueNumber: number): UnitTimeoutInputs;
  prTimeoutInputs(prNumber: PrNumber): UnitTimeoutInputs;

  // Writes
  /** Replace a PR's body wholesale (`gh pr edit --body-file -`). */
  updatePrBody(prNumber: PrNumber, body: string): void;
  postPrComment(prNumber: PrNumber, body: string): void;
  postUnitComment(target: UnitTarget, body: string): void;
  addQuarantineLabel(target: UnitTarget): void;
  removeQuarantineLabel(target: UnitTarget): void;
  /**
   * Add `label` to an issue. Uses a captured (non-inherited) exec so the
   * caller can inspect the error with `isLabelNotFoundError` when the label
   * does not exist in the repository.
   */
  /** Current label names on an issue, fetched fresh. Used by `claimIssue` to detect a prior claim. */
  issueLabels(issueNumber: number): string[];
  addIssueLabel(issueNumber: number, label: string): void;
  /** Remove `label` from an issue. */
  removeIssueLabel(issueNumber: number, label: string): void;
  /**
   * Create `label` in the repository with the defaults Phoebe uses for its
   * own markers — yellow (`FBCA04`) and a "Phoebe is working this issue"
   * description. Called only after a `isLabelNotFoundError` to self-heal a
   * missing `processingLabel` before retrying the add.
   */
  createLabel(name: string): void;

  // Identity
  /**
   * Phoebe's own login. `envLogin` (PHOEBE_GH_LOGIN) wins whenever it is set —
   * `gh api user` 403s under an installation token, so the call is a fallback
   * for the PAT arm, never the primary source.
   */
  resolveLogin(envLogin: string | undefined): string;
  /**
   * The author login on the newest comment that carries a phoebe-unit-timeout
   * marker anywhere in this repo — Phoebe's clearest historical fingerprint.
   * Used at boot to check for login identity drift (#346). Returns `null` when
   * no such comment exists or the comment's author account was deleted.
   */
  newestUnitMarkerAuthor(): string | null;
  issueAuthorLogin(issueNumber: number): string | null;
  lookupUser(login: string): GitHubUser;

  // Cycle scope
  forCycle(): CycleGitHubClient;
};

/**
 * The client scoped to one poll. Adds the memo that used to be a hand-threaded
 * `CycleCache`: its lifetime is this object's lifetime, so there is no
 * `beginCycle()` to forget and no way to read one cycle's answers in the next.
 */
export type CycleGitHubClient = Omit<
  GitHubClient,
  "listOpenPhoebePrs" | "currentMergeInfo" | "forCycle"
> & {
  /** `listOpenPhoebePrs`, listed once per cycle. */
  openPrs(): OpenPhoebePr[];
  /** Merge state, memoized for this cycle and retried while GitHub says UNKNOWN. */
  mergeInfo(prNumber: PrNumber): Promise<PrMergeInfo>;
};

/**
 * The one reading of a GitHub author this client makes: `null` for nobody.
 * `gh` reports a deleted account either as a null `author` object (comments) or
 * as an author whose login is `""` (pull requests), and both mean the same
 * thing — there is no account to name. Collapsing them here is what lets every
 * caller compare a login with `===` and be right.
 */
function noLoginAsNull(author: { login: string } | null | undefined): string | null {
  return author?.login ? author.login : null;
}

/** What a caught `unknown` reads as in a warning line. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The issue number in a REST `parent_issue_url`, or `null` when there is no
 * parent. A parent in another repository also reads as `null`: Phoebe works one
 * repo, so it could neither branch from nor open a PR against the other one,
 * and treating that link as membership would route work onto a branch that does
 * not exist here.
 */
export function parseParentIssueUrl(
  url: string | null | undefined,
  repoSlug: string,
): number | null {
  if (!url) {
    return null;
  }
  const match = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
  if (!match || match[1]!.toLowerCase() !== repoSlug.toLowerCase()) {
    return null;
  }
  return Number(match[2]);
}

/**
 * The integration PR among the PRs a feature branch has carried: the open one
 * if there is one, else the newest. `gh` reports states as OPEN/CLOSED/MERGED.
 */
export function pickIntegrationPr(
  rows: ReadonlyArray<{ number: number; state: string }>,
): IntegrationPr | null {
  const byNewest = [...rows].sort((a, b) => b.number - a.number);
  const chosen = byNewest.find((row) => row.state.toUpperCase() === "OPEN") ?? byNewest[0];
  if (!chosen) {
    return null;
  }
  const state = chosen.state.toUpperCase();
  return {
    number: asPrNumber(chosen.number),
    state: state === "OPEN" || state === "MERGED" ? state : "CLOSED",
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * How the client spawns `gh`. Internal: it is not reachable through
 * `GitHubClient`, and only src/github-client.test.ts substitutes it — the loop's
 * tests double the interface above, where no argv exists to get wrong.
 *
 * `inherit` streams the child's output to the engine's own stdio and yields no
 * captured stdout; without it the call is captured and its stderr is available
 * on the thrown error for classification.
 */
export type GhExecutor = (
  args: readonly string[],
  opts?: { input?: string; inherit?: boolean },
) => string;

function createGhExecutor(env: NodeJS.ProcessEnv): GhExecutor {
  return (args, opts) => {
    if (opts?.inherit) {
      execFileSync("gh", [...args], {
        env,
        stdio: opts.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
        timeout: CHILD_PROCESS_TIMEOUT_MS,
        ...(opts.input !== undefined ? { input: opts.input } : {}),
      });
      return "";
    }
    return execFileSync("gh", [...args], {
      env,
      encoding: "utf8",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    }) as unknown as string;
  };
}

/**
 * Probe `gh api rate_limit` to get the current reset time for a bucket.
 * Best-effort: the `/rate_limit` endpoint uses its own quota and succeeds even
 * when "graphql" or "core" is exhausted, but we swallow any failure rather than
 * crashing the already-failing path.
 */
function tryFetchRateLimitReset(resource: "graphql" | "core", exec: GhExecutor): Date | null {
  try {
    type RateLimitResponse = {
      resources: { core: { reset: number }; graphql: { reset: number } };
    };
    const data = JSON.parse(exec(["api", "rate_limit"])) as RateLimitResponse;
    const epoch = data.resources[resource].reset;
    const d = new Date(epoch * 1000);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Always throws.  Reclassifies a `gh` CLI error as a rate-limit or permission
 * message when the stderr carries enough signal; otherwise rethrows the original.
 * A null classification (no signal) also rethrows the original so callers always
 * see the most informative available error.
 */
function rethrowAsGhError(error: unknown, ghArgs: readonly string[], exec: GhExecutor): never {
  const c = classifyGhError(error, ghArgs);
  if (c !== null) {
    if (c.kind === "rate-limit") {
      const resetAt = c.resource ? tryFetchRateLimitReset(c.resource, exec) : null;
      throw new Error(describeGhError({ ...c, resetAt }));
    }
    throw new Error(describeGhError(c));
  }
  throw error instanceof Error ? error : new Error(String(error));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type CreateGitHubClientOptions = {
  /**
   * This tenant's resolved config — the source of `repoSlug`, the work labels and
   * the PR base. Note that two pure helpers the client calls (`issueBranch`,
   * `isPrInScope`) still read the `resolved-config.ts` Proxy for `branchPrefix`
   * and the PR scope rather than this value; in production they are the same
   * object. `main.ts` no longer reads the Proxy (#280); orchestrator.ts is what
   * keeps it alive.
   */
  config: PhoebeConfig;
  /**
   * Environment handed to every `gh` child. Pass the live `process.env` (or a
   * superset of it): the loop rewrites `GH_TOKEN` in place on each credential
   * lease, and `gh` needs the ambient `PATH`/`HOME` to run and find its config.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Internal seam for src/github-client.test.ts. Not part of `GitHubClient` and
   * not for production callers: the whole point of the interface above is that
   * a caller never has to know a subprocess is involved.
   */
  internal?: { exec?: GhExecutor; sleep?: (ms: number) => Promise<void>; sleepSync?: SleepSync };
};

export function createGitHubClient({
  config,
  env,
  internal,
}: CreateGitHubClientOptions): GitHubClient {
  const rawExec = internal?.exec ?? createGhExecutor(env);
  const sleep = internal?.sleep ?? defaultSleep;

  /**
   * The transport every method below actually calls: `rawExec` plus a retry on
   * transient GitHub failures. Only captured calls retry — an inherited-stdio
   * call yields no stderr to classify, and those are exactly the writes
   * (comments, labels, `pr create`) where a blind retry after an ambiguous
   * failure could double-post. Synchronous sleep, like the seam itself.
   */
  const exec: GhExecutor = (args, opts) => {
    if (opts?.inherit) {
      return rawExec(args, opts);
    }
    return withBackoffSync(() => rawExec(args, opts), {
      scheduleMs: TRANSIENT_RETRY_SCHEDULE_MS,
      isRetryable: isTransientGhError,
      onRetry: (error, delayMs, retry) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[phoebe] Transient GitHub failure on \`gh ${args[0] ?? ""}\` — retrying in ${delayMs / 1000}s ` +
            `(retry ${retry}/${TRANSIENT_RETRY_SCHEDULE_MS.length}): ${message}`,
        );
      },
      ...(internal?.sleepSync ? { sleepSync: internal.sleepSync } : {}),
    });
  };

  /** A repo-scoped read: `-R <repoSlug>` is appended so no caller can forget it. */
  function ghJson<T>(args: readonly string[]): T {
    try {
      return JSON.parse(exec([...args, "-R", config.repoSlug])) as T;
    } catch (error) {
      rethrowAsGhError(error, args, exec);
    }
  }

  /** A REST call. The endpoint names the resource, so these carry no `-R`. */
  function ghApiJson<T>(endpoint: string): T {
    const args = ["api", endpoint];
    try {
      return JSON.parse(exec(args)) as T;
    } catch (error) {
      rethrowAsGhError(error, args, exec);
    }
  }

  /**
   * A repo-scoped write. Output streams through to the engine's log, which means
   * no stderr is captured — so, as before the extraction, a failed write throws
   * the raw `gh` error rather than a classified one.
   */
  function ghWrite(args: readonly string[], opts?: { input?: string }): void {
    exec([...args, "-R", config.repoSlug], {
      inherit: true,
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    });
  }

  /** Open issues carrying `label`, oldest-created first. Shared by `issues` and `research`. */
  function listIssuesWithLabel(label: string): Issue[] {
    type GhIssue = Omit<Issue, "labels"> & { labels: Array<{ name: string }> };
    return ghJson<GhIssue[]>([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      label,
      "--limit",
      "100",
      "--search",
      "sort:created-asc",
      "--json",
      "number,title,body,labels,createdAt",
    ]).map((row) => ({
      number: row.number,
      title: row.title,
      body: row.body,
      createdAt: row.createdAt,
      labels: row.labels.map((l) => l.name),
    }));
  }

  type GhTimeoutComment = { body: string; createdAt: string; author: { login: string } | null };

  function toTimeoutComments(comments: readonly GhTimeoutComment[]): GhComment[] {
    // `author` is null for a deleted account; keep that as `null` rather than
    // letting the deref throw and skip the whole timeout record.
    return comments.map((c) => ({
      body: c.body,
      createdAt: c.createdAt,
      authorLogin: noLoginAsNull(c.author),
    }));
  }

  function currentMergeInfo(prNumber: PrNumber): PrMergeInfo {
    const raw = ghJson<{
      number: number;
      headRefName: string;
      headRefOid: string;
      mergeable: string;
      mergeStateStatus: string;
    }>([
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,headRefName,headRefOid,mergeable,mergeStateStatus",
    ]);
    return {
      number: asPrNumber(raw.number),
      headRefName: asBranchRef(raw.headRefName),
      headRefOid: asSha(raw.headRefOid),
      mergeable: raw.mergeable,
      mergeStateStatus: raw.mergeStateStatus,
    };
  }

  type GraphQLReviewThreadsPage = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              isResolved: boolean;
              isOutdated: boolean;
              comments: {
                nodes: Array<{
                  createdAt: string;
                  author: { login: string } | null;
                }>;
              };
            }>;
          };
        };
      };
    };
  };

  function reviewThreads(prNumber: PrNumber): ReviewThread[] {
    const [owner, repo] = config.repoSlug.split("/");
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const afterArg = cursor ? `, after:"${cursor}"` : "";
      const query = `query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:100${afterArg}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first:30) {
            nodes {
              createdAt
              author { login }
            }
          }
        }
      }
    }
  }
}`;
      const graphqlArgs = [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `repo=${repo}`,
        "-F",
        `pr=${prNumber}`,
      ];
      let rawPage: string;
      try {
        rawPage = exec(graphqlArgs);
      } catch (error) {
        rethrowAsGhError(error, ["api", "graphql"], exec);
      }
      const page = JSON.parse(rawPage) as GraphQLReviewThreadsPage;

      const pageThreads = page.data.repository.pullRequest.reviewThreads;
      for (const node of pageThreads.nodes) {
        threads.push({
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          comments: node.comments.nodes.map((comment) => ({
            createdAt: comment.createdAt,
            authorLogin: noLoginAsNull(comment.author),
          })),
        });
      }
      hasNextPage = pageThreads.pageInfo.hasNextPage;
      cursor = pageThreads.pageInfo.endCursor;
      if (!hasNextPage) {
        break;
      }
    }

    return threads;
  }

  /**
   * Every open PR based on one branch, narrowed to what this tenant janitors.
   * The cycle calls it once per base: the default branch, then one live feature
   * branch at a time.
   */
  function openPrsBasedOn(base: string): OpenPhoebePr[] {
    type GhOpenPr = {
      number: number;
      headRefName: string;
      isDraft: boolean;
      isCrossRepository: boolean;
      labels: Array<{ name: string }>;
      author: { login: string } | null;
    };
    return ghJson<GhOpenPr[]>([
      "pr",
      "list",
      "--base",
      base,
      "--state",
      "open",
      "--json",
      "number,headRefName,isDraft,isCrossRepository,labels,author",
      "--limit",
      "100",
    ])
      .filter((pr) =>
        isPrInScope({
          headRefName: asBranchRef(pr.headRefName),
          isDraft: pr.isDraft,
          isCrossRepository: pr.isCrossRepository,
          labels: pr.labels.map((label) => label.name),
        }),
      )
      .map((pr) => ({
        number: asPrNumber(pr.number),
        headRefName: asBranchRef(pr.headRefName),
        authorLogin: noLoginAsNull(pr.author),
      }));
  }

  /**
   * The branch of every feature that is still live — the extra bases the
   * janitors' listing covers (#341, ticket #381). A member PR targets its
   * feature branch, so without this it is invisible to `conflicts`, `checks`
   * and `reviews`: red CI would sit red, nothing would merge it, and the
   * feature would stall in silence. That is a deliberate departure from the
   * natively-stacked PRs the janitors skip — GitHub maintains a stack, but
   * nothing maintains a feature branch's members.
   *
   * Liveness is the open integration PR, which is what `listFeatureIntegrationPrs`
   * returns one of per feature: a merged or closed integration PR retires the
   * feature and contributes no listing. `prOptOutLabel` on that PR is the
   * documented per-feature opt-out, so it takes the members out too — otherwise
   * the label would only quiet the integration PR while the janitors kept
   * working everything underneath it. Failing to enumerate the features costs
   * the feature branches this cycle, not the default branch's PRs.
   */
  function liveFeatureBranches(): BranchRef[] {
    try {
      return client
        .listFeatureIntegrationPrs()
        .filter((pr) => !pr.labels.includes(config.prOptOutLabel))
        .map((pr) => featureBranch(pr.featureIssueNumber));
    } catch (error) {
      console.warn(
        `[phoebe] Skipping feature-branch PRs this cycle — the integration PRs ` +
          `could not be listed: ${errorText(error)}`,
      );
      return [];
    }
  }

  const client: GitHubClient = {
    listReadyIssues: () => listIssuesWithLabel(config.readyLabel),

    listResearchIssues: () => listIssuesWithLabel(config.researchLabel),

    listLabeledIssues: listIssuesWithLabel,

    issueBody: (issueNumber) =>
      ghJson<{ body: string }>(["issue", "view", String(issueNumber), "--json", "body"]).body,

    issueGraphNode: (issueNumber) => {
      type RestIssue = {
        number: number;
        title: string;
        state: string;
        body: string | null;
        labels: Array<{ name: string }>;
        parent_issue_url?: string | null;
      };
      const raw = ghApiJson<RestIssue>(`repos/${config.repoSlug}/issues/${issueNumber}`);
      return {
        number: raw.number,
        title: raw.title,
        labels: raw.labels.map((label) => label.name),
        body: raw.body ?? "",
        closed: raw.state.toLowerCase() === "closed",
        parentNumber: parseParentIssueUrl(raw.parent_issue_url, config.repoSlug),
      };
    },

    featureIntegrationPr: (featureIssueNumber) =>
      pickIntegrationPr(
        ghJson<Array<{ number: number; state: string }>>([
          "pr",
          "list",
          "--head",
          featureBranch(featureIssueNumber),
          "--state",
          "all",
          "--json",
          "number,state",
          "--limit",
          "10",
        ]),
      ),

    createFeatureBranch: (featureIssueNumber) => {
      const branch = featureBranch(featureIssueNumber);
      type GitRef = { object: { sha: string } };
      const ref = ghApiJson<GitRef>(
        `repos/${config.repoSlug}/git/ref/heads/${config.defaultBranch}`,
      );
      try {
        exec(["api", "--method", "POST", `repos/${config.repoSlug}/git/refs`, "--input", "-"], {
          input: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }),
        });
      } catch (error) {
        // 422 = branch already exists — the idempotent success case.
        const stderr = (error as { stderr?: string }).stderr ?? "";
        if (!/Reference already exists/i.test(stderr) && !/\b422\b/.test(stderr)) {
          throw error;
        }
      }
    },

    ensureDraftIntegrationPr: (featureIssueNumber, featureIssueTitle) => {
      const existing = client.featureIntegrationPr(featureIssueNumber);
      if (existing && existing.state === "OPEN") {
        return;
      }
      ghWrite(
        [
          "pr",
          "create",
          "--head",
          featureBranch(featureIssueNumber),
          "--base",
          config.defaultBranch,
          "--title",
          featureIssueTitle,
          "--body-file",
          "-",
          "--draft",
        ],
        { input: `Part of #${featureIssueNumber}.` },
      );
    },

    listFeatureIntegrationPrs: () => {
      type GhPr = {
        number: number;
        headRefName: string;
        body: string | null;
        isCrossRepository: boolean;
        labels: Array<{ name: string }>;
      };
      return ghJson<GhPr[]>([
        "pr",
        "list",
        "--state",
        "open",
        "--base",
        config.defaultBranch,
        "--json",
        "number,headRefName,body,isCrossRepository,labels",
        // A wider cap than the client's other listings, which are all narrowed
        // by a label or a head branch. This one is narrowed only by base, and an
        // integration PR is long-lived by nature — on a busy repo it is exactly
        // the PR that a 100-row window of newer PRs would push out, silently
        // stranding the feature it collects. `gh` stops paginating when the
        // results run out, so a quiet repo still pays one page.
        "--limit",
        "1000",
      ]).flatMap((pr) => {
        const featureIssueNumber = parseFeatureIssueNumber(asBranchRef(pr.headRefName));
        if (featureIssueNumber === null || pr.isCrossRepository) {
          return [];
        }
        return [
          {
            number: asPrNumber(pr.number),
            featureIssueNumber,
            body: pr.body ?? "",
            labels: pr.labels.map((label) => label.name),
          },
        ];
      });
    },

    listMergedMemberPrs: (featureIssueNumber) => {
      type GhPr = { number: number; headRefName: string };
      return ghJson<GhPr[]>([
        "pr",
        "list",
        "--base",
        featureBranch(featureIssueNumber),
        "--state",
        "merged",
        "--json",
        "number,headRefName",
        "--limit",
        "100",
      ]).map((pr) => ({
        number: asPrNumber(pr.number),
        headRefName: asBranchRef(pr.headRefName),
      }));
    },

    blockerPrState: (blockerIssueNumber) => {
      const branch: BranchRef = issueBranch(blockerIssueNumber);
      const open = ghJson<Array<{ number: number }>>([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number",
        "--limit",
        "1",
      ]);
      const merged = ghJson<Array<{ number: number }>>([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "merged",
        "--json",
        "number",
        "--limit",
        "1",
      ]);
      if (open.length > 0 || merged.length > 0) {
        return {
          hasOpenPr: open.length > 0,
          openPrNumber: open[0] ? asPrNumber(open[0].number) : undefined,
          hasMergedPr: merged.length > 0,
          mergedPrNumber: merged[0] ? asPrNumber(merged[0].number) : undefined,
        };
      }

      // Only when no Phoebe PR answers for the blocker is the third call worth it:
      // the work may have landed outside `branchPrefix` and closed the issue (#219).
      const view = ghJson<{ state: string; stateReason?: string | null }>([
        "issue",
        "view",
        String(blockerIssueNumber),
        "--json",
        "state,stateReason",
      ]);
      return {
        hasOpenPr: false,
        hasMergedPr: false,
        blockerCompleted: isCompletedBlockerIssue(view),
      };
    },

    listOpenPhoebePrs: () => {
      // The default branch first — the listing every cycle has always made.
      // Enumerating the live features costs one more `gh pr list` even on a repo
      // that has none; a feature's own listing is paid only while it is live.
      const prs = openPrsBasedOn(config.defaultBranch);
      for (const branch of liveFeatureBranches()) {
        try {
          prs.push(...openPrsBasedOn(branch));
        } catch (error) {
          // One feature's listing failing must not cost the janitors every
          // other open PR this cycle.
          console.warn(`[phoebe] Skipping PRs based on ${branch} this cycle — ${errorText(error)}`);
        }
      }
      return prs;
    },

    currentMergeInfo,

    prCommentBodies: (prNumber) => {
      const { comments } = ghJson<{ comments: Array<{ body: string }> }>([
        "pr",
        "view",
        String(prNumber),
        "--json",
        "comments",
      ]);
      return comments.map((comment) => comment.body);
    },

    // GraphQL statusCheckRollup is not readable by fine-grained PATs (GitHub-App/
    // OAuth only), so check state comes from the REST Actions API instead.
    commitCheckItems: (headSha) =>
      ghJson<WorkflowRunItem[]>([
        "run",
        "list",
        "--commit",
        headSha,
        "--json",
        "workflowName,status,conclusion",
        "--limit",
        "50",
      ]),

    reviewThreads,

    reviewSummaryComments: (prNumber) => {
      const { comments } = ghJson<{
        comments: Array<{ body: string; createdAt: string; author: { login: string } | null }>;
      }>(["pr", "view", String(prNumber), "--json", "comments"]);
      // A deleted account reads as `null`, as everywhere else a login is read
      // here. The pre-port code derefed `author.login` bare, so one comment from a
      // deleted account threw inside the reviews result handler — which skipped
      // the handled-watermark write, leaving that PR re-selected every cycle.
      return comments.map((comment) => ({
        body: comment.body,
        createdAt: comment.createdAt,
        authorLogin: noLoginAsNull(comment.author),
      }));
    },

    findIssuePr: (issueNumber) => {
      const row = ghJson<Array<{ number: number }>>([
        "pr",
        "list",
        "--head",
        issueBranch(issueNumber),
        "--state",
        "open",
        "--json",
        "number",
      ])[0];
      return row ? asPrNumber(row.number) : null;
    },

    createPr: (opts) => {
      ghWrite(
        [
          "pr",
          "create",
          "--head",
          opts.head,
          "--base",
          opts.base,
          "--title",
          opts.title,
          "--body-file",
          "-",
        ],
        { input: opts.body },
      );
    },

    stackPrOnto: (prNumber, blockerPrNumber) => {
      // Raw `exec`, not the ghJson/ghApiJson wrappers: those rethrow enriched
      // errors, and here every failure — preview not enabled (404), token
      // scope, rate limit — has the same right answer, the banner fallback.
      type StackResource = {
        number: number;
        pull_requests?: Array<{ number: number; state: string }>;
      };
      const slug = config.repoSlug;
      try {
        const stacks = JSON.parse(
          exec(["api", `repos/${slug}/stacks?pull_request=${blockerPrNumber}`]),
        ) as StackResource[];
        const stack = stacks[0];
        if (stack) {
          if (stack.pull_requests?.some((pr) => pr.number === prNumber)) {
            return { stacked: true, stackNumber: stack.number };
          }
          // `/add` appends to the top of the stack. If another open layer
          // already sits above the blocker, joining would stack this PR on a
          // sibling it does not build on — the banner fallback orders it right.
          const topOpen = stack.pull_requests?.filter((pr) => pr.state === "open").at(-1);
          if (topOpen?.number !== blockerPrNumber) {
            return {
              stacked: false,
              reason: `blocker PR #${blockerPrNumber} is not the top of stack #${stack.number}`,
            };
          }
          exec(
            ["api", "--method", "POST", `repos/${slug}/stacks/${stack.number}/add`, "--input", "-"],
            { input: JSON.stringify({ pull_requests: [prNumber] }) },
          );
          return { stacked: true, stackNumber: stack.number };
        }
        const created = JSON.parse(
          exec(["api", "--method", "POST", `repos/${slug}/stacks`, "--input", "-"], {
            input: JSON.stringify({ pull_requests: [blockerPrNumber, prNumber] }),
          }),
        ) as { number: number };
        return { stacked: true, stackNumber: created.number };
      } catch (error) {
        return { stacked: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    retargetPr: (prNumber, base) => {
      ghWrite(["pr", "edit", String(prNumber), "--base", base]);
    },

    listNativelyStackedPrs: () => {
      type GhPr = {
        number: number;
        headRefName: string;
        baseRefName: string;
        isCrossRepository: boolean;
      };
      const prefix = config.branchPrefix;
      return ghJson<GhPr[]>([
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,headRefName,baseRefName,isCrossRepository",
        "--limit",
        "100",
      ])
        .filter(
          (pr) =>
            !pr.isCrossRepository &&
            pr.headRefName.startsWith(prefix) &&
            pr.baseRefName.startsWith(prefix),
        )
        .map((pr) => ({
          number: asPrNumber(pr.number),
          headRefName: asBranchRef(pr.headRefName),
          baseRefName: asBranchRef(pr.baseRefName),
        }));
    },

    unstackPr: (prNumber) => {
      type StackResource = {
        number: number;
        pull_requests?: Array<{ number: number; state: string }>;
      };
      const slug = config.repoSlug;
      try {
        const stacks = JSON.parse(
          exec(["api", `repos/${slug}/stacks?pull_request=${prNumber}`]),
        ) as StackResource[];
        const stack = stacks[0];
        if (!stack) {
          return { unstacked: false, reason: "not-in-stack" };
        }
        exec(["api", "--method", "POST", `repos/${slug}/stacks/${stack.number}/unstack`]);
        return { unstacked: true, stackNumber: stack.number };
      } catch (error) {
        return {
          unstacked: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    listQuarantinedIssues: () => {
      type Row = { number: number; body: string; comments: Array<{ body: string }> };
      return ghJson<Row[]>([
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        PHOEBE_QUARANTINE_LABEL,
        "--limit",
        "100",
        "--json",
        "number,body,comments",
      ]).map((row) => ({
        target: { objectType: "issue", id: row.number },
        currentBaseline: issueContentBaseline(row.body),
        comments: row.comments,
      }));
    },

    listQuarantinedPrs: () => {
      type Row = { number: number; headRefOid: string; comments: Array<{ body: string }> };
      return ghJson<Row[]>([
        "pr",
        "list",
        "--state",
        "open",
        "--label",
        PHOEBE_QUARANTINE_LABEL,
        "--limit",
        "100",
        "--json",
        "number,headRefOid,comments",
      ]).map((row) => ({
        target: { objectType: "pr", id: row.number },
        currentBaseline: row.headRefOid,
        comments: row.comments,
      }));
    },

    issueTimeoutInputs: (issueNumber) => {
      const raw = ghJson<{ body: string; comments: GhTimeoutComment[] }>([
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "comments,body",
      ]);
      // Issues have no commits, so a new human comment is the only reset signal. The
      // un-stick baseline is a fingerprint of the body, never `updatedAt`: GitHub
      // bumps that on any comment, label, or reaction — including the quarantine
      // comment + label Phoebe writes moments later — so a timestamp baseline would
      // make every quarantine clear itself on the first sweep (#153).
      return {
        comments: toTimeoutComments(raw.comments),
        extraActivityAt: null,
        baseline: issueContentBaseline(raw.body),
      };
    },

    prTimeoutInputs: (prNumber) => {
      const raw = ghJson<{
        headRefOid: string;
        comments: GhTimeoutComment[];
        commits: Array<{ committedDate: string }>;
      }>(["pr", "view", String(prNumber), "--json", "comments,commits,headRefOid"]);
      // A new push (head commit) or human comment resets; head SHA is the baseline.
      const headCommitAt =
        raw.commits.length > 0 ? raw.commits[raw.commits.length - 1]!.committedDate : null;
      return {
        comments: toTimeoutComments(raw.comments),
        extraActivityAt: headCommitAt,
        baseline: raw.headRefOid,
      };
    },

    updatePrBody: (prNumber, body) => {
      // Through stdin, not `--body`: a PR body runs to many lines and holds
      // whatever markdown a human put there, which has no business on argv.
      ghWrite(["pr", "edit", String(prNumber), "--body-file", "-"], { input: body });
    },

    postPrComment: (prNumber, body) => {
      ghWrite(["pr", "comment", String(prNumber), "--body", body]);
    },

    postUnitComment: (target, body) => {
      ghWrite([target.objectType, "comment", String(target.id), "--body", body]);
    },

    addQuarantineLabel: (target) => {
      ghWrite([
        target.objectType,
        "edit",
        String(target.id),
        "--add-label",
        PHOEBE_QUARANTINE_LABEL,
      ]);
    },

    removeQuarantineLabel: (target) => {
      ghWrite([
        target.objectType,
        "edit",
        String(target.id),
        "--remove-label",
        PHOEBE_QUARANTINE_LABEL,
      ]);
    },

    issueLabels: (issueNumber) =>
      ghJson<{ labels: Array<{ name: string }> }>([
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "labels",
      ]).labels.map((l) => l.name),

    addIssueLabel: (issueNumber, label) => {
      // Captured exec (not ghWrite/inherit) so callers can inspect the error
      // with `isLabelNotFoundError` when the label does not exist yet.
      exec(["issue", "edit", String(issueNumber), "--add-label", label, "-R", config.repoSlug]);
    },

    removeIssueLabel: (issueNumber, label) => {
      ghWrite(["issue", "edit", String(issueNumber), "--remove-label", label]);
    },

    createLabel: (name) => {
      ghWrite([
        "label",
        "create",
        name,
        "--description",
        "Phoebe is working this issue",
        "--color",
        "FBCA04",
      ]);
    },

    resolveLogin: (envLogin) => {
      if (envLogin) return envLogin;
      return ghApiJson<{ login: string }>("user").login;
    },

    newestUnitMarkerAuthor: () => {
      // GitHub's issue/PR comments share one REST endpoint. Fetch the 100 most
      // recently created, scan client-side for the timeout marker (full-text
      // search tokenizes the hyphenated name unreliably — #346), and return
      // the author of the first hit.
      type RepoComment = { body: string; created_at: string; user: { login: string } | null };
      const comments = ghApiJson<RepoComment[]>(
        `repos/${config.repoSlug}/issues/comments?per_page=100&sort=created&direction=desc`,
      );
      const hit = comments.find((c) => parseUnitTimeoutMarker(c.body) !== null);
      return hit ? noLoginAsNull(hit.user) : null;
    },

    issueAuthorLogin: (issueNumber) =>
      ghJson<{ author: { login: string } | null }>([
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "author",
      ]).author?.login ?? null,

    lookupUser: (login) => ghApiJson<GitHubUser>(`users/${encodeURIComponent(login)}`),

    forCycle: () => {
      let openPrs: OpenPhoebePr[] | null = null;
      const merges = new Map<PrNumber, PrMergeInfo>();
      return {
        ...client,
        openPrs: () => {
          if (openPrs === null) {
            openPrs = client.listOpenPhoebePrs();
          }
          return openPrs;
        },
        mergeInfo: async (prNumber) => {
          const hit = merges.get(prNumber);
          if (hit !== undefined) return hit;
          let info = currentMergeInfo(prNumber);
          for (let attempt = 1; attempt < MERGEABLE_RETRY_COUNT; attempt++) {
            if (info.mergeable !== "UNKNOWN") break;
            await sleep(MERGEABLE_RETRY_MS);
            info = currentMergeInfo(prNumber);
          }
          merges.set(prNumber, info);
          return info;
        },
      };
    },
  };

  return client;
}
