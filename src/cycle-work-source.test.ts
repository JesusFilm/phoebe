// Cache-invariant tests for the work source's cycle-scoped issue-body store.
// These are the only assertions that selection tests (src/main.test.ts) cannot
// reach: the cache lives inside gatherCycle and is never exposed through the
// record — only its effect (each body fetched once) is observable here.

import { describe, expect, test } from "vite-plus/test";
import { asPrNumber, asSha, type PrNumber } from "./branded.ts";
import type { CycleGitHubClient, GitHubClient } from "./github-client.ts";
import type { OriginHub } from "./origin-hub.ts";
import { issueBranch } from "./orchestrator.ts";
import { createWorkSource } from "./cycle-work-source.ts";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

type IssueBodySpy = {
  issueBody: GitHubClient["issueBody"];
  callCount: () => number;
};

function spyIssueBody(body = "no body"): IssueBodySpy {
  let count = 0;
  return {
    issueBody: (_n) => {
      count++;
      return body;
    },
    callCount: () => count,
  };
}

function failingCheckItems() {
  return [{ workflowName: "CI", status: "completed", conclusion: "failure" }];
}

/**
 * Build a minimal GitHubClient stub for the checks kind.
 * Each PR listed in `prNumbers` maps to `issueNumber` via its branch name.
 */
function checksGitHub(opts: {
  prNumbers: number[];
  issueNumber: number;
  issueBody: GitHubClient["issueBody"];
  blockerPrState?: GitHubClient["blockerPrState"];
}): GitHubClient {
  const { prNumbers, issueNumber } = opts;
  const branch = issueBranch(issueNumber);
  const sha = (n: number) => asSha(`${"f" + n}`.padEnd(40, "0"));

  const cycle: CycleGitHubClient = {
    openPrs: () =>
      prNumbers.map((n) => ({
        number: asPrNumber(n),
        headRefName: branch,
        authorLogin: "phoebe-bot",
      })),
    mergeInfo: (prNumber: PrNumber) =>
      Promise.resolve({
        number: prNumber,
        headRefName: branch,
        headRefOid: sha(Number(prNumber)),
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    prCommentBodies: () => [],
    resolveLogin: () => "phoebe-bot",
    reviewThreads: () => [],
  } as unknown as CycleGitHubClient;

  return {
    forCycle: () => cycle,
    issueBody: opts.issueBody,
    commitCheckItems: () => failingCheckItems(),
    blockerPrState: opts.blockerPrState ?? (() => ({ open: false, merged: true })),
    listReadyIssues: () => [],
    listResearchIssues: () => [],
  } as unknown as GitHubClient;
}

function noopOriginHub(): OriginHub {
  return {
    fetch: () => {},
    branchHead: () => asSha("a".padEnd(40, "0")),
    worktreeDirFor: () => "/tmp/stub",
    addWorktreeForNew: () => {},
    addWorktreeForExisting: () => {},
    removeWorktree: () => {},
    commitCount: () => 0,
    pushBranch: () => {},
    appendTrailerToCommits: () => "nothing" as const,
  };
}

const stubClock = { sleep: () => Promise.resolve(), now: () => new Date() };

// ---------------------------------------------------------------------------
// Cache invariant: one body per issue per gather
// ---------------------------------------------------------------------------

describe("cycle-scoped issue-body cache", () => {
  test("two PRs sharing one issue number → issueBody fetched once per gather", async () => {
    const spy = spyIssueBody("body for issue 42");
    const github = checksGitHub({ prNumbers: [1, 2], issueNumber: 42, issueBody: spy.issueBody });
    const workSource = createWorkSource({
      github,
      originHub: noopOriginHub(),
      clock: stubClock,
      env: {},
      defaultBranchRef: issueBranch(99),
    });

    await workSource.gatherCycle(["checks"]);
    expect(spy.callCount()).toBe(1);
  });

  test("a second gather fetches the same issue body again", async () => {
    const spy = spyIssueBody("body for issue 42");
    const github = checksGitHub({ prNumbers: [1], issueNumber: 42, issueBody: spy.issueBody });
    const workSource = createWorkSource({
      github,
      originHub: noopOriginHub(),
      clock: stubClock,
      env: {},
      defaultBranchRef: issueBranch(99),
    });

    await workSource.gatherCycle(["checks"]);
    await workSource.gatherCycle(["checks"]);
    expect(spy.callCount()).toBe(2);
  });

  test("same issue gathered by two kinds in one cycle → fetched once", async () => {
    let bodyCallCount = 0;
    const issueBodySpy: GitHubClient["issueBody"] = (_n) => {
      bodyCallCount++;
      return "shared body";
    };

    // checks and conflicts kind both reference the same issue number 55.
    const branch = issueBranch(55);
    const sha = asSha("c".padEnd(40, "0"));

    const cycle: CycleGitHubClient = {
      openPrs: () => [{ number: asPrNumber(10), headRefName: branch, authorLogin: "phoebe-bot" }],
      mergeInfo: (prNumber: PrNumber) =>
        Promise.resolve({
          number: prNumber,
          headRefName: branch,
          headRefOid: sha,
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        }),
      prCommentBodies: () => [],
      resolveLogin: () => "phoebe-bot",
      reviewThreads: () => [],
    } as unknown as CycleGitHubClient;

    const github: GitHubClient = {
      forCycle: () => cycle,
      issueBody: issueBodySpy,
      commitCheckItems: () => failingCheckItems(),
      blockerPrState: () => ({ open: false, merged: true }),
      listReadyIssues: () => [],
      listResearchIssues: () => [],
    } as unknown as GitHubClient;

    const originHub = noopOriginHub();
    const workSource = createWorkSource({
      github,
      originHub,
      clock: stubClock,
      env: {},
      defaultBranchRef: issueBranch(99),
    });

    // conflicts will gather PR #10 (CONFLICTING → candidate) and populate issue body 55.
    // checks will try to gather the same PR but mergeInfo says CONFLICTING so it's skipped.
    // The issue body for 55 should only be fetched once.
    await workSource.gatherCycle(["conflicts", "checks"]);
    expect(bodyCallCount).toBe(1);
  });
});
