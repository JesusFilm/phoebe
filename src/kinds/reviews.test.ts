// The `reviews` kind, exercised through its `WorkKind` interface. `select`
// folds in the old `selectReviewsUnit`/`hasNewNonPhoebeReviewActivity` filter
// matrix; `run` covers the handled-comment paths built on the now-unexported
// `buildReviewsHandledComment`/`isReviewSummaryComment`/
// `newestReviewThreadCommentCreatedAt`.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "../branded.ts";
import { sampleConfig as config } from "../test-config.ts";
import type { ReviewThread } from "../github.ts";
import type { CycleContext } from "../cycle.ts";
import type { Io } from "./kind.ts";
import { createReviewsKind, type ReviewsData, type ReviewsUnit } from "./reviews.ts";

let threadIdSeq = 0;

function reviewThread(
  overrides: Partial<ReviewThread> & Pick<ReviewThread, "comments">,
): ReviewThread {
  return { id: `thread-${++threadIdSeq}`, isResolved: false, isOutdated: false, ...overrides };
}

function reviewsPr(
  overrides: Omit<Partial<ReviewsUnit>, "prNumber"> & { prNumber: number },
): ReviewsUnit {
  return {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    threads: [],
    ...overrides,
    prNumber: asPrNumber(overrides.prNumber),
    headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
  };
}

function fakeCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  return {
    mainHead: asSha("main1"),
    openPrs: [],
    login: async () => "phoebe-bot",
    pools: { ready: [], research: [] },
    issueBodies: new Map(),
    blockerStates: new Map(),
    nativeBlockers: new Map(),
    runtimeId: "runtime-1",
    ...overrides,
  };
}

function dataFor(
  prs: readonly ReviewsUnit[],
  ctx: CycleContext,
  phoebeLogin = "phoebe-bot",
): ReviewsData {
  return {
    reviewActivityPrs: prs,
    stack: { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates },
    phoebeLogin,
  };
}

