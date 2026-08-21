// The work source: assembles one cycle's work data across the configured
// work kinds and returns a CycleRecord. Extracted from fetchCycleWorkData in
// main.ts so the per-kind issue-body merge step (and the ordering bug it
// harboured, #290) cannot recur: bodies are fetched through one cycle-scoped
// cache, never merged after the fact.

import {
  isPrMergeConflicting,
  listFailingChecks,
  parseBlockedBy,
  parseChecksFailWatermark,
  parseConflictFailWatermark,
  parseIssueNumberFromBranch,
  parseLatestMarker,
  parseReviewsHandledWatermark,
  statusCheckRollupState,
  workflowRunsToCheckItems,
  type BlockerPrState,
  type ChecksCandidate,
  type ConflictingPrCandidate,
  type Issue,
  type ReviewsCandidate,
  type WorkKindName,
} from "./orchestrator.ts";
import { type CycleGitHubClient, type GitHubClient, type OpenPhoebePr } from "./github-client.ts";
import type { OriginHub } from "./origin-hub.ts";
import { type BranchRef, type Sha } from "./branded.ts";

const CHECKS_PENDING_RETRY_MS = 5_000;
const CHECKS_PENDING_RETRY_COUNT = 3;

export type Clock = {
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
};

export type CycleRecord = {
  /** The kinds that were gathered, in gather order. */
  kindsGathered: readonly WorkKindName[];
  issues: readonly Issue[];
  researchIssues: readonly Issue[];
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  conflictingPrs: readonly ConflictingPrCandidate[];
  failingCheckPrs: readonly ChecksCandidate[];
  reviewActivityPrs: readonly ReviewsCandidate[];
  /**
   * One cycle-scoped map, populated as a side effect of the gather.
   * Never merged; nothing left to get wrong.
   */
  issueBodies: ReadonlyMap<number, string>;
  phoebeLogin?: string;
  currentMainHead?: Sha;
};

export type WorkSource = {
  /**
   * Gather one cycle's work data across the given kinds in order.
   *
   * A single unreadable pull request is warned and dropped from that kind's
   * results; the gather continues. A whole kind failing to fetch throws — the
   * bootstrapper's restart loop is the recovery path.
   */
  gatherCycle(kinds: readonly WorkKindName[]): Promise<CycleRecord>;
};

