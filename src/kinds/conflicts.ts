// The `conflicts` work kind: PRs whose head no longer merges cleanly onto
// their base. Selection picks the oldest eligible conflicting PR; a clean
// blocker-first merge is tried before ever spinning up an agent (see
// `run`), and only a real conflict in the tree escalates to one.

import { asBranchRef, type BranchRef, type PrNumber, type Sha } from "../branded.ts";
import { createPhoebeLog } from "../phoebe-log.ts";
import {
  buildConflictFailWatermarkMarker,
  parseConflictFailWatermark,
  parseLatestMarker,
  type ConflictFailWatermark,
} from "../markers.ts";
import { isPrMergeConflicting, parseIssueNumberFromBranch } from "../pr-scope.ts";
import {
  filterBackoffEligible,
  findLatestUnitAttemptComment,
  slugifyFailureSignature,
} from "../quarantine.ts";
import type { UnitMarker } from "../quarantine.ts";
import {
  getMergedBlockerPrNumbers,
  selectStackRetargetCandidates,
  shouldSkipStackedFix,
  stackedCatchUpRetractionComment,
  stackRetargetedComment,
  type BlockerPrState,
  type StackContext,
} from "../stack.ts";
import type { CycleContext } from "../cycle.ts";
import {
  createJanitorHelpers,
  MERGEABLE_RETRY_COUNT,
  MERGEABLE_RETRY_MS,
  pickOldestPr,
  sleep,
} from "./janitor.ts";
import type { KindDeps, UnitRef, UnitResult, WorkKind } from "./kind.ts";

export type ConflictsUnit = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  baseRefName?: BranchRef;
  issueNumber?: number;
  headSha?: Sha;
  baseSha?: Sha;
  failureWatermark?: ConflictFailWatermark | null;
  /** No-commit-attempt counter (#25) — read from the unit's tracking comment. */
  attemptMarker?: UnitMarker | null;
};

export type ConflictsData = {
  conflictingPrs: readonly ConflictsUnit[];
  stack: StackContext;
  currentMainHead: Sha;
};

function shouldSkipWatermarkFix(opts: {
  watermark: ConflictFailWatermark | null;
  currentPrHead: Sha;
  currentMainHead: Sha;
}): boolean {
  if (!opts.watermark) {
    return false;
  }
  return (
    opts.watermark.prHead === opts.currentPrHead && opts.watermark.mainHead === opts.currentMainHead
  );
}

function failureSignature(opts: { mergeable?: string; mergeStateStatus?: string }): string {
  if (!opts.mergeable) {
    return "merge-setup-failed";
  }
  return slugifyFailureSignature(
    `mergeable-${opts.mergeable}${opts.mergeStateStatus ? `-${opts.mergeStateStatus}` : ""}`,
  );
}

function failureComment(prNumber: PrNumber, watermark?: ConflictFailWatermark): string {
  const parts = [
    `Phoebe attempted an idle merge-conflict fix (merge \`origin/main\` into this branch) ` +
      `for PR #${prNumber} but could not resolve it cleanly. The branch was left unchanged ` +
      `(\`git merge --abort\`). A human should resolve the conflicts manually.`,
  ];
  if (watermark) {
    parts.push("", buildConflictFailWatermarkMarker(watermark));
  }
  return parts.join("\n");
}

/**
 * After a sandbox conflict fix, the host may see 0 unpushed commits even when
 * the sandbox already pushed. Only post a failure comment when origin is
 * unchanged and the PR still conflicts.
 */
function shouldPostFailure(opts: {
  hostCommitCount: number;
  originShaBefore: Sha;
  originShaAfter: Sha;
  mergeable: string;
  mergeStateStatus?: string;
}): boolean {
  if (opts.hostCommitCount > 0) {
    return false;
  }
  if (opts.originShaAfter !== opts.originShaBefore) {
    return false;
  }
  return isPrMergeConflicting(opts.mergeable, opts.mergeStateStatus);
}