describe("createReviewsKind — select", () => {
  const kind = createReviewsKind({ config, io: fakeIo() });

  test("picks oldest PR with new non-Phoebe review activity", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({ prNumber: 120, threads: [thread] }),
      reviewsPr({ prNumber: 115, threads: [thread] }),
    ];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(115);
  });

  test("skips conflicting PRs", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 110,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        threads: [thread],
      }),
      reviewsPr({ prNumber: 111, threads: [thread] }),
    ];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(111);
  });

  test("skips stacked PRs with an open blocker", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [reviewsPr({ prNumber: 110, issueNumber: 110, threads: [thread] })];
    const ctx = fakeCtx({
      issueBodies: new Map([[110, "Blocked by #108"]]),
      blockerStates: new Map([
        [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
      ]),
    });
    expect(kind.select(dataFor(prs, ctx), ctx)).toBeNull();
  });

  test("skips when the watermark covers all activity", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 110,
        threads: [thread],
        handledWatermark: { latest: "2026-06-03T12:00:00Z" },
      }),
    ];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)).toBeNull();
  });

  test("a human PR with no linked issue and reviewer activity is eligible", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 130,
        headRefName: asBranchRef("feature/human-pr"),
        authorLogin: "human-dev",
        threads: [thread],
      }),
    ];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(130);
  });

  test("ignores Phoebe's own replies and the PR author's own replies", () => {
    const phoebeThread = reviewThread({
      comments: [{ authorLogin: "phoebe-bot", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const authorThread = reviewThread({
      comments: [{ authorLogin: "human-dev", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({ prNumber: 140, authorLogin: "human-dev", threads: [phoebeThread, authorThread] }),
    ];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)).toBeNull();
  });

  test("ignores resolved and outdated threads", () => {
    const resolved = reviewThread({
      isResolved: true,
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const outdated = reviewThread({
      isOutdated: true,
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [reviewsPr({ prNumber: 150, threads: [resolved, outdated] })];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)).toBeNull();
  });
});

describe("createReviewsKind — refFor / oneShot / describeIdle", () => {
  test("is not one-shot eligible — janitor kinds are persistent-mode only", () => {
    expect(createReviewsKind({ config, io: fakeIo() }).oneShot).toBe(false);
  });

  test("refFor identifies the unit by PR number and branch", () => {
    const kind = createReviewsKind({ config, io: fakeIo() });
    expect(kind.refFor(reviewsPr({ prNumber: 42 }))).toEqual({
      kind: "reviews",
      target: { type: "pr", number: 42 },
      branch: asBranchRef("phoebe/issue-42"),
    });
  });

  test("describeIdle explains a non-empty, unfixable pool", () => {
    const kind = createReviewsKind({ config, io: fakeIo() });
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 110,
        threads: [thread],
        handledWatermark: { latest: "2026-06-03T12:00:00Z" },
      }),
    ];
    const ctx = fakeCtx();
    expect(kind.describeIdle?.(dataFor(prs, ctx))).toMatch(/none fixable this cycle/);
  });

  test("describeIdle is null for an empty pool", () => {
    const kind = createReviewsKind({ config, io: fakeIo() });
    expect(kind.describeIdle?.(dataFor([], fakeCtx()))).toBeNull();
  });
});

describe("createReviewsKind — run", () => {
  const thread = reviewThread({
    comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
  });
  const unit = reviewsPr({ prNumber: 200, threads: [thread] });

  test("a posted summary comment marks the run handled (marker-only comment)", async () => {
    const posted: Array<{ prNumber: number; body: string }> = [];
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prActivity: () => ({
          headRefOid: asSha("aaa"),
          lastCommitAt: null,
          comments: [
            {
              id: "c1",
              // Far in the future so it is always ">" the run's captured start time.
              createdAt: "2030-01-01T00:00:00Z",
              authorLogin: "phoebe-bot",
              body: "## Review feedback addressed\n\nFixed the thing.",
            },
          ],
          labels: [],
        }),
        commentPr: (prNumber, body) => {
          posted.push({ prNumber: Number(prNumber), body });
        },
      },
    });
    const kind = createReviewsKind({ config, io });
    const result = await kind.run(unit, fakeCtx());
    expect(result.exitCode).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toBe("<!-- phoebe-reviews-handled: latest=2026-06-03T12:00:00Z -->");
  });

  test("no summary and no push posts a visible failure marker", async () => {
    const posted: Array<{ prNumber: number; body: string }> = [];
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prActivity: () => ({
          headRefOid: asSha("aaa"),
          lastCommitAt: null,
          comments: [],
          labels: [],
        }),
        commentPr: (prNumber, body) => {
          posted.push({ prNumber: Number(prNumber), body });
        },
      },
    });
    const kind = createReviewsKind({ config, io });
    await kind.run(unit, fakeCtx());
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("attempted to handle review feedback and failed");
    expect(posted[0]?.body).toContain(
      "<!-- phoebe-reviews-handled: latest=2026-06-03T12:00:00Z -->",
    );
  });

  test("a successful fix push resolves the pre-run eligible threads, skipping already-resolved/outdated ones (#169)", async () => {
    const resolved: string[] = [];
    const fixThread = reviewThread({
      id: "t-fix",
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const alreadyResolvedThread = reviewThread({
      id: "t-done",
      isResolved: true,
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-01T00:00:00Z" }],
    });
    const outdatedThread = reviewThread({
      id: "t-outdated",
      isOutdated: true,
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-01T00:00:00Z" }],
    });
    const pushedUnit = reviewsPr({
      prNumber: 201,
      threads: [fixThread, alreadyResolvedThread, outdatedThread],
    });
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        resolveReviewThread: (threadId) => {
          resolved.push(threadId);
        },
      },
      git: { ...fakeIo().git, commitCount: () => 1 },
    });
    const kind = createReviewsKind({ config, io });
    await kind.run(pushedUnit, fakeCtx());
    expect(resolved).toEqual(["t-fix"]);
  });

  test("no push means no thread is resolved", async () => {
    const resolved: string[] = [];
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        resolveReviewThread: (threadId) => {
          resolved.push(threadId);
        },
      },
    });
    const kind = createReviewsKind({ config, io });
    await kind.run(unit, fakeCtx());
    expect(resolved).toEqual([]);
  });

  test("minimizes prior Phoebe handled/failure markers as OUTDATED, leaving human comments and the fresh marker alone (#169)", async () => {
    const minimized: Array<{ commentId: string; classifier: string }> = [];
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prActivity: () => ({
          headRefOid: asSha("aaa"),
          lastCommitAt: null,
          comments: [
            {
              id: "old-marker",
              createdAt: "2026-06-01T00:00:00Z",
              authorLogin: "phoebe-bot",
              body: "<!-- phoebe-reviews-handled: latest=2026-05-01T00:00:00Z -->",
            },
            {
              id: "old-failure-marker",
              createdAt: "2026-06-02T00:00:00Z",
              authorLogin: "phoebe-bot",
              body:
                "Phoebe attempted to handle review feedback and failed; will retry on new review activity.\n\n" +
                "<!-- phoebe-reviews-handled: latest=2026-05-02T00:00:00Z -->",
            },
            {
              id: "human-comment",
              createdAt: "2026-06-02T12:00:00Z",
              authorLogin: "reviewer",
              body: "still not happy with this",
            },
          ],
          labels: [],
        }),
        minimizeComment: (commentId, classifier) => {
          minimized.push({ commentId, classifier });
        },
      },
    });
    const kind = createReviewsKind({ config, io });
    await kind.run(unit, fakeCtx());
    expect(minimized).toEqual([
      { commentId: "old-marker", classifier: "OUTDATED" },
      { commentId: "old-failure-marker", classifier: "OUTDATED" },
    ]);
  });
});

