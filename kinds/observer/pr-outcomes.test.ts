// What became of the units' PRs (#935): each signal's flag as a pure function
// of signals, revert detection from the revert side, self-grading excluded, and
// the gather's call count against what #916 measured.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "../../src/branded.ts";
import type { UnitRecord } from "../../src/contracts/unit-record.ts";
import type {
  BranchPr,
  BranchWorkflowRun,
  ObservedCommit,
  ObservedPr,
  RevertPr,
} from "../../src/github-client.ts";
import {
  branchPrFor,
  failedRunCount,
  gatherPrOutcomes,
  isProposalPr,
  isProposalUnit,
  outsideCommitCount,
  parseRevertLog,
  phoebeIdentityFrom,
  prFlagsOf,
  revertsOf,
  SLOW_MERGE_MS,
  type PrOutcomeSource,
  type PrSignals,
  type RevertCommit,
} from "./pr-outcomes.ts";

const HOUR = 3_600_000;
const NOW = new Date("2026-11-25T12:00:00.000Z");
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * HOUR).toISOString();

const quiet: PrSignals = {
  number: 7,
  state: "merged",
  changesRequested: 0,
  reviewThreads: 0,
  outsideCommits: 0,
  failedRuns: 0,
  hoursToMerge: 2,
  revertedBy: null,
};

const PHOEBE = { authorName: "Phoebe", authorEmail: "838371+op@users.noreply.github.com" };
const HUMAN = { authorName: "Op Person", authorEmail: "op@example.com" };

function commit(oid: string, who: typeof PHOEBE, parents = 1): ObservedCommit {
  return { oid: asSha(oid), ...who, parents };
}

function pr(overrides: Partial<ObservedPr> = {}): ObservedPr {
  return {
    number: asPrNumber(7),
    state: "merged",
    createdAt: hoursAgo(48),
    mergedAt: hoursAgo(46),
    closedAt: hoursAgo(46),
    headRefName: asBranchRef("phoebe/issue-6"),
    mergeCommitOid: asSha("e".repeat(40)),
    body: "Closes #6",
    labels: [],
    closingIssues: [6],
    changesRequested: 0,
    reviewThreads: 0,
    commits: [commit("a".repeat(40), PHOEBE)],
    commitsTruncated: false,
    ...overrides,
  };
}

function unitRecord(overrides: Partial<UnitRecord> = {}): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issues", id: "issue:6" },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: hoursAgo(49),
    settledAt: hoursAgo(48),
    durationMs: HOUR,
    runBudgetMs: null,
    provider: "claude",
    model: null,
    effort: null,
    branch: null,
    headSha: null,
    prNumber: null,
    engineCommit: null,
    agentRuns: [],
    ...overrides,
  };
}

describe("each signal's flag", () => {
  test("a quiet merged PR earns nothing", () => {
    expect(prFlagsOf(quiet)).toEqual([]);
  });

  test.each([
    [{ changesRequested: 1 }, "changes-requested"],
    [{ reviewThreads: 3 }, "review-threads"],
    [{ outsideCommits: 1 }, "outside-commits"],
    [{ state: "closed", hoursToMerge: null }, "closed-unmerged"],
    [{ revertedBy: "#57" }, "reverted"],
    [{ failedRuns: 2 }, "actions-failed"],
    [{ hoursToMerge: SLOW_MERGE_MS / HOUR + 1 }, "slow-merge"],
  ] as const)("%o flags %s", (overrides, flag) => {
    expect(prFlagsOf({ ...quiet, ...overrides })).toEqual([flag]);
  });

  test("a merge exactly at the slow line is not slow", () => {
    expect(prFlagsOf({ ...quiet, hoursToMerge: SLOW_MERGE_MS / HOUR })).toEqual([]);
  });

  test("signals stack", () => {
    expect(
      prFlagsOf({ ...quiet, changesRequested: 2, failedRuns: 1, revertedBy: "abc1234" }),
    ).toEqual(["changes-requested", "reverted", "actions-failed"]);
  });
});

