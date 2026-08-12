// The `reviews` work kind: PRs with new human review feedback (comments on
// unresolved threads) since the last time Phoebe handled them. Selection
// picks the oldest eligible PR; the agent's own summary comment (detected by
// a configured heading) or a push marks the run handled.

import type { BranchRef, PrNumber } from "../branded.ts";
import { createPhoebeLog } from "../phoebe-log.ts";
import {
  buildReviewsHandledMarker,
  parseLatestMarker,
  parseReviewsHandledWatermark,
  type ReviewsHandledWatermark,
} from "../markers.ts";
import { isPrMergeConflicting, parseIssueNumberFromBranch } from "../pr-scope.ts";
import { shouldSkipStackedFix, type StackContext } from "../stack.ts";
import type { ReviewThread } from "../github.ts";
import type { CycleContext } from "../cycle.ts";
import { createJanitorHelpers, pickOldestPr } from "./janitor.ts";
import type { KindDeps, UnitRef, UnitResult, WorkKind } from "./kind.ts";

export type ReviewsUnit = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  baseRefName?: BranchRef;
  issueNumber?: number;
  authorLogin?: string;
  mergeable: string;
  mergeStateStatus?: string;
  threads: readonly ReviewThread[];
  handledWatermark?: ReviewsHandledWatermark | null;
  /** The PR's labels — a `phoebe:tier:*` label among them overrides the tenant default for this run (#155). */
  labels?: readonly string[];
};

export type ReviewsData = {
  reviewActivityPrs: readonly ReviewsUnit[];
  stack: StackContext;
  phoebeLogin: string;
};

function isReviewSummaryComment(body: string, reviewsSuccessHeading: string): boolean {
  return body.includes(reviewsSuccessHeading);
}

function isActivityNewerThanWatermark(
  createdAt: string,
  watermark: ReviewsHandledWatermark | null,
): boolean {
  if (!watermark) {
    return true;
  }
  return createdAt > watermark.latest;
}

function newestReviewThreadCommentCreatedAt(threads: readonly ReviewThread[]): string | null {
  let newest: string | null = null;
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (newest === null || comment.createdAt > newest) {
        newest = comment.createdAt;
      }
    }
  }
  return newest;
}

function hasNewNonPhoebeReviewActivity(opts: {
  threads: readonly ReviewThread[];
  phoebeLogin: string;
  authorLogin?: string;
  watermark: ReviewsHandledWatermark | null;
}): boolean {
  for (const thread of opts.threads) {
    if (thread.isResolved || thread.isOutdated) {
      continue;
    }
    for (const comment of thread.comments) {
      if (comment.authorLogin === opts.phoebeLogin) {
        continue;
      }
      if (opts.authorLogin !== undefined && comment.authorLogin === opts.authorLogin) {
        continue;
      }
      if (isActivityNewerThanWatermark(comment.createdAt, opts.watermark)) {
        return true;
      }
    }
  }
  return false;
}

function buildHandledComment(opts: { latestActivityAt: string | null; failed: boolean }): string {
  const latest = opts.latestActivityAt ?? "1970-01-01T00:00:00Z";
  const marker = buildReviewsHandledMarker({ latest });
  if (opts.failed) {
    return (
      "Phoebe attempted to handle review feedback and failed; will retry on new review activity.\n\n" +
      marker
    );
  }
  return marker;
}

