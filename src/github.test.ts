// Exercises the GitHub adapter (#41/#50) against a recording fake `run` — no
// real `gh` process runs here except the one light smoke test on
// `defaultGhRun` itself, which shells out to a side-effect-free `gh` command.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "./branded.ts";
import { createGitHub, defaultGhRun, GhCommandError, type GhRun } from "./github.ts";

type RecordedCall = {
  args: readonly string[];
  opts?: { input?: string; stdio?: "pipe" | "inherit"; timeoutMs?: number };
};

/** A `GhRun` that returns queued responses in call order and records every invocation. */
function fakeRun(responses: ReadonlyArray<string | Error> = []): {
  run: GhRun;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const run: GhRun = (args, opts) => {
    calls.push({ args, ...(opts ? { opts } : {}) });
    const response = responses[i++] ?? "";
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  return { run, calls };
}

const REPO_SLUG = "acme/widgets";

describe("issuesWithLabel", () => {
  test("argv scoped with -R, maps labels/author into Issue rows", () => {
    const { run, calls } = fakeRun([
      JSON.stringify([
        {
          number: 12,
          title: "Fix the thing",
          body: "body text",
          createdAt: "2026-01-01T00:00:00Z",
          labels: [{ name: "ready-for-agent" }, { name: "bug" }],
          author: { login: "tanflem" },
        },
        {
          number: 13,
          title: "Deleted author",
          body: "",
          createdAt: "2026-01-02T00:00:00Z",
          labels: [],
          author: null,
        },
      ]),
    ]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });

    expect(github.issuesWithLabel("ready-for-agent")).toEqual([
      {
        number: 12,
        title: "Fix the thing",
        body: "body text",
        createdAt: "2026-01-01T00:00:00Z",
        labels: ["ready-for-agent", "bug"],
        authorLogin: "tanflem",
      },
      {
        number: 13,
        title: "Deleted author",
        body: "",
        createdAt: "2026-01-02T00:00:00Z",
        labels: [],
        authorLogin: "",
      },
    ]);
    expect(calls).toEqual([
      {
        args: [
          "issue",
          "list",
          "--state",
          "open",
          "--label",
          "ready-for-agent",
          "--limit",
          "100",
          "--search",
          "sort:created-asc",
          "--json",
          "number,title,body,labels,createdAt,author",
          "-R",
          REPO_SLUG,
        ],
        opts: { timeoutMs: 120_000 },
      },
    ]);
  });
});

describe("issueBody / issueActivity", () => {
  test("issueBody scopes and returns the body", () => {
    const { run, calls } = fakeRun([JSON.stringify({ body: "the body" })]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.issueBody(7)).toBe("the body");
    expect(calls[0]!.args).toEqual(["issue", "view", "7", "--json", "body", "-R", REPO_SLUG]);
  });

  test("issueActivity carries comments (id/body/createdAt/authorLogin) + updatedAt + labels + body", () => {
    const { run, calls } = fakeRun([
      JSON.stringify({
        updatedAt: "2026-02-01T00:00:00Z",
        comments: [
          { id: "c1", body: "first", createdAt: "2026-01-01T00:00:00Z", author: { login: "a" } },
          { id: "c2", body: "deleted author", createdAt: "2026-01-02T00:00:00Z", author: null },
        ],
        labels: [{ name: "bug" }],
        body: "the issue body",
      }),
    ]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.issueActivity(7)).toEqual({
      updatedAt: "2026-02-01T00:00:00Z",
      comments: [
        { id: "c1", body: "first", createdAt: "2026-01-01T00:00:00Z", authorLogin: "a" },
        { id: "c2", body: "deleted author", createdAt: "2026-01-02T00:00:00Z", authorLogin: "" },
      ],
      labels: ["bug"],
      body: "the issue body",
    });
    expect(calls[0]!.args).toEqual([
      "issue",
      "view",
      "7",
      "--json",
      "comments,updatedAt,labels,body",
      "-R",
      REPO_SLUG,
    ]);
  });
});