describe("outside commits", () => {
  const phoebe = `Phoebe <${PHOEBE.authorEmail}>`;

  test("content commits by another identity after Phoebe's count; merges do not", () => {
    const commits = [
      commit("1", PHOEBE),
      commit("2", HUMAN, 2),
      commit("3", HUMAN),
      commit("4", PHOEBE),
      commit("5", HUMAN),
    ];
    expect(outsideCommitCount(commits, phoebe)).toBe(2);
  });

  test("commits before Phoebe's first are someone starting the branch, not a fix after it", () => {
    expect(outsideCommitCount([commit("1", HUMAN), commit("2", PHOEBE)], phoebe)).toBe(0);
  });

  test("the email compares without case", () => {
    const shouting = { ...PHOEBE, authorEmail: PHOEBE.authorEmail.toUpperCase() };
    expect(outsideCommitCount([commit("1", PHOEBE), commit("2", shouting)], phoebe)).toBe(0);
  });

  test("with no identity configured, the PR's first commit stands in for Phoebe", () => {
    expect(outsideCommitCount([commit("1", PHOEBE), commit("2", HUMAN)], null)).toBe(1);
  });

  test("the identity comes from the engine's GIT_AUTHOR_* and needs both", () => {
    expect(
      phoebeIdentityFrom({ GIT_AUTHOR_NAME: "Phoebe", GIT_AUTHOR_EMAIL: "P@Example.com" }),
    ).toBe("Phoebe <p@example.com>");
    expect(phoebeIdentityFrom({ GIT_AUTHOR_NAME: "Phoebe" })).toBeNull();
  });
});

describe("failed Actions runs", () => {
  const run = (createdAt: string, conclusion: string | null): BranchWorkflowRun => ({
    name: "ready",
    headSha: asSha("a".repeat(40)),
    conclusion,
    createdAt,
  });

  test("only failures while the PR was open count; cancelled and running do not", () => {
    const runs = [
      run(hoursAgo(50), "failure"), // before it opened: an older PR on the branch
      run(hoursAgo(47.5), "failure"),
      run(hoursAgo(47), "timed_out"),
      run(hoursAgo(47), "startup_failure"),
      run(hoursAgo(47), "cancelled"),
      run(hoursAgo(47), null),
      run(hoursAgo(46.5), "success"),
      run(hoursAgo(10), "failure"), // after it merged
    ];
    expect(failedRunCount(runs, pr())).toBe(3);
  });
});

describe("reverts, found from the revert side", () => {
  const revertPr = (overrides: Partial<RevertPr>): RevertPr => ({
    number: asPrNumber(57),
    title: 'Revert "Phoebe: something"',
    body: "",
    headRefName: "revert-7-phoebe/issue-6",
    merged: true,
    ...overrides,
  });

  test("a merged revert PR names the PR in its body or its head branch", () => {
    const byBody = revertsOf({
      prs: [pr()],
      revertPrs: [revertPr({ headRefName: "undo", body: "Reverts acme/widget#7" })],
      revertCommits: [],
      repoSlug: "acme/widget",
    });
    expect(byBody.get(7)).toBe("#57");
    const byBranch = revertsOf({
      prs: [pr()],
      revertPrs: [revertPr({})],
      revertCommits: [],
      repoSlug: "acme/widget",
    });
    expect(byBranch.get(7)).toBe("#57");
  });

  test("an unmerged revert PR, or one naming another repo's PR, reverts nothing", () => {
    const reverted = revertsOf({
      prs: [pr()],
      revertPrs: [
        revertPr({ merged: false }),
        revertPr({ number: asPrNumber(58), headRefName: "x", body: "Reverts other/repo#7" }),
      ],
      revertCommits: [],
      repoSlug: "acme/widget",
    });
    expect(reverted.size).toBe(0);
  });

  test("a revert commit names the merge commit, or one of the PR's commits", () => {
    const log = [
      `${"r".repeat(40)}\x1fRevert "Phoebe: something"\n\nThis reverts commit ${"e".repeat(40)}.\n\x1e`,
      `${"s".repeat(40)}\x1fRevert one\n\nThis reverts commit ${"b".repeat(12)}.\n\x1e`,
    ].join("\n");
    const commits = parseRevertLog(log);
    expect(commits).toEqual([
      { sha: "r".repeat(40), reverts: ["e".repeat(40)] },
      { sha: "s".repeat(40), reverts: ["b".repeat(12)] },
    ]);
    const reverted = revertsOf({
      prs: [
        pr(),
        pr({
          number: asPrNumber(8),
          mergeCommitOid: asSha("c".repeat(40)),
          commits: [commit("b".repeat(40), PHOEBE)],
        }),
        pr({ number: asPrNumber(9), mergeCommitOid: asSha("d".repeat(40)) }),
      ],
      revertPrs: [],
      revertCommits: commits,
      repoSlug: "acme/widget",
    });
    expect([...reverted]).toEqual([
      [7, "rrrrrrr"],
      [8, "sssssss"],
    ]);
  });
});

