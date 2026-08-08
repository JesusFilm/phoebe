// The GitHub adapter — every `gh` invocation in the engine goes through this
// one module (#41/#50). Two seams, both real:
//
//  - the domain interface (`GitHub`, built by `createGitHub`) — ~20 methods
//    covering every read/write the engine needs, GitHub JSON shapes dying
//    here and branded types (`PrNumber`/`BranchRef`/`Sha`) crossing out;
//  - the runner (`GhRun`/`defaultGhRun`, mirroring `git-model.ts`'s
//    `GitRunner`/`defaultGit`) — the internal seam this module's own tests
//    fake, and the one other modules (bootstrap's `setupGitCredentials`) reach
//    for when they need a raw, unscoped `gh` call outside any domain method.
//
// Construction binds `repoSlug` and `timeoutMs` once — every repo-pinned
// method appends `-R <repoSlug>` (or, for `gh api`/GraphQL calls that don't
// take `-R`, bakes the slug into the endpoint/query variables instead).
// `installStackExtension`, `login`, and `updateComment` are the exceptions:
// none of the three operate against a particular repo.
//
// Every method throws the same `GhCommandError` on failure — argv plus cause
// — so resilience policy (warn-and-skip-cycle, best-effort quarantine writes,
// `nativeBlockers` defaulting to `[]`) stays entirely at call sites in
// main.ts, never here.
//
// List caps are documented interface facts, not accidents: issue/PR lists cap
// at 100, the check-run list at 50 — comfortably above any real repo's Phoebe
// working set. Only `reviewThreads` truly paginates (GitHub threads a PR can
// carry are unbounded).

import { execFileSync } from "node:child_process";
import {
  asBranchRef,
  asPrNumber,
  asSha,
  type BranchRef,
  type PrNumber,
  type Sha,
} from "./branded.ts";
import {
  ghStackExtensionInstallArgs,
  type Issue,
  type ReviewThread,
  type WorkflowRunItem,
} from "./orchestrator.ts";

export type GhRun = (
  args: readonly string[],
  opts?: { input?: string; stdio?: "pipe" | "inherit"; timeoutMs?: number },
) => string;