describe("nativeBlockers — unscoped exception, throws (no warn-and-[] here)", () => {
  test("argv has no -R; repoSlug is embedded in the endpoint URL", () => {
    const { run, calls } = fakeRun([JSON.stringify([{ number: 5, state: "OPEN" }])]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.nativeBlockers(9)).toEqual([{ number: 5, state: "OPEN" }]);
    expect(calls[0]!.args).toEqual(["api", `repos/${REPO_SLUG}/issues/9/dependencies/blocked_by`]);
  });

  test("non-array response degrades to []", () => {
    const { run } = fakeRun([JSON.stringify({ message: "not found" })]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.nativeBlockers(9)).toEqual([]);
  });

  test("propagates a GhCommandError on failure — no swallow-to-[] inside the module", () => {
    const { run } = fakeRun([new Error("HTTP 404")]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(() => github.nativeBlockers(9)).toThrow(GhCommandError);
  });
});

describe("labelRemovals — unscoped timeline read, filtered to unlabeled events on `label`", () => {
  test("argv has no -R; repoSlug is embedded in the endpoint URL; maps actor/created_at, dropping other event types and other labels", () => {
    const { run, calls } = fakeRun([
      JSON.stringify([
        {
          event: "labeled",
          actor: { login: "tanflem" },
          created_at: "2026-01-01T00:00:00Z",
          label: { name: "phoebe:quarantined" },
        },
        {
          event: "unlabeled",
          actor: { login: "tanflem" },
          created_at: "2026-01-02T00:00:00Z",
          label: { name: "bug" },
        },
        {
          event: "unlabeled",
          actor: { login: "tanflem" },
          created_at: "2026-01-03T00:00:00Z",
          label: { name: "phoebe:quarantined" },
        },
      ]),
    ]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.labelRemovals(9, "phoebe:quarantined")).toEqual([
      { actorLogin: "tanflem", removedAt: "2026-01-03T00:00:00Z" },
    ]);
    expect(calls[0]!.args).toEqual(["api", `repos/${REPO_SLUG}/issues/9/timeline`]);
  });

  test("deleted actor degrades to an empty login rather than throwing", () => {
    const { run } = fakeRun([
      JSON.stringify([
        {
          event: "unlabeled",
          actor: null,
          created_at: "2026-01-03T00:00:00Z",
          label: { name: "phoebe:quarantined" },
        },
      ]),
    ]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.labelRemovals(9, "phoebe:quarantined")).toEqual([
      { actorLogin: "", removedAt: "2026-01-03T00:00:00Z" },
    ]);
  });

  test("non-array response degrades to []", () => {
    const { run } = fakeRun([JSON.stringify({ message: "not found" })]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.labelRemovals(9, "phoebe:quarantined")).toEqual([]);
  });

  test("propagates a GhCommandError on failure — no swallow-to-[] inside the module", () => {
    const { run } = fakeRun([new Error("HTTP 404")]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(() => github.labelRemovals(9, "phoebe:quarantined")).toThrow(GhCommandError);
  });
});

describe("prNumberForHead — collapses the 4 head-branch→PR lookups", () => {
  test("open state", () => {
    const { run, calls } = fakeRun([JSON.stringify([{ number: 42 }])]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.prNumberForHead(asBranchRef("phoebe/issue-9"), "open")).toBe(42);
    expect(calls[0]!.args).toEqual([
      "pr",
      "list",
      "--head",
      "phoebe/issue-9",
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1",
      "-R",
      REPO_SLUG,
    ]);
  });

  test("merged state, no match → undefined", () => {
    const { run, calls } = fakeRun([JSON.stringify([])]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.prNumberForHead(asBranchRef("phoebe/issue-9"), "merged")).toBeUndefined();
    expect(calls[0]!.args).toContain("merged");
  });
});

describe("openPrs — unfiltered, opts.base optional", () => {
  const row = {
    number: 3,
    headRefName: "phoebe/issue-3",
    baseRefName: "main",
    isDraft: false,
    isCrossRepository: false,
    labels: [{ name: "ready-for-human" }],
    author: { login: "phoebe-bot" },
  };

  test("no base filter", () => {
    const { run, calls } = fakeRun([JSON.stringify([row])]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.openPrs()).toEqual([
      {
        number: 3,
        headRefName: "phoebe/issue-3",
        baseRefName: "main",
        isDraft: false,
        isCrossRepository: false,
        labels: ["ready-for-human"],
        authorLogin: "phoebe-bot",
      },
    ]);
    expect(calls[0]!.args).toEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,headRefName,baseRefName,isDraft,isCrossRepository,labels,author",
      "--limit",
      "100",
      "-R",
      REPO_SLUG,
    ]);
  });

  test("with base filter", () => {
    const { run, calls } = fakeRun([JSON.stringify([row])]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.openPrs({ base: "main" });
    expect(calls[0]!.args).toEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,headRefName,baseRefName,isDraft,isCrossRepository,labels,author",
      "--limit",
      "100",
      "--base",
      "main",
      "-R",
      REPO_SLUG,
    ]);
  });
});