describe("observer proposals are never graded", () => {
  test("a PR is a proposal by its label, its marker, or the proposal issue it closes", () => {
    const proposals = new Set([41]);
    expect(isProposalPr(pr(), proposals)).toBe(false);
    expect(isProposalPr(pr({ labels: ["phoebe:observer"] }), proposals)).toBe(true);
    expect(
      isProposalPr(pr({ body: "<!-- phoebe-observer finding=factory:x -->" }), proposals),
    ).toBe(true);
    expect(isProposalPr(pr({ closingIssues: [41] }), proposals)).toBe(true);
  });

  test("a unit on a proposal issue is on a proposal", () => {
    const proposals = new Set([41]);
    expect(
      isProposalUnit(unitRecord({ unit: { kind: "issues", id: "issue:41" } }), proposals),
    ).toBe(true);
    expect(isProposalUnit(unitRecord({ unit: { kind: "issues", id: "issue:4" } }), proposals)).toBe(
      false,
    );
  });
});

describe("matching a branch to its PR", () => {
  const candidate = (number: number, createdAt: string, closedAt: string | null): BranchPr => ({
    number: asPrNumber(number),
    createdAt,
    closedAt,
  });

  test("the newest PR open at some point during the unit", () => {
    const record = unitRecord({ startedAt: hoursAgo(10), settledAt: hoursAgo(9) });
    expect(
      branchPrFor(
        record,
        [
          candidate(3, hoursAgo(100), hoursAgo(90)), // closed before the unit started
          candidate(4, hoursAgo(20), null), // open through it
          candidate(5, hoursAgo(9.5), null), // opened by it
          candidate(6, hoursAgo(5), null), // opened after it settled
        ],
        NOW,
      )?.number,
    ).toBe(5);
    expect(branchPrFor(record, [candidate(6, hoursAgo(5), null)], NOW)).toBeNull();
  });
});

