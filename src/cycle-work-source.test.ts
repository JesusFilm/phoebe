// Cache-invariant tests for the work source's cycle-scoped issue-body store.
// These are the only assertions that selection tests (src/main.test.ts) cannot
// reach: the cache lives inside gatherCycle and is never exposed through the
// record — only its effect (each body fetched once) is observable here.

import { describe, expect, test } from "vite-plus/test";
import { asPrNumber, asSha, type PrNumber } from "./branded.ts";
import type { CycleGitHubClient, GitHubClient } from "./github-client.ts";
import type { OriginHub } from "./origin-hub.ts";
import { issueBranch } from "./orchestrator.ts";
import { resolveConfig } from "./config-schema.ts";
import { createWorkSource } from "./cycle-work-source.ts";
import { buildRegistry } from "./work-kinds/registry.ts";
import type { ChecksCandidate } from "./orchestrator.ts";

const TEST_CONFIG = resolveConfig({
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
});
const TEST_REGISTRY = buildRegistry(TEST_CONFIG);

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
    commitCheckItems: () => failingCheckItems(),
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
    pushBranchWithLease: () => {},
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
      config: TEST_CONFIG,
      registry: TEST_REGISTRY,
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
      config: TEST_CONFIG,
      registry: TEST_REGISTRY,
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

    // Both checks and reviews reference the same issue number 55 via the same branch.
    // The PR is MERGEABLE/CLEAN so both gatherers produce a candidate and both try to
    // populate the issue body — the cache must prevent the second fetch.
    const branch = issueBranch(55);
    const sha = asSha("c".padEnd(40, "0"));

    const cycle: CycleGitHubClient = {
      openPrs: () => [{ number: asPrNumber(10), headRefName: branch, authorLogin: "phoebe-bot" }],
      mergeInfo: (prNumber: PrNumber) =>
        Promise.resolve({
          number: prNumber,
          headRefName: branch,
          headRefOid: sha,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
      prCommentBodies: () => [],
      resolveLogin: () => "phoebe-bot",
      reviewThreads: () => [],
      commitCheckItems: () => failingCheckItems(),
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
      config: TEST_CONFIG,
      registry: TEST_REGISTRY,
    });

    // checks produces PR #10 as a failing-check candidate (populates body 55).
    // reviews also produces PR #10 as a candidate but the cache blocks a second fetch.
    await workSource.gatherCycle(["checks", "reviews"]);
    expect(bodyCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Body-read error isolation: unreadable body drops only that candidate
// ---------------------------------------------------------------------------

describe("issue-body error isolation", () => {
  test("unreadable body drops the candidate but gather completes", async () => {
    const branch = issueBranch(77);
    const sha = (n: number) => asSha(`${"e" + n}`.padEnd(40, "0"));

    const cycle: CycleGitHubClient = {
      openPrs: () => [
        { number: asPrNumber(20), headRefName: branch, authorLogin: "phoebe-bot" },
        { number: asPrNumber(21), headRefName: issueBranch(78), authorLogin: "phoebe-bot" },
      ],
      mergeInfo: (prNumber: PrNumber) =>
        Promise.resolve({
          number: prNumber,
          headRefName: Number(prNumber) === 20 ? branch : issueBranch(78),
          headRefOid: sha(Number(prNumber)),
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
      prCommentBodies: () => [],
      resolveLogin: () => "phoebe-bot",
      reviewThreads: () => [],
      commitCheckItems: () => failingCheckItems(),
    } as unknown as CycleGitHubClient;

    const github: GitHubClient = {
      forCycle: () => cycle,
      issueBody: (n: number) => {
        if (n === 77) throw new Error("not found");
        return "body for 78";
      },
      commitCheckItems: () => failingCheckItems(),
      blockerPrState: () => ({ open: false, merged: true }),
      listReadyIssues: () => [],
      listResearchIssues: () => [],
    } as unknown as GitHubClient;

    const workSource = createWorkSource({
      github,
      originHub: noopOriginHub(),
      clock: stubClock,
      env: {},
      config: TEST_CONFIG,
      registry: TEST_REGISTRY,
    });

    const { record } = await workSource.gatherCycle(["checks"]);
    // PR #20 (issue 77, unreadable body) is dropped; PR #21 (issue 78) survives.
    const checks = record.gathered.get("checks") as { candidates: ChecksCandidate[] };
    expect(checks.candidates.map((p) => Number(p.prNumber))).toEqual([21]);
  });
});