export function createReviewsKind(deps: KindDeps): WorkKind<ReviewsData, ReviewsUnit> {
  const { config, io } = deps;
  const { phoebeLog, phoebeError } = createPhoebeLog(config.repoSlug);
  const janitor = createJanitorHelpers(deps);

  function candidates(
    units: readonly ReviewsUnit[],
    ctx: StackContext,
    phoebeLogin: string,
  ): ReviewsUnit[] {
    return units.filter((pr) => {
      if (isPrMergeConflicting(pr.mergeable, pr.mergeStateStatus)) {
        return false;
      }
      const issueNumber =
        pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName, config.branchPrefix);
      if (issueNumber !== null) {
        const body = ctx.issueBodies.get(issueNumber) ?? "";
        if (shouldSkipStackedFix(body, ctx.blockerStates, config.blockedByPattern)) {
          return false;
        }
      }
      return hasNewNonPhoebeReviewActivity({
        threads: pr.threads,
        phoebeLogin,
        authorLogin: pr.authorLogin,
        watermark: pr.handledWatermark ?? null,
      });
    });
  }

  async function fetch(ctx: CycleContext): Promise<ReviewsData> {
    const phoebeLogin = await ctx.login();
    const reviewActivityPrs: ReviewsUnit[] = [];

    for (const pr of ctx.openPrs) {
      try {
        const info = io.github.prMergeInfo(pr.number);
        if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
          continue;
        }
        const threads = io.github.reviewThreads(pr.number);
        const issueNumber = parseIssueNumberFromBranch(info.headRefName, config.branchPrefix);
        const activity = io.github.prActivity(pr.number);
        const commentBodies = activity.comments.map((c) => c.body);
        reviewActivityPrs.push({
          prNumber: info.number,
          headRefName: info.headRefName,
          baseRefName: info.baseRefName,
          authorLogin: pr.authorLogin,
          mergeable: info.mergeable,
          mergeStateStatus: info.mergeStateStatus,
          threads,
          labels: activity.labels,
          handledWatermark: parseLatestMarker(commentBodies, parseReviewsHandledWatermark),
          ...(issueNumber !== null ? { issueNumber } : {}),
        });
      } catch (error) {
        phoebeError(
          `Skipping PR #${pr.number} for reviews this cycle — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const stack: StackContext = { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates };
    return { reviewActivityPrs, stack, phoebeLogin };
  }

  function select(data: ReviewsData, ctx: CycleContext): ReviewsUnit | null {
    const stack: StackContext = { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates };
    return pickOldestPr(candidates(data.reviewActivityPrs, stack, data.phoebeLogin));
  }

  function refFor(unit: ReviewsUnit): UnitRef {
    return {
      kind: "reviews",
      target: { type: "pr", number: unit.prNumber },
      branch: unit.headRefName,
    };
  }

  function describeIdle(data: ReviewsData): string | null {
    if (data.reviewActivityPrs.length === 0) {
      return null;
    }
    const eligible = candidates(data.reviewActivityPrs, data.stack, data.phoebeLogin);
    const skipped = data.reviewActivityPrs.length - eligible.length;
    if (skipped > 0) {
      phoebeLog(
        `${skipped} review-feedback PR(s) skipped (stacked, watermarked, or no new activity).`,
      );
    }
    if (pickOldestPr(eligible)) {
      return null;
    }
    return `${data.reviewActivityPrs.length} review-feedback PR(s) but none fixable this cycle.`;
  }

  function hasNewReviewSummaryComment(
    prNumber: PrNumber,
    phoebeLogin: string,
    since: string,
  ): boolean {
    return io.github
      .prActivity(prNumber)
      .comments.some(
        (comment) =>
          comment.authorLogin === phoebeLogin &&
          comment.createdAt > since &&
          isReviewSummaryComment(comment.body, config.reviewsSuccessHeading),
      );
  }

  /** Phoebe's own prior `handled`/failure marker comments on this PR — always superseded once a fresh one posts. */
  function supersededHandledCommentIds(prNumber: PrNumber, phoebeLogin: string): string[] {
    return io.github
      .prActivity(prNumber)
      .comments.filter(
        (comment) =>
          comment.authorLogin === phoebeLogin &&
          parseReviewsHandledWatermark(comment.body) !== null,
      )
      .map((comment) => comment.id);
  }

  async function runResolutionAgent(pr: ReviewsUnit, phoebeLogin: string): Promise<UnitResult> {
    const runStartedAt = new Date().toISOString();
    return janitor.runAgentWorkflow({
      pr,
      promptFile: config.promptFiles.reviews,
      promptArgs: { PR_NUMBER: String(pr.prNumber), PR_BRANCH: pr.headRefName },
      onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
        if (localCommitCount > 0) {
          io.git.pushBranch(worktreeDir, branch);
          phoebeLog(`Review feedback handled for PR #${pr.prNumber} — pushed.`);
        } else if (originShaAfter !== originShaBefore) {
          phoebeLog(`Review feedback handled for PR #${pr.prNumber} — already pushed by agent.`);
        }

        const hasSummary = hasNewReviewSummaryComment(pr.prNumber, phoebeLogin, runStartedAt);
        const pushed = localCommitCount > 0 || originShaAfter !== originShaBefore;
        // Watermark only the activity captured before the agent ran (pr.threads is
        // the pre-run snapshot from fetch). Re-fetching here could absorb feedback
        // posted concurrently with the run — marking it handled even though the
        // agent never observed it. Any activity newer than this snapshot correctly
        // re-selects the PR next cycle.
        const latestActivityAt = newestReviewThreadCommentCreatedAt(pr.threads);

        if (hasSummary) {
          phoebeLog(`Review summary posted for PR #${pr.prNumber}.`);
        } else if (!pushed) {
          phoebeLog(`Review handling for PR #${pr.prNumber} produced no summary or push.`);
        }

        const staleCommentIds = supersededHandledCommentIds(pr.prNumber, phoebeLogin);

        io.github.commentPr(
          pr.prNumber,
          buildHandledComment({ latestActivityAt, failed: !hasSummary && !pushed }),
        );

        // Every prior `handled`/failure marker is superseded by the one just
        // posted — minimize rather than delete, so the audit trail survives
        // (#169's comment-spam failure mode, docs/trust.md).
        for (const commentId of staleCommentIds) {
          io.github.minimizeComment(commentId, "OUTDATED");
        }

        // Resolve the threads that made this run eligible (pre-run snapshot —
        // see the watermark note above) once a fix push confirms they were
        // addressed. The agent may already have resolved some inline; a
        // repeat call is a harmless no-op.
        if (pushed) {
          for (const thread of pr.threads) {
            if (!thread.isResolved && !thread.isOutdated) {
              io.github.resolveReviewThread(thread.id);
            }
          }
        }
      },
    });
  }

  async function run(pr: ReviewsUnit, ctx: CycleContext): Promise<UnitResult> {
    phoebeLog(`Reviews fix: PR #${pr.prNumber} (${pr.headRefName}).`);
    io.git.fetchOrigin();
    const phoebeLogin = await ctx.login();
    return runResolutionAgent(pr, phoebeLogin);
  }

  return { name: "reviews", oneShot: false, fetch, select, run, refFor, describeIdle };
}