describe("the gather", () => {
  function source(prs: ObservedPr[], onBranch: Record<string, BranchPr[]> = {}) {
    const calls = { branchPrs: 0, observedPrs: 0, revertPrs: 0, branchWorkflowRuns: 0 };
    const asked: { numbers: number[]; branches: string[]; since: string[] } = {
      numbers: [],
      branches: [],
      since: [],
    };
    const github: PrOutcomeSource = {
      branchPrs: (branches) => {
        calls.branchPrs += 1;
        asked.branches.push(...branches);
        return new Map(branches.map((branch) => [branch, onBranch[branch] ?? []]));
      },
      observedPrs: (numbers) => {
        calls.observedPrs += 1;
        asked.numbers.push(...numbers);
        return prs.filter((one) => numbers.includes(one.number));
      },
      revertPrs: (since) => {
        calls.revertPrs += 1;
        asked.since.push(since);
        return [];
      },
      branchWorkflowRuns: () => {
        calls.branchWorkflowRuns += 1;
        return [];
      },
    };
    return { github, calls, asked };
  }

  const gather = (
    github: PrOutcomeSource,
    units: Array<{ key: string; record: UnitRecord }>,
    extra: { revertCommits?: (since: Date) => RevertCommit[]; proposalIssues?: number[] } = {},
  ) =>
    gatherPrOutcomes({
      units,
      github,
      revertCommits: extra.revertCommits ?? (() => []),
      proposalIssues: new Set(extra.proposalIssues ?? []),
      phoebe: null,
      repoSlug: "acme/widget",
      ignoredBranches: new Set(["main", "phoebe/workspace"]),
      now: NOW,
    });

  test("units with no PR and no branch make no call at all", () => {
    const { github, calls } = source([]);
    expect(gather(github, [{ key: "k", record: unitRecord() }]).size).toBe(0);
    expect(calls).toEqual({ branchPrs: 0, observedPrs: 0, revertPrs: 0, branchWorkflowRuns: 0 });
  });

  test("twenty settled PRs cost one branch lookup, one PR read, one revert search and twenty run lists", () => {
    const prs = Array.from({ length: 20 }, (_, index) =>
      pr({
        number: asPrNumber(100 + index),
        headRefName: asBranchRef(`phoebe/issue-${index}`),
        state: index % 5 === 0 ? "closed" : "merged",
        mergedAt: index % 5 === 0 ? null : hoursAgo(46),
      }),
    );
    // Each PR has the issue unit that opened it (branch only) and a reviews
    // unit on it (PR number), plus one unit on the default branch.
    const units = prs.flatMap((one, index) => [
      {
        key: `issue-${index}`,
        record: unitRecord({
          branch: one.headRefName,
          unit: { kind: "issues", id: `issue:${index}` },
        }),
      },
      {
        key: `review-${index}`,
        record: unitRecord({
          prNumber: one.number,
          unit: { kind: "reviews", id: `pr:${one.number}` },
        }),
      },
    ]);
    units.push({ key: "readonly", record: unitRecord({ branch: "main" }) });
    const onBranch = Object.fromEntries(
      prs.map((one) => [
        one.headRefName,
        [{ number: one.number, createdAt: one.createdAt, closedAt: one.closedAt }],
      ]),
    );
    const { github, calls, asked } = source(prs, onBranch);
    const outcomes = gather(github, units);

    expect(calls).toEqual({ branchPrs: 1, observedPrs: 1, revertPrs: 1, branchWorkflowRuns: 20 });
    expect(asked.branches).not.toContain("main");
    expect(asked.numbers).toHaveLength(20);
    expect(asked.since).toEqual([hoursAgo(48).slice(0, 10)]);
    expect(outcomes.get("issue-0")?.flags).toEqual(["closed-unmerged"]);
    expect(outcomes.get("review-0")?.flags).toEqual(["closed-unmerged"]);
    expect(outcomes.get("issue-1")).toEqual({
      proposal: false,
      signals: { ...quiet, number: 101 },
      flags: [],
    });
    expect(outcomes.has("readonly")).toBe(false);
  });

  test("an open PR is read but earns no flag and costs no run list", () => {
    const { github, calls } = source([pr({ state: "open", mergedAt: null, closedAt: null })]);
    const outcomes = gather(github, [{ key: "k", record: unitRecord({ prNumber: 7 }) }]);
    expect(outcomes.get("k")).toEqual({ proposal: false, signals: null, flags: [] });
    expect(calls.branchWorkflowRuns).toBe(0);
    expect(calls.revertPrs).toBe(0);
  });

  test("a revert commit on the default branch flags the PR it undid", () => {
    const { github } = source([pr()]);
    const seen: Date[] = [];
    const outcomes = gather(github, [{ key: "k", record: unitRecord({ prNumber: 7 }) }], {
      revertCommits: (since) => {
        seen.push(since);
        return [{ sha: "f".repeat(40), reverts: ["e".repeat(40)] }];
      },
    });
    expect(seen).toEqual([new Date(hoursAgo(48))]);
    expect(outcomes.get("k")?.flags).toEqual(["reverted"]);
    expect(outcomes.get("k")?.signals?.revertedBy).toBe("fffffff");
  });

  test("a proposal PR is marked and never costs a run list", () => {
    const { github, calls } = source([
      pr({ state: "closed", mergedAt: null, closingIssues: [41] }),
    ]);
    const outcomes = gather(github, [{ key: "k", record: unitRecord({ prNumber: 7 }) }], {
      proposalIssues: [41],
    });
    expect(outcomes.get("k")).toEqual({ proposal: true, signals: null, flags: [] });
    expect(calls.branchWorkflowRuns).toBe(0);
  });
});
