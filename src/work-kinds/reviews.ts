// The `reviews` kind: handle human review feedback on open PRs. The agent
// works the feedback; the kind pushes any commits and posts the
// handled-watermark comment — built from the pre-run activity snapshot, so
// feedback posted mid-run still re-selects the PR.

import type { PhoebeConfig } from "../config-schema.ts";
import {
  buildReviewsHandledComment,
  isPrMergeConflicting,
  isReviewSummaryComment,
  newestReviewThreadCommentCreatedAt,
  parseLatestMarker,
  parseReviewsHandledWatermark,
  pickOldestPr,
  selectReviewsCandidates,
  type ReviewsCandidate,
} from "../orchestrator.ts";
import {
  defineWorkKind,
  type AnyWorkKindDefinition,
  type WorkKindRunCtx,
  type WorkUnitGitHubTarget,
} from "./definition.ts";
import { collectIssueBodies, issueNumberOf } from "./pr-stack.ts";

type ReviewsGathered = {
  candidates: readonly ReviewsCandidate[];
  issueBodies: ReadonlyMap<number, string>;
  phoebeLogin: string;
};

type ReviewsUnit = {
  ref: string;
  github: WorkUnitGitHubTarget;
  pr: ReviewsCandidate;
  /** Resolved at fetch and embedded here — everything run needs rides the unit. */
  phoebeLogin: string;
};

function hasNewReviewSummaryComment(
  ctx: WorkKindRunCtx,
  unit: ReviewsUnit,
  since: string,
): boolean {
  return ctx.github
    .reviewSummaryComments(unit.pr.prNumber)
    .some(
      (comment) =>
        comment.authorLogin === unit.phoebeLogin &&
        comment.createdAt > since &&
        isReviewSummaryComment(comment.body),
    );
}

export function reviewsKind(config: PhoebeConfig): AnyWorkKindDefinition {
  const noun = "review-feedback PR(s)";
  return defineWorkKind<ReviewsGathered, ReviewsUnit>({
    name: "reviews",
    oneShotEligible: false,
    promptFile: config.promptFiles.reviews,
    workspace: "worktree",
    report: {
      noun,
      describe: (unit) => `review feedback for PR #${unit.pr.prNumber} (${unit.pr.headRefName})`,
      idle: (_gathered, total) => `${total} ${noun} but none fixable this cycle.`,
    },
    async fetch(ctx) {
      const phoebeLogin = ctx.github.resolveLogin(ctx.env["PHOEBE_GH_LOGIN"]);
      const candidates: ReviewsCandidate[] = [];
      for (const pr of ctx.github.openPrs()) {
        try {
          const info = await ctx.github.mergeInfo(pr.number);
          if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) continue;
          const threads = ctx.github.reviewThreads(pr.number);
          const issueNumber = issueNumberOf({ headRefName: info.headRefName });
          candidates.push({
            prNumber: info.number,
            headRefName: info.headRefName,
            authorLogin: pr.authorLogin,
            mergeable: info.mergeable,
            mergeStateStatus: info.mergeStateStatus,
            threads,
            handledWatermark: parseLatestMarker(
              ctx.github.prCommentBodies(pr.number),
              parseReviewsHandledWatermark,
            ),
            ...(issueNumber !== null ? { issueNumber } : {}),
          });
        } catch (error) {
          console.warn(
            `[phoebe] Skipping PR #${pr.number} for reviews this cycle — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const collected = collectIssueBodies(candidates, ctx);
      return { candidates: collected.candidates, issueBodies: collected.issueBodies, phoebeLogin };
    },
    select(gathered, ctx) {
      // Without Phoebe's own login there is no telling her comments from anyone
      // else's, so the kind does not run — and reports nothing, rather than
      // reporting every PR as skipped.
      if (!gathered.phoebeLogin) {
        return { unit: null, skipped: [], total: 0 };
      }
      const stack = {
        issueBodies: gathered.issueBodies,
        blockerStates: ctx.cycle.blockerStates(),
      };
      const candidates = selectReviewsCandidates(gathered.candidates, stack, gathered.phoebeLogin);
      const pick = pickOldestPr(candidates);
      const turnedAway = gathered.candidates.length - candidates.length;
      return {
        unit: pick
          ? {
              ref: `pr:${pick.prNumber}`,
              github: { objectType: "pr", id: Number(pick.prNumber) },
              pr: pick,
              phoebeLogin: gathered.phoebeLogin,
            }
          : null,
        skipped:
          turnedAway > 0
            ? [{ reason: "stacked, watermarked, or no new activity", count: turnedAway }]
            : [],
        total: gathered.candidates.length,
      };
    },
    async run(unit, ctx) {
      const pr = unit.pr;
      ctx.log(`Reviews fix: PR #${pr.prNumber} (${pr.headRefName}).`);
      ctx.origin.fetch();
      const runStartedAt = ctx.clock.now().toISOString();
      await ctx.agent.prWorkflow({
        pr: { prNumber: pr.prNumber, headRefName: pr.headRefName },
        promptArgs: {
          PR_NUMBER: String(pr.prNumber),
          PR_BRANCH: pr.headRefName,
        },
        onResult: ({ originShaBefore, originShaAfter, localCommitCount, push }) => {
          if (localCommitCount > 0) {
            push();
            ctx.log(`Review feedback handled for PR #${pr.prNumber} — pushed.`);
          } else if (originShaAfter !== originShaBefore) {
            ctx.log(`Review feedback handled for PR #${pr.prNumber} — already pushed by agent.`);
          }

          const hasSummary = hasNewReviewSummaryComment(ctx, unit, runStartedAt);
          const pushed = localCommitCount > 0 || originShaAfter !== originShaBefore;
          // Watermark only the activity captured before the agent ran (pr.threads
          // is the pre-run snapshot from fetch). Re-fetching here could absorb
          // feedback posted concurrently with the run — marking it handled even
          // though the agent never observed it, so it would never trigger another
          // cycle. Any activity newer than this snapshot correctly re-selects
          // the PR.
          const latestActivityAt = newestReviewThreadCommentCreatedAt(pr.threads);

          if (hasSummary) {
            ctx.log(`Review summary posted for PR #${pr.prNumber}.`);
          } else if (!pushed) {
            ctx.log(`Review handling for PR #${pr.prNumber} produced no summary or push.`);
          }

          ctx.github.postPrComment(
            pr.prNumber,
            buildReviewsHandledComment({
              latestActivityAt,
              failed: !hasSummary && !pushed,
            }),
          );
        },
      });
    },
  });
}