export function createConflictsKind(deps: KindDeps): WorkKind<ConflictsData, ConflictsUnit> {
  const { config, io } = deps;
  const { phoebeLog, phoebeError } = createPhoebeLog(config.repoSlug);
  const janitor = createJanitorHelpers(deps);
  const defaultBranchRef = asBranchRef(config.defaultBranch);

  function candidates(
    units: readonly ConflictsUnit[],
    ctx: StackContext,
    opts?: { currentMainHead: Sha },
  ): ConflictsUnit[] {
    return units.filter((pr) => {
      const issueNumber =
        pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName, config.branchPrefix);
      if (issueNumber !== null) {
        const body = ctx.issueBodies.get(issueNumber) ?? "";
        if (shouldSkipStackedFix(body, ctx.blockerStates, config.blockedByPattern)) {
          return false;
        }
      }
      const currentBaseHead = pr.baseSha ?? opts?.currentMainHead;
      if (currentBaseHead && pr.headSha) {
        if (
          shouldSkipWatermarkFix({
            watermark: pr.failureWatermark ?? null,
            currentPrHead: pr.headSha,
            currentMainHead: currentBaseHead,
          })
        ) {
          return false;
        }
      }
      return true;
    });
  }

  async function candidateForPr(pr: {
    number: PrNumber;
    headRefName: BranchRef;
  }): Promise<ConflictsUnit | null> {
    for (let attempt = 0; attempt < MERGEABLE_RETRY_COUNT; attempt++) {
      const info = io.github.prMergeInfo(pr.number);
      if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
        const issueNumber = parseIssueNumberFromBranch(info.headRefName, config.branchPrefix);
        return {
          prNumber: info.number,
          headRefName: info.headRefName,
          baseRefName: info.baseRefName,
          headSha: info.headRefOid,
          baseSha: info.baseRefOid,
          ...(issueNumber !== null ? { issueNumber } : {}),
        };
      }
      if (info.mergeable !== "UNKNOWN") {
        return null;
      }
      if (attempt < MERGEABLE_RETRY_COUNT - 1) {
        await sleep(MERGEABLE_RETRY_MS);
      }
    }
    return null;
  }

  async function fetch(ctx: CycleContext): Promise<ConflictsData> {
    const raw: ConflictsUnit[] = [];
    for (const pr of ctx.openPrs) {
      try {
        const candidate = await candidateForPr(pr);
        if (candidate) {
          raw.push(candidate);
        }
      } catch (error) {
        phoebeError(
          `Skipping PR #${pr.number} for conflicts this cycle — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const nowIso = new Date().toISOString();
    const withMarkers = raw.map((pr) => {
      const comments = io.github.prActivity(pr.prNumber).comments;
      return {
        ...pr,
        failureWatermark: parseLatestMarker(
          comments.map((c) => c.body),
          parseConflictFailWatermark,
        ),
        attemptMarker:
          findLatestUnitAttemptComment(comments, "conflicts", "no-commit")?.marker ?? null,
      };
    });
    // #25: a unit still inside its no-commit-attempt backoff window sits this cycle out.
    const conflictingPrs = filterBackoffEligible(withMarkers, nowIso);
    const stack: StackContext = { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates };
    return { conflictingPrs, stack, currentMainHead: ctx.mainHead };
  }

  function select(data: ConflictsData, ctx: CycleContext): ConflictsUnit | null {
    const stack: StackContext = { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates };
    return pickOldestPr(candidates(data.conflictingPrs, stack, { currentMainHead: ctx.mainHead }));
  }

  function refFor(unit: ConflictsUnit): UnitRef {
    return {
      kind: "conflicts",
      target: { type: "pr", number: unit.prNumber },
      branch: unit.headRefName,
    };
  }

  function describeIdle(data: ConflictsData): string | null {
    if (data.conflictingPrs.length === 0) {
      return null;
    }
    const withoutWatermark = candidates(data.conflictingPrs, data.stack);
    const withWatermark = candidates(data.conflictingPrs, data.stack, {
      currentMainHead: data.currentMainHead,
    });
    const skippedStacked = data.conflictingPrs.length - withoutWatermark.length;
    const skippedWatermark = withoutWatermark.length - withWatermark.length;
    if (skippedStacked > 0) {
      phoebeLog(`${skippedStacked} conflicting PR(s) skipped (stacked on open blocker).`);
    }
    if (skippedWatermark > 0) {
      phoebeLog(`${skippedWatermark} conflicting PR(s) skipped (unchanged failure watermark).`);
    }
    if (pickOldestPr(withWatermark)) {
      return null;
    }
    return `${data.conflictingPrs.length} conflicting PR(s) but none fixable this cycle.`;
  }

  function currentFailureWatermark(
    branch: BranchRef,
    baseBranch: BranchRef,
  ): ConflictFailWatermark {
    io.git.fetchOrigin();
    return { prHead: io.git.originBranchSha(branch), mainHead: io.git.originBranchSha(baseBranch) };
  }

  async function runResolutionAgent(
    pr: ConflictsUnit,
    mergedBlockerPrNumbers: readonly PrNumber[],
  ): Promise<UnitResult> {
    const baseBranch = pr.baseRefName ?? defaultBranchRef;
    return janitor.runAgentWorkflow({
      pr,
      promptFile: config.promptFiles.conflict,
      promptArgs: {
        PR_NUMBER: String(pr.prNumber),
        PR_BRANCH: pr.headRefName,
        BLOCKER_PR_NUMBERS: mergedBlockerPrNumbers.join(","),
      },
      beforeAgent: (worktreeDir) =>
        janitor.attemptBlockerFirstMerges(worktreeDir, mergedBlockerPrNumbers, baseBranch),
      onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
        const prInfo = io.github.prMergeInfo(pr.prNumber);
        if (
          shouldPostFailure({
            hostCommitCount: localCommitCount,
            originShaBefore,
            originShaAfter,
            mergeable: prInfo.mergeable,
            mergeStateStatus: prInfo.mergeStateStatus,
          })
        ) {
          phoebeLog(
            `Conflict fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
          );
          const watermark = currentFailureWatermark(pr.headRefName, baseBranch);
          janitor.recordFailedAttempt({
            kind: "conflicts",
            prNumber: pr.prNumber,
            signature: failureSignature({
              mergeable: prInfo.mergeable,
              mergeStateStatus: prInfo.mergeStateStatus,
            }),
            failureComment: failureComment(pr.prNumber, watermark),
          });
        } else if (localCommitCount > 0) {
          io.git.pushBranch(worktreeDir, branch);
          phoebeLog(`Conflict resolved for PR #${pr.prNumber} — pushed.`);
        } else {
          phoebeLog(`Conflict resolved for PR #${pr.prNumber} — already pushed by agent.`);
        }
      },
    });
  }

  async function run(pr: ConflictsUnit, ctx: CycleContext): Promise<UnitResult> {
    const baseBranch = pr.baseRefName ?? defaultBranchRef;
    phoebeLog(`Conflict fix: PR #${pr.prNumber} (${pr.headRefName}).`);
    io.git.fetchOrigin();

    const issueNumber =
      pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName, config.branchPrefix);
    const body = issueNumber !== null ? (ctx.issueBodies.get(issueNumber) ?? "") : "";
    const mergedBlockerPrNumbers = getMergedBlockerPrNumbers(
      body,
      ctx.blockerStates,
      config.blockedByPattern,
    );
    if (mergedBlockerPrNumbers.length > 0) {
      phoebeLog(
        `Stacked catch-up: merging blocker PR(s) ${mergedBlockerPrNumbers.map((n) => `#${n}`).join(", ")} before ${config.defaultBranch}.`,
      );
    }

    const cleanResult = janitor.tryCleanMerge(pr.headRefName, mergedBlockerPrNumbers, baseBranch);
    if (cleanResult === "pushed") {
      phoebeLog(`Clean merge for PR #${pr.prNumber} — pushed.`);
      if (mergedBlockerPrNumbers.length > 0) {
        io.github.commentPr(pr.prNumber, stackedCatchUpRetractionComment(mergedBlockerPrNumbers));
      }
      return { exitCode: null };
    }
    if (cleanResult === "failed") {
      phoebeLog(`Could not start merge for PR #${pr.prNumber} — skipping.`);
      const watermark = currentFailureWatermark(pr.headRefName, baseBranch);
      janitor.recordFailedAttempt({
        kind: "conflicts",
        prNumber: pr.prNumber,
        signature: failureSignature({}),
        failureComment: failureComment(pr.prNumber, watermark),
      });
      return { exitCode: null };
    }

    return runResolutionAgent(pr, mergedBlockerPrNumbers);
  }

  /**
   * Native-stack retarget sweep (#13): a native-mode successor PR is opened
   * against its blocker's branch, and GitHub only auto-retargets a PR onto
   * `main` when that base branch is *deleted*. Tenant repos run
   * `delete_branch_on_merge=false`, so once the blocker's PR merges its
   * branch survives and the successor's base never moves on its own. This
   * explicitly retargets every open Phoebe PR whose base is a merged
   * blocker's branch back onto `defaultBranch`. Harmless (and a no-op) under
   * `banner`/`off` stack modes.
   */
  async function sweep(ctx: CycleContext): Promise<void> {
    const blockerIssueNumbers = new Set<number>();
    for (const pr of ctx.openPrs) {
      const blockerIssueNumber = parseIssueNumberFromBranch(pr.baseRefName, config.branchPrefix);
      if (blockerIssueNumber !== null) {
        blockerIssueNumbers.add(blockerIssueNumber);
      }
    }
    if (blockerIssueNumbers.size === 0) {
      return;
    }

    const blockerStates = new Map<number, BlockerPrState>();
    for (const blockerIssueNumber of blockerIssueNumbers) {
      const state = ctx.blockerStates.get(blockerIssueNumber);
      if (state) {
        blockerStates.set(blockerIssueNumber, state);
        continue;
      }
      try {
        const branch = asBranchRef(`${config.branchPrefix}issue-${blockerIssueNumber}`);
        const openPrNumber = io.github.prNumberForHead(branch, "open");
        const mergedPrNumber = io.github.prNumberForHead(branch, "merged");
        blockerStates.set(blockerIssueNumber, {
          hasOpenPr: openPrNumber !== undefined,
          openPrNumber,
          hasMergedPr: mergedPrNumber !== undefined,
          mergedPrNumber,
        });
      } catch (error) {
        phoebeError(
          `Skipping stack-retarget check for blocker #${blockerIssueNumber} this cycle — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const retargetCandidates = ctx.openPrs.map((pr) => ({
      prNumber: pr.number,
      baseRefName: pr.baseRefName,
    }));
    for (const pr of selectStackRetargetCandidates(
      retargetCandidates,
      blockerStates,
      config.branchPrefix,
    )) {
      phoebeLog(
        `Retargeting PR #${pr.prNumber} from ${pr.baseRefName} to ${config.defaultBranch} — blocker merged.`,
      );
      try {
        io.github.retargetPr(pr.prNumber, config.defaultBranch);
        io.github.commentPr(pr.prNumber, stackRetargetedComment(config.defaultBranch));
      } catch (error) {
        phoebeError(
          `Failed to retarget PR #${pr.prNumber} — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    name: "conflicts",
    oneShot: false,
    fetch,
    select,
    run,
    refFor,
    describeIdle,
    sweep,
  };
}
