// The shared per-cycle gather: one `openPrs`/`issuesWithLabel` read apiece
// (replacing the old triplicate-plus-retarget reads), scope filtering, the
// merged blocker-state map (issue pools + PR-derived issue bodies), and the
// memoized `login()`.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "./branded.ts";
import { sampleConfig as config } from "./test-config.ts";
import type { GitHub } from "./github.ts";
import type { Io, KindHandle } from "./kinds/kind.ts";
import { gatherCycleContext } from "./cycle.ts";

function fakeGithub(overrides: Partial<GitHub> = {}): GitHub {
  return {
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
    ...overrides,
  };
}

function fakeIo(overrides: Partial<Io> = {}): Io {
  return {
    github: fakeGithub(),
    git: {
      fetchOrigin: () => {},
      originBranchSha: () => asSha("main-sha"),
      prepareWorktree: () => "/tmp/worktree",
      removeWorktree: () => {},
      pushBranch: () => {},
      commitCount: () => 0,
      gitInWorktree: () => "",
    },
    agent: { run: async () => 0 },
    prompts: { load: () => "template", defaultArgs: () => ({}), render: (t) => t },
    shell: { run: () => {} },
    quarantine: { record: () => {}, resolve: () => {}, sweepUnstuck: () => {} },
    ...overrides,
  };
}

const ALL_KINDS: readonly KindHandle[] = [
  {
    name: "conflicts",
    oneShot: false,
    gather: async () => ({ idle: () => null, plan: () => null }),
  },
  { name: "checks", oneShot: false, gather: async () => ({ idle: () => null, plan: () => null }) },
  { name: "reviews", oneShot: false, gather: async () => ({ idle: () => null, plan: () => null }) },
  { name: "issues", oneShot: true, gather: async () => ({ idle: () => null, plan: () => null }) },
  { name: "research", oneShot: true, gather: async () => ({ idle: () => null, plan: () => null }) },
];

describe("gatherCycleContext", () => {
  test("computes mainHead from the default branch", async () => {
    const io = fakeIo({
      git: {
        ...fakeIo().git,
        originBranchSha: (branch) =>
          branch === config.defaultBranch ? asSha("main-sha") : asSha("wrong"),
      },
    });
    const ctx = await gatherCycleContext(
      { config, io, runtimeId: "runtime-1", error: () => {} },
      ALL_KINDS,
    );
    expect(ctx.mainHead).toBe("main-sha");
    expect(ctx.runtimeId).toBe("runtime-1");
  });

  test("scopes open PRs and fetches the ready/research pools scoped by author", async () => {
    const io = fakeIo({
      github: fakeGithub({
        openPrs: () => [
          {
            number: asPrNumber(1),
            headRefName: asBranchRef("phoebe/issue-1"),
            baseRefName: asBranchRef(config.defaultBranch),
            isDraft: false,
            isCrossRepository: false,
            labels: [],
            authorLogin: "phoebe-bot",
          },
          {
            number: asPrNumber(2),
            headRefName: asBranchRef("phoebe/issue-2"),
            baseRefName: asBranchRef(config.defaultBranch),
            isDraft: false,
            isCrossRepository: true,
            labels: [],
            authorLogin: "someone-else",
          },
        ],
        issuesWithLabel: (label) =>
          label === config.readyLabel
            ? [
                {
                  number: 10,
                  title: "Ready one",
                  body: "",
                  labels: [],
                  createdAt: "2026-01-01T00:00:00Z",
                },
              ]
            : [
                {
                  number: 20,
                  title: "Research one",
                  body: "",
                  labels: [],
                  createdAt: "2026-01-01T00:00:00Z",
                },
              ],
      }),
    });
    const ctx = await gatherCycleContext(
      { config, io, runtimeId: "runtime-1", error: () => {} },
      ALL_KINDS,
    );
    // Cross-repository PRs are out of scope regardless of prScope/draftPrs config.
    expect(ctx.openPrs.map((pr) => pr.number)).toEqual([1]);
    expect(ctx.pools.ready.map((i) => i.number)).toEqual([10]);
    expect(ctx.pools.research.map((i) => i.number)).toEqual([20]);
  });

  test("merges blocker state from the issue pools and from PR-derived issue bodies", async () => {
    const branchPrefix = config.branchPrefix;
    const io = fakeIo({
      github: fakeGithub({
        openPrs: () => [
          {
            number: asPrNumber(5),
            headRefName: asBranchRef(`${branchPrefix}issue-102`),
            baseRefName: asBranchRef(config.defaultBranch),
            isDraft: false,
            isCrossRepository: false,
            labels: [],
            authorLogin: "phoebe-bot",
          },
        ],
        issuesWithLabel: (label) =>
          label === config.readyLabel
            ? [
                {
                  number: 101,
                  title: "Blocked issue",
                  body: "Blocked by #100",
                  labels: [],
                  createdAt: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        issueBody: (n) => (n === 102 ? "Blocked by #100" : ""),
        prNumberForHead: (branch, state) =>
          branch === asBranchRef(`${branchPrefix}issue-100`) && state === "open"
            ? asPrNumber(200)
            : undefined,
      }),
    });
    const ctx = await gatherCycleContext(
      { config, io, runtimeId: "runtime-1", error: () => {} },
      ALL_KINDS,
    );
    expect(ctx.issueBodies.get(102)).toBe("Blocked by #100");
    // Blocker #100 is referenced from both the ready-pool issue (#101) and the
    // PR-derived body (#102) — one merged entry either way.
    expect(ctx.blockerStates.get(100)).toEqual({
      hasOpenPr: true,
      openPrNumber: 200,
      hasMergedPr: false,
      mergedPrNumber: undefined,
    });
  });

  test("login() is memoized across calls within one cycle", async () => {
    let calls = 0;
    const io = fakeIo({ github: fakeGithub({ login: () => (calls++, "phoebe-bot") }) });
    const ctx = await gatherCycleContext(
      { config, io, runtimeId: "runtime-1", error: () => {} },
      ALL_KINDS,
    );
    expect(await ctx.login()).toBe("phoebe-bot");
    expect(await ctx.login()).toBe("phoebe-bot");
    expect(calls).toBe(1);
  });

  test("a native-blocker lookup failure warns and treats the issue as unblocked-by-native this cycle", async () => {
    const errors: string[] = [];
    const io = fakeIo({
      github: fakeGithub({
        issuesWithLabel: (label) =>
          label === config.readyLabel
            ? [{ number: 10, title: "t", body: "", labels: [], createdAt: "2026-01-01T00:00:00Z" }]
            : [],
        nativeBlockers: () => {
          throw new Error("api down");
        },
      }),
    });
    const ctx = await gatherCycleContext(
      {
        config: { ...config, blockerSource: "native" },
        io,
        runtimeId: "runtime-1",
        error: (m) => errors.push(m),
      },
      ALL_KINDS,
    );
    expect(ctx.nativeBlockers.get(10)).toBeUndefined();
    expect(errors.some((m) => m.includes("Native blocker lookup failed"))).toBe(true);
  });
});
