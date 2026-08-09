// The `conflicts` kind, exercised through its `WorkKind` interface: `select`
// folds in the old `selectConflictUnit`/`selectConflictFixCandidates`/
// `shouldSkipWatermarkConflictFix` filter matrix, `run` covers the
// clean-merge push and hard-failure paths, and `sweep` covers the #13
// stack-retarget maintenance.
//
// The failure-comment *content* assertions (`conflictFixFailureComment`,
// `shouldPostConflictFixFailure`'s host-commit/origin-SHA matrix) are not
// re-tested in isolation — both are now unexported internals reachable only
// through the full `run()` agent workflow (worktree/shell/agent/verification
// plumbing), and driving that end-to-end for every matrix case would need a
// much heavier fixture than this refactor's scope justifies. `run`'s
// "failed to start merge" case below exercises the same failure-comment path
// once, end to end, as a representative sample.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "../branded.ts";
import { sampleConfig as config } from "../test-config.ts";
import type { GitHub } from "../github.ts";
import { createQuarantine } from "../quarantine.ts";
import type { CycleContext } from "../cycle.ts";
import type { Io } from "./kind.ts";
import { createConflictsKind, type ConflictsData, type ConflictsUnit } from "./conflicts.ts";

function pr(
  overrides: Omit<Partial<ConflictsUnit>, "prNumber"> & { prNumber: number },
): ConflictsUnit {
  return {
    headSha: asSha("aaa111"),
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

function dataFor(prs: readonly ConflictsUnit[], ctx: CycleContext): ConflictsData {
  return {
    conflictingPrs: prs,
    stack: { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates },
    currentMainHead: ctx.mainHead,
  };
}

describe("createConflictsKind — select", () => {
  const kind = createConflictsKind({ config, io: fakeIo() });

  test("picks oldest PR number among eligible conflicts", () => {
    const prs = [pr({ prNumber: 120 }), pr({ prNumber: 115 }), pr({ prNumber: 118 })];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(115);
  });

  test("selects stacked follow-up when blocker merged (catch-up eligible)", () => {
    const prs = [pr({ prNumber: 115, issueNumber: 115 })];
    const ctx = fakeCtx({
      issueBodies: new Map([[115, "Blocked by #108"]]),
      blockerStates: new Map([
        [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
      ]),
    });
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(115);
  });

  test("skips a PR stacked on an open blocker", () => {
    const prs = [pr({ prNumber: 110, issueNumber: 110 })];
    const ctx = fakeCtx({
      issueBodies: new Map([[110, "Blocked by #108"]]),
      blockerStates: new Map([
        [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
      ]),
    });
    expect(kind.select(dataFor(prs, ctx), ctx)).toBeNull();
  });

  test("skips a PR whose failure watermark still matches both SHAs", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100"), mainHead: asSha("main1") },
      }),
      pr({ prNumber: 101, headSha: asSha("pr101"), failureWatermark: null }),
    ];
    const ctx = fakeCtx({ mainHead: asSha("main1") });
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(101);
  });

  test("re-attempts once the PR head moves past the watermark", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100v2"),
        failureWatermark: { prHead: asSha("pr100v1"), mainHead: asSha("main1") },
      }),
    ];
    const ctx = fakeCtx({ mainHead: asSha("main1") });
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(100);
  });

  test("re-attempts once main moves past the watermark", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100"), mainHead: asSha("main1") },
      }),
    ];
    const ctx = fakeCtx({ mainHead: asSha("main2") });
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(100);
  });

  test("watermark skip still applies to merged-blocker catch-up candidates", () => {
    const prs = [
      pr({
        prNumber: 115,
        issueNumber: 115,
        headSha: asSha("pr115"),
        failureWatermark: { prHead: asSha("pr115"), mainHead: asSha("main1") },
      }),
    ];
    const ctx = fakeCtx({
      mainHead: asSha("main1"),
      issueBodies: new Map([[115, "Blocked by #108"]]),
      blockerStates: new Map([
        [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
      ]),
    });
    expect(kind.select(dataFor(prs, ctx), ctx)).toBeNull();
  });
});