/** No policy — no `-R`, no timeout default. Every policy choice is the caller's. */
export const defaultGhRun: GhRun = (args, opts) =>
  execFileSync("gh", [...args], {
    encoding: "utf8",
    ...(opts?.stdio === "inherit" ? { stdio: "inherit" } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  }) as unknown as string;

/** Uniform failure mode for every `GitHub` method: the argv attempted, plus the underlying cause. */
export class GhCommandError extends Error {
  readonly argv: readonly string[];
  constructor(argv: readonly string[], cause: unknown) {
    super(
      `gh ${argv.join(" ")} failed — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "GhCommandError";
    this.argv = argv;
    this.cause = cause;
  }
}

export type NativeBlocker = { number: number; state: string };

export type ActivityComment = {
  id: string;
  body: string;
  createdAt: string;
  authorLogin: string;
};

export type IssueActivity = {
  updatedAt: string;
  comments: ActivityComment[];
};

export type PrActivity = {
  headRefOid: Sha;
  /** The last commit's push time, or `null` for a PR with no commits. */
  lastCommitAt: string | null;
  comments: ActivityComment[];
};

export type OpenPr = {
  number: PrNumber;
  headRefName: BranchRef;
  baseRefName: BranchRef;
  isDraft: boolean;
  isCrossRepository: boolean;
  labels: string[];
  authorLogin: string;
};

export type PrMergeInfo = {
  number: PrNumber;
  headRefName: BranchRef;
  baseRefName: BranchRef;
  headRefOid: Sha;
  baseRefOid: Sha;
  mergeable: string;
  mergeStateStatus: string;
};

export interface GitHub {
  /** Open issues carrying `label`, oldest-created first. Capped at 100. */
  issuesWithLabel(label: string): Issue[];
  issueBody(issueNumber: number): string;
  issueActivity(issueNumber: number): IssueActivity;
  /** GitHub's native issue-dependencies read. Throws — callers decide the fallback. */
  nativeBlockers(issueNumber: number): NativeBlocker[];
  /** The PR (if any) whose head is `branch`, in the given state. */
  prNumberForHead(branch: BranchRef, state: "open" | "merged"): PrNumber | undefined;
  /** Unfiltered open PRs, newest scope decisions (isPrInScope, prBaseScope) left to the caller. Capped at 100. */
  openPrs(opts?: { base?: string }): OpenPr[];
  prMergeInfo(prNumber: PrNumber): PrMergeInfo;
  prActivity(prNumber: PrNumber): PrActivity;
  /** Every review thread on a PR, fully paginated. */
  reviewThreads(prNumber: PrNumber): ReviewThread[];
  /** Newest-per-workflow check runs for a commit. Capped at 50. */
  commitCheckRuns(sha: Sha): WorkflowRunItem[];
  commentIssue(issueNumber: number, body: string): void;
  commentPr(prNumber: PrNumber, body: string): void;
  createPr(opts: { head: BranchRef; base: string; title: string; body: string }): void;
  retargetPr(prNumber: PrNumber, base: string): void;
  labelIssue(issueNumber: number, label: string): void;
  labelPr(prNumber: PrNumber, label: string): void;
  /** Registers a native GitHub stack, bottom (predecessor) to top (successor). */
  linkStack(predecessor: BranchRef, successor: BranchRef): void;
  /** Unscoped: installs the `github/gh-stack` extension. */
  installStackExtension(): void;
  /** Unscoped: the authenticated user's login. */
  login(): string;
  /** Unscoped: edits a comment in place by its GraphQL node id. */
  updateComment(commentId: string, body: string): void;
}

type GhIssueRow = {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  labels: Array<{ name: string }>;
  author: { login: string } | null;
};

type GhCommentRow = {
  id: string;
  body: string;
  createdAt: string;
  author: { login: string } | null;
};

type GhOpenPrRow = {
  number: number;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  labels: Array<{ name: string }>;
  author: { login: string };
};

type GhPrMergeInfoRow = {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  mergeable: string;
  mergeStateStatus: string;
};

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
              nodes: Array<{ createdAt: string; author: { login: string } | null }>;
            };
          }>;
        };
      };
    };
  };
};

function toActivityComment(row: GhCommentRow): ActivityComment {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt,
    authorLogin: row.author?.login ?? "",
  };
}

export function createGitHub(opts: { repoSlug: string; run?: GhRun; timeoutMs?: number }): GitHub {
  const repoSlug = opts.repoSlug;
  const run = opts.run ?? defaultGhRun;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  /** `gh <args> -R <repoSlug>`, JSON-parsed. */
  function scopedJson<T>(args: readonly string[]): T {
    const full = [...args, "-R", repoSlug];
    try {
      return JSON.parse(run(full, { timeoutMs })) as T;
    } catch (cause) {
      throw new GhCommandError(full, cause);
    }
  }

  /** `gh <args> -R <repoSlug>`, side-effecting — output streams straight through. */
  function scopedVoid(args: readonly string[], input?: string): void {
    const full = [...args, "-R", repoSlug];
    try {
      run(full, { stdio: "inherit", timeoutMs, ...(input !== undefined ? { input } : {}) });
    } catch (cause) {
      throw new GhCommandError(full, cause);
    }
  }

  /** An unscoped `gh <args>` call — no `-R`, JSON-parsed. */
  function unscopedJson<T>(args: readonly string[]): T {
    try {
      return JSON.parse(run(args, { timeoutMs })) as T;
    } catch (cause) {
      throw new GhCommandError(args, cause);
    }
  }

  /** An unscoped `gh <args>` call — no `-R`, side-effecting. */
  function unscopedVoid(args: readonly string[]): void {
    try {
      run(args, { stdio: "inherit", timeoutMs });
    } catch (cause) {
      throw new GhCommandError(args, cause);
    }
  }

  return {
    issuesWithLabel(label: string): Issue[] {
      return scopedJson<GhIssueRow[]>([
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
        "number,title,body,labels,createdAt,author",
      ]).map((row) => ({
        number: row.number,
        title: row.title,
        body: row.body,
        createdAt: row.createdAt,
        labels: row.labels.map((l) => l.name),
        authorLogin: row.author?.login ?? "",
      }));
    },

    issueBody(issueNumber: number): string {
      return scopedJson<{ body: string }>(["issue", "view", String(issueNumber), "--json", "body"])
        .body;
    },

    issueActivity(issueNumber: number): IssueActivity {
      const raw = scopedJson<{ updatedAt: string; comments: GhCommentRow[] }>([
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "comments,updatedAt",
      ]);
      return { updatedAt: raw.updatedAt, comments: raw.comments.map(toActivityComment) };
    },

    nativeBlockers(issueNumber: number): NativeBlocker[] {
      const rows = unscopedJson<Array<{ number: number; state: string }>>([
        "api",
        `repos/${repoSlug}/issues/${issueNumber}/dependencies/blocked_by`,
      ]);
      return Array.isArray(rows)
        ? rows.map((row) => ({ number: row.number, state: row.state }))
        : [];
    },

    prNumberForHead(branch: BranchRef, state: "open" | "merged"): PrNumber | undefined {
      const rows = scopedJson<Array<{ number: number }>>([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        state,
        "--json",
        "number",
        "--limit",
        "1",
      ]);
      return rows[0] ? asPrNumber(rows[0].number) : undefined;
    },

    openPrs(openPrsOpts?: { base?: string }): OpenPr[] {
      const args = [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,headRefName,baseRefName,isDraft,isCrossRepository,labels,author",
        "--limit",
        "100",
        ...(openPrsOpts?.base !== undefined ? ["--base", openPrsOpts.base] : []),
      ];
      return scopedJson<GhOpenPrRow[]>(args).map((row) => ({
        number: asPrNumber(row.number),
        headRefName: asBranchRef(row.headRefName),
        baseRefName: asBranchRef(row.baseRefName),
        isDraft: row.isDraft,
        isCrossRepository: row.isCrossRepository,
        labels: row.labels.map((l) => l.name),
        authorLogin: row.author.login,
      }));
    },

    prMergeInfo(prNumber: PrNumber): PrMergeInfo {
      const raw = scopedJson<GhPrMergeInfoRow>([
        "pr",
        "view",
        String(prNumber),
        "--json",
        "number,headRefName,baseRefName,headRefOid,baseRefOid,mergeable,mergeStateStatus",
      ]);
      return {
        number: asPrNumber(raw.number),
        headRefName: asBranchRef(raw.headRefName),
        baseRefName: asBranchRef(raw.baseRefName),
        headRefOid: asSha(raw.headRefOid),
        baseRefOid: asSha(raw.baseRefOid),
        mergeable: raw.mergeable,
        mergeStateStatus: raw.mergeStateStatus,
      };
    },

    prActivity(prNumber: PrNumber): PrActivity {
      const raw = scopedJson<{
        headRefOid: string;
        comments: GhCommentRow[];
        commits: Array<{ committedDate: string }>;
      }>(["pr", "view", String(prNumber), "--json", "comments,commits,headRefOid"]);
      const lastCommitAt =
        raw.commits.length > 0 ? raw.commits[raw.commits.length - 1]!.committedDate : null;
      return {
        headRefOid: asSha(raw.headRefOid),
        lastCommitAt,
        comments: raw.comments.map(toActivityComment),
      };
    },

    reviewThreads(prNumber: PrNumber): ReviewThread[] {
      const [owner, repo] = repoSlug.split("/");
      const threads: ReviewThread[] = [];
      let cursor: string | null = null;

      for (;;) {
        const afterArg: string = cursor ? `, after:"${cursor}"` : "";
        const query: string = `query($owner:String!,$repo:String!,$pr:Int!) {
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
        const graphqlArgs: string[] = [
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
        const page: GraphQLReviewThreadsPage = unscopedJson<GraphQLReviewThreadsPage>(graphqlArgs);
        const reviewThreadsPage = page.data.repository.pullRequest.reviewThreads;
        for (const node of reviewThreadsPage.nodes) {
          threads.push({
            isResolved: node.isResolved,
            isOutdated: node.isOutdated,
            comments: node.comments.nodes.map((comment) => ({
              createdAt: comment.createdAt,
              authorLogin: comment.author?.login ?? "",
            })),
          });
        }
        if (!reviewThreadsPage.pageInfo.hasNextPage) {
          break;
        }
        cursor = reviewThreadsPage.pageInfo.endCursor;
      }

      return threads;
    },

    commitCheckRuns(sha: Sha): WorkflowRunItem[] {
      return scopedJson<WorkflowRunItem[]>([
        "run",
        "list",
        "--commit",
        sha,
        "--json",
        "workflowName,status,conclusion",
        "--limit",
        "50",
      ]);
    },

    commentIssue(issueNumber: number, body: string): void {
      scopedVoid(["issue", "comment", String(issueNumber), "--body", body]);
    },

    commentPr(prNumber: PrNumber, body: string): void {
      scopedVoid(["pr", "comment", String(prNumber), "--body", body]);
    },

    createPr(createOpts: { head: BranchRef; base: string; title: string; body: string }): void {
      scopedVoid(
        [
          "pr",
          "create",
          "--head",
          createOpts.head,
          "--base",
          createOpts.base,
          "--title",
          createOpts.title,
          "--body-file",
          "-",
        ],
        createOpts.body,
      );
    },

    retargetPr(prNumber: PrNumber, base: string): void {
      scopedVoid(["pr", "edit", String(prNumber), "--base", base]);
    },

    labelIssue(issueNumber: number, label: string): void {
      scopedVoid(["issue", "edit", String(issueNumber), "--add-label", label]);
    },

    labelPr(prNumber: PrNumber, label: string): void {
      scopedVoid(["pr", "edit", String(prNumber), "--add-label", label]);
    },

    linkStack(predecessor: BranchRef, successor: BranchRef): void {
      scopedVoid(["stack", "link", predecessor, successor]);
    },

    installStackExtension(): void {
      unscopedVoid([...ghStackExtensionInstallArgs()]);
    },

    login(): string {
      return unscopedJson<{ login: string }>(["api", "user"]).login;
    },

    updateComment(commentId: string, body: string): void {
      unscopedVoid([
        "api",
        "graphql",
        "-f",
        "query=mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id, body:$body}){issueComment{id}}}",
        "-f",
        `id=${commentId}`,
        "-f",
        `body=${body}`,
      ]);
    },
  };
}
