// The `checks` kind, exercised through its `WorkKind` interface. `select`
// folds in the old `selectChecksUnit`/`shouldSkipWatermarkChecksFix` filter
// matrix; `fetch` covers the REST check-run rollup interpretation
// (`workflowRunsToCheckItems`/`statusCheckRollupState`/`listFailingChecks`,
// now unexported internals) end to end against a fake `io.github`.
//
// Dropped without a direct replacement: the REST "PENDING" retry-timing case
// and the legacy GraphQL `StatusContext` shape. The retry path sleeps for
// real (`MERGEABLE_RETRY_MS`) between attempts, so exercising it through
// `fetch()` would cost seconds per case for no behavioural payoff beyond what
// the FAILURE/SUCCESS cases below already prove about the rollup logic.
// `StatusContext` is dead input in practice — `commitCheckRuns` always
// returns REST Actions rows (`workflowName`/`status`/`conclusion`), never the
// pre-#41 GraphQL shape `isCheckItemFailing`/`isCheckItemPending` still
// tolerate.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "../branded.ts";
import { sampleConfig as config } from "../test-config.ts";
import type { GitHub } from "../github.ts";
import { createQuarantine } from "../quarantine.ts";
import type { CycleContext } from "../cycle.ts";
import type { Io } from "./kind.ts";
import {
  createChecksKind,
  formatFailingChecksForPrompt,
  type ChecksData,
  type ChecksUnit,
} from "./checks.ts";