export function createWorkSource(opts: {
  github: GitHubClient;
  originHub: OriginHub;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  defaultBranchRef: BranchRef;
}): WorkSource {
  const { github, originHub, clock, env, defaultBranchRef } = opts;

  function buildBlockerStates(issues: readonly Issue[]): Map<number, BlockerPrState> {
    const blockerNumbers = new Set<number>();
    for (const issue of issues) {
      for (const n of parseBlockedBy(issue.body)) {
        blockerNumbers.add(n);
      }
    }
    const states = new Map<number, BlockerPrState>();
    for (const n of blockerNumbers) {
      try {
        states.set(n, github.blockerPrState(n));
      } catch (error) {
        console.warn(
          `[phoebe] Skipping blocker state for #${n} this cycle — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return states;
  }

  function buildBlockerStatesFromBodies(
    bodies: ReadonlyArray<{ number: number; body: string }>,
  ): Map<number, BlockerPrState> {
    return buildBlockerStates(
      bodies.map(({ number, body }) => ({
        number,
        title: "",
        body,
        labels: [],
        createdAt: "",
      })),
    );
  }

  /**
   * Fetch issue bodies for the given PRs into the cycle-scoped cache.
   * Each issue number is fetched at most once per cycle: already-cached
   * entries are skipped, so the same body is never fetched twice even when
   * several kinds reference the same PR.
   */
  function populateIssueBodies(
    prs: ReadonlyArray<{ issueNumber?: number; headRefName: BranchRef }>,
    cache: Map<number, string>,
  ): void {
    const issueNumbers = [
      ...new Set(
        prs
          .map((pr) => pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName))
          .filter((n): n is number => n !== null),
      ),
    ];
    for (const number of issueNumbers) {
      if (!cache.has(number)) {
        cache.set(number, github.issueBody(number));
      }
    }
  }

  async function conflictingPrCandidate(
    pr: OpenPhoebePr,
    cycle: CycleGitHubClient,
  ): Promise<ConflictingPrCandidate | null> {
    const info = await cycle.mergeInfo(pr.number);
    if (!isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) return null;
    const issueNumber = parseIssueNumberFromBranch(info.headRefName);
    return {
      prNumber: info.number,
      headRefName: info.headRefName,
      headSha: info.headRefOid,
      ...(issueNumber !== null ? { issueNumber } : {}),
    };
  }

  async function fetchConflictingPrs(cycle: CycleGitHubClient): Promise<ConflictingPrCandidate[]> {
    const openPrs = cycle.openPrs();
    const conflicting: ConflictingPrCandidate[] = [];
    for (const pr of openPrs) {
      try {
        const candidate = await conflictingPrCandidate(pr, cycle);
        if (candidate) {
          conflicting.push(candidate);
        }
      } catch (error) {
        console.warn(
          `[phoebe] Skipping PR #${pr.number} for conflicts this cycle — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return conflicting;
  }

  async function failingChecksCandidate(
    pr: OpenPhoebePr,
    cycle: CycleGitHubClient,
  ): Promise<ChecksCandidate | null> {
    const info = await cycle.mergeInfo(pr.number);
    if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) return null;
    for (let attempt = 0; attempt < CHECKS_PENDING_RETRY_COUNT; attempt++) {
      const checkItems = workflowRunsToCheckItems(github.commitCheckItems(info.headRefOid));
      const rollup = statusCheckRollupState(checkItems);
      if (rollup === "FAILURE") {
        const issueNumber = parseIssueNumberFromBranch(info.headRefName);
        return {
          prNumber: info.number,
          headRefName: info.headRefName,
          headSha: info.headRefOid,
          mergeable: info.mergeable,
          mergeStateStatus: info.mergeStateStatus,
          failingChecks: listFailingChecks(checkItems),
          ...(issueNumber !== null ? { issueNumber } : {}),
        };
      }
      if (rollup !== "PENDING") return null;
      if (attempt < CHECKS_PENDING_RETRY_COUNT - 1) {
        await clock.sleep(CHECKS_PENDING_RETRY_MS);
      }
    }
    return null;
  }

  async function fetchFailingCheckPrs(cycle: CycleGitHubClient): Promise<ChecksCandidate[]> {
    const openPrs = cycle.openPrs();
    const failing: ChecksCandidate[] = [];
    for (const pr of openPrs) {
      try {
        const candidate = await failingChecksCandidate(pr, cycle);
        if (candidate) {
          failing.push(candidate);
        }
      } catch (error) {
        console.warn(
          `[phoebe] Skipping PR #${pr.number} for checks this cycle — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return failing;
  }

  async function gatherConflicts(cycle: CycleGitHubClient): Promise<{
    conflictingPrs: ConflictingPrCandidate[];
    currentMainHead: Sha;
  }> {
    const rawConflictingPrs = await fetchConflictingPrs(cycle);
    originHub.fetch();
    const currentMainHead = originHub.branchHead(defaultBranchRef);
    const conflictingPrs = rawConflictingPrs.map((pr) => ({
      ...pr,
      failureWatermark: parseLatestMarker(
        cycle.prCommentBodies(pr.prNumber),
        parseConflictFailWatermark,
      ),
    }));
    return { conflictingPrs, currentMainHead };
  }

  async function gatherChecks(cycle: CycleGitHubClient): Promise<{
    failingCheckPrs: ChecksCandidate[];
  }> {
    const rawFailingPrs = await fetchFailingCheckPrs(cycle);
    const failingCheckPrs = rawFailingPrs.map((pr) => ({
      ...pr,
      failureWatermark: parseLatestMarker(
        cycle.prCommentBodies(pr.prNumber),
        parseChecksFailWatermark,
      ),
    }));
    return { failingCheckPrs };
  }

  async function gatherReviews(cycle: CycleGitHubClient): Promise<{
    reviewActivityPrs: ReviewsCandidate[];
    phoebeLogin: string;
  }> {
    const phoebeLogin = cycle.resolveLogin(env["PHOEBE_GH_LOGIN"]);
    const openPrs = cycle.openPrs();
    const reviewActivityPrs: ReviewsCandidate[] = [];

    for (const pr of openPrs) {
      try {
        const info = await cycle.mergeInfo(pr.number);
        if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
          continue;
        }
        const threads = cycle.reviewThreads(pr.number);
        const issueNumber = parseIssueNumberFromBranch(info.headRefName);
        reviewActivityPrs.push({
          prNumber: info.number,
          headRefName: info.headRefName,
          authorLogin: pr.authorLogin,
          mergeable: info.mergeable,
          mergeStateStatus: info.mergeStateStatus,
          threads,
          handledWatermark: parseLatestMarker(
            cycle.prCommentBodies(pr.number),
            parseReviewsHandledWatermark,
          ),
          ...(issueNumber !== null ? { issueNumber } : {}),
        });
      } catch (error) {
        console.warn(
          `[phoebe] Skipping PR #${pr.number} for reviews this cycle — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { reviewActivityPrs, phoebeLogin };
  }

  function gatherIssues(): { issues: Issue[]; blockerStates: Map<number, BlockerPrState> } {
    const issues = github.listReadyIssues();
    return { issues, blockerStates: buildBlockerStates(issues) };
  }

  function gatherResearch(): {
    researchIssues: Issue[];
    blockerStates: Map<number, BlockerPrState>;
  } {
    const researchIssues = github.listResearchIssues();
    return { researchIssues, blockerStates: buildBlockerStates(researchIssues) };
  }

  async function gatherCycle(kinds: readonly WorkKindName[]): Promise<CycleRecord> {
    let issues: Issue[] = [];
    let researchIssues: Issue[] = [];
    let blockerStates = new Map<number, BlockerPrState>();
    let conflictingPrs: ConflictingPrCandidate[] = [];
    let failingCheckPrs: ChecksCandidate[] = [];
    let reviewActivityPrs: ReviewsCandidate[] = [];
    const issueBodies = new Map<number, string>();
    let phoebeLogin: string | undefined;
    let currentMainHead: Sha | undefined;

    const cycle = github.forCycle();

    for (const kind of kinds) {
      if (kind === "conflicts") {
        const result = await gatherConflicts(cycle);
        conflictingPrs = result.conflictingPrs;
        currentMainHead = result.currentMainHead;
        populateIssueBodies(conflictingPrs, issueBodies);
      } else if (kind === "checks") {
        const result = await gatherChecks(cycle);
        failingCheckPrs = result.failingCheckPrs;
        populateIssueBodies(failingCheckPrs, issueBodies);
      } else if (kind === "reviews") {
        const result = await gatherReviews(cycle);
        reviewActivityPrs = result.reviewActivityPrs;
        phoebeLogin = result.phoebeLogin;
        populateIssueBodies(reviewActivityPrs, issueBodies);
      } else if (kind === "issues") {
        const result = gatherIssues();
        issues = result.issues;
        for (const [n, s] of result.blockerStates) blockerStates.set(n, s);
      } else {
        const result = gatherResearch();
        researchIssues = result.researchIssues;
        for (const [n, s] of result.blockerStates) blockerStates.set(n, s);
      }
    }

    const allBodies = [...issueBodies.entries()].map(([number, body]) => ({ number, body }));
    if (allBodies.length > 0) {
      const bodiesBlockerStates = buildBlockerStatesFromBodies(allBodies);
      for (const [n, s] of bodiesBlockerStates) blockerStates.set(n, s);
    }

    return {
      kindsGathered: kinds,
      issues,
      researchIssues,
      blockerStates,
      conflictingPrs,
      failingCheckPrs,
      reviewActivityPrs,
      issueBodies,
      phoebeLogin,
      currentMainHead,
    };
  }

  return { gatherCycle };
}