describe("prsWithLabel", () => {
  test("argv scoped with -R and --label, maps rows the same as openPrs", () => {
    const row = {
      number: 3,
      headRefName: "phoebe/issue-3",
      baseRefName: "main",
      isDraft: false,
      isCrossRepository: false,
      labels: [{ name: "phoebe:quarantined" }],
      author: { login: "phoebe-bot" },
    };
    const { run, calls } = fakeRun([JSON.stringify([row])]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });

    expect(github.prsWithLabel("phoebe:quarantined")).toEqual([
      {
        number: 3,
        headRefName: "phoebe/issue-3",
        baseRefName: "main",
        isDraft: false,
        isCrossRepository: false,
        labels: ["phoebe:quarantined"],
        authorLogin: "phoebe-bot",
      },
    ]);
    expect(calls[0]!.args).toEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--label",
      "phoebe:quarantined",
      "--json",
      "number,headRefName,baseRefName,isDraft,isCrossRepository,labels,author",
      "--limit",
      "100",
      "-R",
      REPO_SLUG,
    ]);
  });
});

describe("prMergeInfo", () => {
  test("maps branded fields", () => {
    const { run, calls } = fakeRun([
      JSON.stringify({
        number: 3,
        headRefName: "phoebe/issue-3",
        baseRefName: "main",
        headRefOid: "abc123",
        baseRefOid: "def456",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    ]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.prMergeInfo(asPrNumber(3))).toEqual({
      number: 3,
      headRefName: "phoebe/issue-3",
      baseRefName: "main",
      headRefOid: "abc123",
      baseRefOid: "def456",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(calls[0]!.args).toEqual([
      "pr",
      "view",
      "3",
      "--json",
      "number,headRefName,baseRefName,headRefOid,baseRefOid,mergeable,mergeStateStatus",
      "-R",
      REPO_SLUG,
    ]);
  });
});

describe("prActivity — consolidates fetchPrCommentBodies / hasNewReviewSummaryComment / fetchPrTimeoutInputs", () => {
  test("lastCommitAt from the newest commit", () => {
    const { run, calls } = fakeRun([
      JSON.stringify({
        headRefOid: "abc123",
        comments: [
          { id: "c1", body: "hi", createdAt: "2026-01-01T00:00:00Z", author: { login: "a" } },
        ],
        commits: [
          { committedDate: "2026-01-01T00:00:00Z" },
          { committedDate: "2026-01-02T00:00:00Z" },
        ],
        labels: [{ name: "phoebe:quarantined" }],
      }),
    ]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.prActivity(asPrNumber(3))).toEqual({
      headRefOid: "abc123",
      lastCommitAt: "2026-01-02T00:00:00Z",
      comments: [{ id: "c1", body: "hi", createdAt: "2026-01-01T00:00:00Z", authorLogin: "a" }],
      labels: ["phoebe:quarantined"],
    });
    expect(calls[0]!.args).toEqual([
      "pr",
      "view",
      "3",
      "--json",
      "comments,commits,headRefOid,labels",
      "-R",
      REPO_SLUG,
    ]);
  });

  test("lastCommitAt is null with no commits", () => {
    const { run } = fakeRun([
      JSON.stringify({ headRefOid: "abc123", comments: [], commits: [], labels: [] }),
    ]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.prActivity(asPrNumber(3)).lastCommitAt).toBeNull();
  });
});

describe("reviewThreads — unscoped GraphQL (owner/repo as query vars, no -R), fully paginated", () => {
  test("follows hasNextPage/endCursor across pages", () => {
    const page1 = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              nodes: [
                {
                  id: "PRRT_1",
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: [{ createdAt: "2026-01-01T00:00:00Z", author: { login: "r1" } }],
                  },
                },
              ],
            },
          },
        },
      },
    };
    const page2 = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PRRT_2",
                  isResolved: true,
                  isOutdated: false,
                  comments: { nodes: [{ createdAt: "2026-01-02T00:00:00Z", author: null }] },
                },
              ],
            },
          },
        },
      },
    };
    const { run, calls } = fakeRun([JSON.stringify(page1), JSON.stringify(page2)]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });

    expect(github.reviewThreads(asPrNumber(9))).toEqual([
      {
        id: "PRRT_1",
        isResolved: false,
        isOutdated: false,
        comments: [{ createdAt: "2026-01-01T00:00:00Z", authorLogin: "r1" }],
      },
      {
        id: "PRRT_2",
        isResolved: true,
        isOutdated: false,
        comments: [{ createdAt: "2026-01-02T00:00:00Z", authorLogin: "" }],
      },
    ]);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args[0]).toBe("api");
      expect(call.args[1]).toBe("graphql");
      expect(call.args).not.toContain("-R");
      expect(call.args.some((a) => a.startsWith("owner="))).toBe(true);
      expect(call.args.some((a) => a.startsWith("repo="))).toBe(true);
    }
    // Second page's query embeds the first page's cursor.
    expect(calls[1]!.args.some((a) => a.includes('after:"cursor-1"'))).toBe(true);
  });
});