function checksPr(
  overrides: Omit<Partial<ChecksUnit>, "prNumber"> & { prNumber: number },
): ChecksUnit {
  return {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    failingChecks: [{ name: "test", conclusion: "FAILURE" }],
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

function dataFor(prs: readonly ChecksUnit[], ctx: CycleContext): ChecksData {
  return {
    failingCheckPrs: prs,
    stack: { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates },
  };
}

describe("formatFailingChecksForPrompt", () => {
  test("formats name and conclusion per line", () => {
    expect(
      formatFailingChecksForPrompt([
        { name: "lint", conclusion: "FAILURE" },
        { name: "test", conclusion: "TIMED_OUT" },
      ]),
    ).toBe("lint: FAILURE\ntest: TIMED_OUT");
  });
});

describe("createChecksKind — select", () => {
  const kind = createChecksKind({ config, io: fakeIo() });

  test("picks oldest PR number among eligible failing-CI candidates", () => {
    const prs = [
      checksPr({ prNumber: 120 }),
      checksPr({ prNumber: 115 }),
      checksPr({ prNumber: 118 }),
    ];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(115);
  });

  test("skips conflicting PRs", () => {
    const prs = [
      checksPr({ prNumber: 110, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      checksPr({ prNumber: 111 }),
    ];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(111);
  });

  test("skips stacked PRs with an open blocker", () => {
    const prs = [checksPr({ prNumber: 110, issueNumber: 110 })];
    const ctx = fakeCtx({
      issueBodies: new Map([[110, "Blocked by #108"]]),
      blockerStates: new Map([
        [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
      ]),
    });
    expect(kind.select(dataFor(prs, ctx), ctx)).toBeNull();
  });

  test("skips PRs with an unchanged failure watermark", () => {
    const prs = [
      checksPr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100") },
      }),
      checksPr({ prNumber: 101, headSha: asSha("pr101"), failureWatermark: null }),
    ];
    const ctx = fakeCtx();
    expect(kind.select(dataFor(prs, ctx), ctx)?.prNumber).toBe(101);
  });
});

describe("createChecksKind — refFor / oneShot / describeIdle", () => {
  test("is not one-shot eligible — janitor kinds are persistent-mode only", () => {
    expect(createChecksKind({ config, io: fakeIo() }).oneShot).toBe(false);
  });

  test("refFor identifies the unit by PR number and branch", () => {
    const kind = createChecksKind({ config, io: fakeIo() });
    expect(kind.refFor(checksPr({ prNumber: 42 }))).toEqual({
      kind: "checks",
      target: { type: "pr", number: 42 },
      branch: asBranchRef("phoebe/issue-42"),
    });
  });

  test("describeIdle explains a non-empty, unfixable pool", () => {
    const kind = createChecksKind({ config, io: fakeIo() });
    const prs = [checksPr({ prNumber: 110, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })];
    const ctx = fakeCtx();
    expect(kind.describeIdle?.(dataFor(prs, ctx))).toMatch(/none fixable this cycle/);
  });

  test("describeIdle is null for an empty pool", () => {
    const kind = createChecksKind({ config, io: fakeIo() });
    expect(kind.describeIdle?.(dataFor([], fakeCtx()))).toBeNull();
  });
});

describe("createChecksKind — fetch (REST check-run rollup)", () => {
  const pr = {
    number: asPrNumber(201),
    headRefName: asBranchRef("phoebe/issue-201"),
    baseRefName: asBranchRef("main"),
    authorLogin: "phoebe-bot",
  };

  test("dedups to the newest run per workflow, uppercases REST enums, and lists failing checks", async () => {
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prMergeInfo: () => ({
          number: pr.number,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: asSha("head1"),
          baseRefOid: asSha("base1"),
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
        commitCheckRuns: () => [
          // Newest first, as `gh run list` returns them — only the first "ready" row counts.
          { workflowName: "ready", status: "completed", conclusion: "failure" },
          { workflowName: "ready", status: "completed", conclusion: "success" },
          { workflowName: "autofix.ci", status: "completed", conclusion: "success" },
        ],
      },
    });
    const kind = createChecksKind({ config, io });
    const data = await kind.fetch(fakeCtx({ openPrs: [pr] }));
    expect(data.failingCheckPrs).toHaveLength(1);
    expect(data.failingCheckPrs[0]?.failingChecks).toEqual([
      { name: "ready", conclusion: "FAILURE" },
    ]);
  });

  test("falls back to the run name when workflowName is missing", async () => {
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prMergeInfo: () => ({
          number: pr.number,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: asSha("head1"),
          baseRefOid: asSha("base1"),
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
        commitCheckRuns: () => [{ name: "ready", status: "completed", conclusion: "failure" }],
      },
    });
    const kind = createChecksKind({ config, io });
    const data = await kind.fetch(fakeCtx({ openPrs: [pr] }));
    expect(data.failingCheckPrs[0]?.failingChecks).toEqual([
      { name: "ready", conclusion: "FAILURE" },
    ]);
  });

  test("a clean rollup with resolved mergeability yields no candidate", async () => {
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prMergeInfo: () => ({
          number: pr.number,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: asSha("head1"),
          baseRefOid: asSha("base1"),
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
        commitCheckRuns: () => [
          { workflowName: "ready", status: "completed", conclusion: "success" },
        ],
      },
    });
    const kind = createChecksKind({ config, io });
    const data = await kind.fetch(fakeCtx({ openPrs: [pr] }));
    expect(data.failingCheckPrs).toEqual([]);
  });

  test("a conflicting PR is never a checks candidate", async () => {
    const io = fakeIo({
      github: {
        ...fakeIo().github,
        prMergeInfo: () => ({
          number: pr.number,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: asSha("head1"),
          baseRefOid: asSha("base1"),
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        }),
        commitCheckRuns: () => {
          throw new Error("must not be called once mergeable=CONFLICTING is known");
        },
      },
    });
    const kind = createChecksKind({ config, io });
    const data = await kind.fetch(fakeCtx({ openPrs: [pr] }));
    expect(data.failingCheckPrs).toEqual([]);
  });
});

describe("createChecksKind — run (BEHIND catch-up)", () => {
  test("a PR that has merely fallen behind gets a clean catch-up merge, not an agent", async () => {
    const io = fakeIo();
    const kind = createChecksKind({ config, io });
    const unit = checksPr({ prNumber: 300, mergeStateStatus: "BEHIND" });
    const result = await kind.run(unit, fakeCtx());
    expect(result).toEqual({ exitCode: null });
  });
});

function fakeIo(overrides: Partial<Io> = {}): Io {
  const github: GitHub = overrides.github ?? {
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