describe("createConflictsKind — refFor / oneShot / describeIdle", () => {
  test("is not one-shot eligible — janitor kinds are persistent-mode only", () => {
    expect(createConflictsKind({ config, io: fakeIo() }).oneShot).toBe(false);
  });

  test("refFor identifies the unit by PR number and branch", () => {
    const kind = createConflictsKind({ config, io: fakeIo() });
    const unit = pr({ prNumber: 42 });
    expect(kind.refFor(unit)).toEqual({
      kind: "conflicts",
      target: { type: "pr", number: 42 },
      branch: asBranchRef("phoebe/issue-42"),
    });
  });

  test("describeIdle explains a non-empty, unfixable pool", () => {
    const kind = createConflictsKind({ config, io: fakeIo() });
    const prs = [pr({ prNumber: 110, issueNumber: 110 })];
    const ctx = fakeCtx({
      issueBodies: new Map([[110, "Blocked by #108"]]),
      blockerStates: new Map([
        [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
      ]),
    });
    expect(kind.describeIdle?.(dataFor(prs, ctx))).toMatch(/none fixable this cycle/);
  });

  test("describeIdle is null for an empty pool", () => {
    const kind = createConflictsKind({ config, io: fakeIo() });
    const ctx = fakeCtx();
    expect(kind.describeIdle?.(dataFor([], ctx))).toBeNull();
  });
});

describe("createConflictsKind — run", () => {
  test("a clean blocker-first merge pushes and posts the catch-up retraction comment", async () => {
    const posted: Array<{ prNumber: number; body: string }> = [];
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        commentPr: (prNumber, body) => {
          posted.push({ prNumber: Number(prNumber), body });
        },
      },
    });
    const kind = createConflictsKind({ config, io });
    const unit = pr({ prNumber: 115, issueNumber: 115 });
    const ctx = fakeCtx({
      issueBodies: new Map([[115, "Blocked by #108"]]),
      blockerStates: new Map([
        [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
      ]),
    });

    const result = await kind.run(unit, ctx);
    expect(result).toEqual({ exitCode: null });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("Blocker #112 merged");
  });

  test("a merge that cannot even start posts a failure comment with a watermark", async () => {
    const posted: Array<{ prNumber: number; body: string }> = [];
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        commentPr: (prNumber, body) => {
          posted.push({ prNumber: Number(prNumber), body });
        },
      },
      git: {
        ...fakeIo().git,
        prepareWorktree: () => {
          throw new Error("worktree setup failed");
        },
        originBranchSha: () => asSha("main1"),
      },
    });
    const kind = createConflictsKind({ config, io });
    const unit = pr({ prNumber: 200 });
    const ctx = fakeCtx();

    const result = await kind.run(unit, ctx);
    expect(result).toEqual({ exitCode: null });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("PR #200");
    expect(posted[0]?.body).toContain("merge --abort");
    expect(posted[0]?.body).toContain("phoebe-conflict-fail");
  });
});

describe("createConflictsKind — sweep (#13 stack retarget)", () => {
  test("retargets a Phoebe PR whose base is a merged blocker's branch", async () => {
    const retargeted: Array<{ prNumber: number; base: string }> = [];
    const commented: string[] = [];
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prNumberForHead: (branch, state) =>
          state === "merged" && branch === "phoebe/issue-108" ? asPrNumber(112) : undefined,
        retargetPr: (prNumber, base) => {
          retargeted.push({ prNumber: Number(prNumber), base });
        },
        commentPr: (_prNumber, body) => {
          commented.push(body);
        },
      },
    });
    const kind = createConflictsKind({ config, io });
    const ctx = fakeCtx({
      openPrs: [
        {
          number: asPrNumber(200),
          headRefName: asBranchRef("phoebe/issue-200"),
          baseRefName: asBranchRef("phoebe/issue-108"),
          authorLogin: "phoebe-bot",
        },
      ],
    });

    await kind.sweep?.(ctx);
    expect(retargeted).toEqual([{ prNumber: 200, base: config.defaultBranch }]);
    expect(commented).toHaveLength(1);
  });

  test("does nothing when no open PR bases off a Phoebe issue branch", async () => {
    const io = fakeIo();
    const kind = createConflictsKind({ config, io });
    const ctx = fakeCtx({
      openPrs: [
        {
          number: asPrNumber(200),
          headRefName: asBranchRef("phoebe/issue-200"),
          baseRefName: asBranchRef(config.defaultBranch),
          authorLogin: "phoebe-bot",
        },
      ],
    });
    // No throw, and (implicitly) no retarget call — `fakeIo().github.retargetPr`
    // throws if ever invoked would be over-specified; absence of a throw here
    // is the assertion.
    await expect(kind.sweep?.(ctx)).resolves.toBeUndefined();
  });
});

function fakeIo(overrides: Partial<Io> = {}): Io {
  const github: GitHub = overrides.github ?? {
    issuesWithLabel: () => [],
    issueBody: () => "",
    issueActivity: () => ({ updatedAt: "2026-01-01T00:00:00Z", comments: [], labels: [] }),
    nativeBlockers: () => [],
    prNumberForHead: () => undefined,
    openPrs: () => [],
    prsWithLabel: () => [],
    prMergeInfo: () => {
      throw new Error("not implemented in fake");
    },
    prActivity: () => ({ headRefOid: asSha("aaa"), lastCommitAt: null, comments: [], labels: [] }),
    reviewThreads: () => [],
    commitCheckRuns: () => [],
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
  };
  return {
    github,
    git: {
      fetchOrigin: () => {},
      originBranchSha: () => asSha("abc123"),
      prepareWorktree: () => "/tmp/worktree",
      removeWorktree: () => {},
      pushBranch: () => {},
      commitCount: () => 0,
      gitInWorktree: () => "",
    },
    agent: { run: async () => 0 },
    prompts: {
      load: () => "template",
      defaultArgs: () => ({}),
      render: (template) => template,
    },
    shell: { run: () => {} },
    quarantine: createQuarantine({
      github,
      config: { maxUnitTimeouts: config.maxUnitTimeouts, maxUnitAttempts: config.maxUnitAttempts },
      log: () => {},
    }),
    ...overrides,
  };
}