describe("commitCheckRuns", () => {
  test("scoped, capped at 50", () => {
    const { run, calls } = fakeRun([
      JSON.stringify([{ workflowName: "CI", status: "completed", conclusion: "success" }]),
    ]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.commitCheckRuns(asSha("deadbeef"))).toEqual([
      { workflowName: "CI", status: "completed", conclusion: "success" },
    ]);
    expect(calls[0]!.args).toEqual([
      "run",
      "list",
      "--commit",
      "deadbeef",
      "--json",
      "workflowName,status,conclusion",
      "--limit",
      "50",
      "-R",
      REPO_SLUG,
    ]);
  });
});

describe("write methods — scoped, stdio inherit", () => {
  test("commentIssue", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.commentIssue(9, "hello");
    expect(calls[0]).toEqual({
      args: ["issue", "comment", "9", "--body", "hello", "-R", REPO_SLUG],
      opts: { stdio: "inherit", timeoutMs: 120_000 },
    });
  });

  test("commentPr", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.commentPr(asPrNumber(9), "hello");
    expect(calls[0]!.args).toEqual(["pr", "comment", "9", "--body", "hello", "-R", REPO_SLUG]);
  });

  test("retargetPr", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.retargetPr(asPrNumber(9), "main");
    expect(calls[0]!.args).toEqual(["pr", "edit", "9", "--base", "main", "-R", REPO_SLUG]);
  });

  test("labelIssue / labelPr add a single label", () => {
    const { run, calls } = fakeRun(["", ""]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.labelIssue(9, "phoebe:quarantined");
    github.labelPr(asPrNumber(10), "phoebe:quarantined");
    expect(calls[0]!.args).toEqual([
      "issue",
      "edit",
      "9",
      "--add-label",
      "phoebe:quarantined",
      "-R",
      REPO_SLUG,
    ]);
    expect(calls[1]!.args).toEqual([
      "pr",
      "edit",
      "10",
      "--add-label",
      "phoebe:quarantined",
      "-R",
      REPO_SLUG,
    ]);
  });

  test("unlabelIssue / unlabelPr remove a single label", () => {
    const { run, calls } = fakeRun(["", ""]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.unlabelIssue(9, "phoebe:quarantined");
    github.unlabelPr(asPrNumber(10), "phoebe:quarantined");
    expect(calls[0]!.args).toEqual([
      "issue",
      "edit",
      "9",
      "--remove-label",
      "phoebe:quarantined",
      "-R",
      REPO_SLUG,
    ]);
    expect(calls[1]!.args).toEqual([
      "pr",
      "edit",
      "10",
      "--remove-label",
      "phoebe:quarantined",
      "-R",
      REPO_SLUG,
    ]);
  });

  test("linkStack registers the bottom-to-top branch pair, scoped", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.linkStack(asBranchRef("phoebe/issue-8"), asBranchRef("phoebe/issue-9"));
    expect(calls[0]!.args).toEqual([
      "stack",
      "link",
      "phoebe/issue-8",
      "phoebe/issue-9",
      "-R",
      REPO_SLUG,
    ]);
  });
});