describe("createReviewsKind — labels (#155)", () => {
  test("fetch populates a unit's labels from prActivity, the same call it already reads comments from", async () => {
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prMergeInfo: () => ({
          number: asPrNumber(600),
          headRefName: asBranchRef("phoebe/issue-600"),
          baseRefName: asBranchRef("main"),
          headRefOid: asSha("head1"),
          baseRefOid: asSha("base1"),
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
        reviewThreads: () => [
          reviewThread({
            comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
          }),
        ],
        prActivity: () => ({
          headRefOid: asSha("aaa"),
          lastCommitAt: null,
          comments: [],
          labels: ["phoebe:tier:mid"],
        }),
      },
    });
    const kind = createReviewsKind({ config, io });
    const data = await kind.fetch(
      fakeCtx({
        openPrs: [
          {
            number: asPrNumber(600),
            headRefName: asBranchRef("phoebe/issue-600"),
            baseRefName: asBranchRef("main"),
            authorLogin: "someone-else",
          },
        ],
      }),
    );
    expect(data.reviewActivityPrs[0]?.labels).toEqual(["phoebe:tier:mid"]);
  });

  test("run threads a unit's labels to io.agent.run", async () => {
    let receivedLabels: readonly string[] | undefined;
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const unit = reviewsPr({ prNumber: 700, threads: [thread], labels: ["phoebe:tier:mid"] });
    const io = fakeIo({
      agent: {
        run: async (opts) => {
          receivedLabels = opts.labels;
          return { exitCode: 0 };
        },
      },
    });
    const kind = createReviewsKind({ config, io });

    await kind.run(unit, fakeCtx());

    expect(receivedLabels).toEqual(["phoebe:tier:mid"]);
  });
});

function fakeIo(overrides: Partial<Io> = {}): Io {
  return {
    github: {
      issuesWithLabel: () => [],
      issueBody: () => "",
      issueActivity: () => ({
        updatedAt: "2026-01-01T00:00:00Z",
        comments: [],
        labels: [],
        body: "",
      }),
      nativeBlockers: () => [],
      labelRemovals: () => [],
      prNumberForHead: () => undefined,
      openPrs: () => [],
      prsWithLabel: () => [],
      prMergeInfo: () => {
        throw new Error("not implemented in fake");
      },
      prActivity: () => ({
        headRefOid: asSha("aaa"),
        lastCommitAt: null,
        comments: [],
        labels: [],
      }),
      reviewThreads: () => [],
      commitCheckRuns: () => [],
      resolveReviewThread: () => {},
      minimizeComment: () => {},
      commentIssue: () => {},
      commentPr: () => {},
      createPr: () => {},
      retargetPr: () => {},
      labelIssue: () => {},
      unlabelIssue: () => {},
      labelPr: () => {},
      unlabelPr: () => {},
      linkStack: () => {},
      installStackExtension: () => {},
      login: () => "phoebe-bot",
      updateComment: () => {},
    },
    git: {
      fetchOrigin: () => {},
      originBranchSha: () => asSha("abc123"),
      prepareWorktree: () => "/tmp/worktree",
      removeWorktree: () => {},
      pushBranch: () => {},
      commitCount: () => 0,
      gitInWorktree: () => "",
    },
    agent: { run: async () => ({ exitCode: 0 }) },
    prompts: {
      load: () => "template",
      defaultArgs: () => ({}),
      render: (template) => template,
    },
    shell: { run: () => {} },
    quarantine: { record: () => {}, resolve: () => {}, sweepUnstuck: () => {} },
    ...overrides,
  };
}