describe("createPr — stdin piping, scoped", () => {
  test("pipes body via --body-file - and input", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.createPr({
      head: asBranchRef("phoebe/issue-9"),
      base: "main",
      title: "Phoebe: fix the thing (#9)",
      body: "the pr body",
    });
    expect(calls[0]).toEqual({
      args: [
        "pr",
        "create",
        "--head",
        "phoebe/issue-9",
        "--base",
        "main",
        "--title",
        "Phoebe: fix the thing (#9)",
        "--body-file",
        "-",
        "-R",
        REPO_SLUG,
      ],
      opts: { stdio: "inherit", timeoutMs: 120_000, input: "the pr body" },
    });
  });
});

describe("unscoped methods — installStackExtension / login / updateComment / resolveReviewThread / minimizeComment", () => {
  test("installStackExtension has no -R", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.installStackExtension();
    expect(calls[0]!.args).toEqual(["extension", "install", "github/gh-stack"]);
  });

  test("login has no -R and returns the authenticated user's login", () => {
    const { run, calls } = fakeRun([JSON.stringify({ login: "phoebe-bot" })]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(github.login()).toBe("phoebe-bot");
    expect(calls[0]!.args).toEqual(["api", "user"]);
  });

  test("updateComment edits by GraphQL node id, no -R", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.updateComment("PRIC_kwABC", "new body");
    expect(calls[0]!.args).toEqual([
      "api",
      "graphql",
      "-f",
      "query=mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id, body:$body}){issueComment{id}}}",
      "-f",
      "id=PRIC_kwABC",
      "-f",
      "body=new body",
    ]);
  });

  test("resolveReviewThread resolves by GraphQL node id, no -R", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.resolveReviewThread("PRRT_kwABC");
    expect(calls[0]!.args).toEqual([
      "api",
      "graphql",
      "-f",
      "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}",
      "-f",
      "id=PRRT_kwABC",
    ]);
  });

  test("minimizeComment collapses by GraphQL node id + classifier, no -R", () => {
    const { run, calls } = fakeRun();
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.minimizeComment("PRIC_kwABC", "OUTDATED");
    expect(calls[0]!.args).toEqual([
      "api",
      "graphql",
      "-f",
      "query=mutation($id:ID!,$classifier:ReportedContentClassifiers!){minimizeComment(input:{subjectId:$id, classifier:$classifier}){minimizedComment{isMinimized}}}",
      "-f",
      "id=PRIC_kwABC",
      "-f",
      "classifier=OUTDATED",
    ]);
  });
});

describe("timeout forwarding", () => {
  test("the factory's timeoutMs default reaches every run() call", () => {
    const { run, calls } = fakeRun([JSON.stringify({ body: "x" })]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run, timeoutMs: 5_000 });
    github.issueBody(1);
    expect(calls[0]!.opts).toEqual({ timeoutMs: 5_000 });
  });

  test("defaults to 120_000 when not configured", () => {
    const { run, calls } = fakeRun([JSON.stringify({ body: "x" })]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    github.issueBody(1);
    expect(calls[0]!.opts).toEqual({ timeoutMs: 120_000 });
  });
});

describe("uniform error mode", () => {
  test("a run() failure becomes a GhCommandError carrying argv + cause", () => {
    const cause = new Error("rate limited");
    const { run } = fakeRun([cause]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    let caught: unknown;
    try {
      github.issueBody(1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GhCommandError);
    const error = caught as GhCommandError;
    expect(error.argv).toEqual(["issue", "view", "1", "--json", "body", "-R", REPO_SLUG]);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("rate limited");
  });

  test("malformed JSON also throws the uniform error, not a raw SyntaxError", () => {
    const { run } = fakeRun(["not json"]);
    const github = createGitHub({ repoSlug: REPO_SLUG, run });
    expect(() => github.issueBody(1)).toThrow(GhCommandError);
  });
});

describe("defaultGhRun — the real runner seam", () => {
  test("shells out to the real gh binary and returns its stdout", () => {
    const output = defaultGhRun(["--version"]);
    expect(output).toContain("gh version");
  });
});
