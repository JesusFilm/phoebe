// The `conflicts` kind: catch conflicted PRs up with their blockers and the
// default branch — a clean no-agent merge when possible, an agent pass when
// real conflicts remain, and a watermarked failure comment when neither works.
//
// A feature's integration PR (#341, ticket #382) is a unit here on a different
// trigger. A feature branch is long-lived by construction, so `main` moves under
// it; a branch that has merely fallen behind conflicts with nothing yet, and no
// mergeability read would ever nominate it. Left alone it drifts until the PR a
// human opens at the end of the feature is a conflict pile instead of a review.
// So the integration PR is selected on distance from the default branch, and
// then travels the ordinary run path: `cleanMerge`, the `conflict` prompt when
// that dirties, the `phoebe-conflict-fail` watermark when neither resolves it.
//
// Every merge here is against the PR's own base (#392), not the default branch.
// They are the same branch for an ordinary PR and for an integration PR; for a
// feature member the base is the feature branch, and that is the merge GitHub
// was reporting a conflict against. Catching such a PR up with the default
// branch instead resolves a different merge and pushes commits `main` has and
// the feature branch does not into a diff its reviewer never asked for.

import type { PhoebeConfig } from "../config-schema.ts";
import { parseFeatureIssueNumber } from "../feature-branch.ts";
import {
  conflictFixFailureComment,
  isPrMergeConflicting,
  parseConflictFailWatermark,
  parseLatestMarker,
  partitionConflictFixCandidates,
  pickOldestPr,
  shouldPostConflictFixFailure,
  stackedCatchUpRetractionComment,
  type ConflictFailWatermark,
  type ConflictingPrCandidate,
} from "../orchestrator.ts";
import type { BranchRef, PrNumber, Sha } from "../branded.ts";
import {
  defineWorkKind,
  type AnyWorkKindDefinition,
  type WorkKindCtx,
  type WorkUnitGitHubTarget,
} from "./definition.ts";
import {
  baseBranchOf,
  collectIssueBodies,
  collectPrCandidates,
  freshPrHeadWatermark,
  issueNumberOf,
  mergedBlockersFor,
  stackContextFor,
} from "./pr-stack.ts";

type ConflictsGathered = {
  candidates: readonly ConflictingPrCandidate[];
  issueBodies: ReadonlyMap<number, string>;
  currentMainHead: Sha;
};

type ConflictsUnit = {
  ref: string;
  github: WorkUnitGitHubTarget;
  pr: ConflictingPrCandidate;
  mergedBlockerPrNumbers: readonly PrNumber[];
};

/**
 * Fresh origin snapshot for the failure-comment watermark. The conflicts
 * watermark pins the default-branch head as well as the PR's, read off the
 * same snapshot the shared helper fetched.
 */
function currentWatermark(ctx: WorkKindCtx, pr: ConflictingPrCandidate): ConflictFailWatermark {
  return {
    ...freshPrHeadWatermark(ctx, pr),
    mainHead: ctx.origin.branchHead(ctx.config.defaultBranch),
  };
}

/** Whether this PR's head is a feature integration branch. */
function isIntegrationBranch(branch: BranchRef): boolean {
  return parseFeatureIssueNumber(branch) !== null;
}

/**
 * Whether the feature branch behind an integration PR needs catching up: only
 * while `featureBranchCatchUp` is on, and only when the default branch actually
 * carries commits the branch lacks.
 *
 * Distance, not mergeability, is the trigger — but it is also what keeps the
 * unit from recurring. A caught-up branch is zero commits behind, so it drops
 * out the moment the merge lands; were the test `mergeable === "CONFLICTING"`,
 * a branch already level with the default branch would be nominated forever by
 * a merge that could resolve nothing.
 */
function needsFeatureCatchUp(ctx: WorkKindCtx, branch: BranchRef): boolean {
  if (!ctx.config.featureBranchCatchUp) {
    return false;
  }
  return ctx.origin.commitsBehind(branch, ctx.config.defaultBranch) > 0;
}

export function conflictsKind(config: PhoebeConfig): AnyWorkKindDefinition {
  const noun = "conflicting PR(s)";
  return defineWorkKind<ConflictsGathered, ConflictsUnit>({
    name: "conflicts",
    oneShotEligible: false,
    promptFile: config.promptFiles.conflict,
    workspace: "worktree",
    report: {
      noun,
      describe: (unit) =>
        isIntegrationBranch(unit.pr.headRefName)
          ? `feature-branch catch-up for PR #${unit.pr.prNumber} (${unit.pr.headRefName})`
          : `conflict fix for PR #${unit.pr.prNumber} (${unit.pr.headRefName})`,
      idle: (_gathered, total) => `${total} ${noun} but none fixable this cycle.`,
    },
    async fetch(ctx) {
      // Fetched before the walk, not after it: the integration PR's candidacy is
      // a git question, and asking it against a stale clone would call a branch
      // current with a default branch it has never seen.
      ctx.origin.fetch();
      const currentMainHead = ctx.origin.branchHead(ctx.config.defaultBranch);
      const raw = await collectPrCandidates<ConflictingPrCandidate>(ctx, (info) => {
        const wanted = isIntegrationBranch(info.headRefName)
          ? needsFeatureCatchUp(ctx, info.headRefName)
          : isPrMergeConflicting(info.mergeable, info.mergeStateStatus);
        if (!wanted) return null;
        const issueNumber = issueNumberOf({ headRefName: info.headRefName });
        return {
          prNumber: info.number,
          headRefName: info.headRefName,
          baseRefName: info.baseRefName,
          headSha: info.headRefOid,
          ...(issueNumber !== null ? { issueNumber } : {}),
        };
      });
      const withWatermarks = raw.map((pr) => ({
        ...pr,
        failureWatermark: parseLatestMarker(
          ctx.github.prCommentBodies(pr.prNumber),
          parseConflictFailWatermark,
        ),
      }));
      const { candidates, issueBodies } = collectIssueBodies(withWatermarks, ctx);
      return { candidates, issueBodies, currentMainHead };
    },
    select(gathered, ctx) {
      const stack = stackContextFor(gathered, ctx);
      const { candidates, stacked, watermarked } = partitionConflictFixCandidates(
        gathered.candidates,
        stack,
        { currentMainHead: gathered.currentMainHead },
      );
      const pick = pickOldestPr(candidates);
      return {
        unit: pick
          ? {
              ref: `pr:${pick.prNumber}`,
              github: { objectType: "pr", id: Number(pick.prNumber) },
              pr: pick,
              mergedBlockerPrNumbers: mergedBlockersFor(
                pick,
                gathered.issueBodies,
                stack.blockerStates,
              ),
            }
          : null,
        skipped: [
          ...(stacked > 0 ? [{ reason: "stacked on open blocker", count: stacked }] : []),
          ...(watermarked > 0
            ? [{ reason: "unchanged failure watermark", count: watermarked }]
            : []),
        ],
        total: gathered.candidates.length,
      };
    },
    async run(unit, ctx) {
      const pr = unit.pr;
      const merged = unit.mergedBlockerPrNumbers;
      const base = baseBranchOf(pr, ctx);
      const what = isIntegrationBranch(pr.headRefName) ? "Feature-branch catch-up" : "Conflict fix";
      ctx.log(`${what}: PR #${pr.prNumber} (${pr.headRefName}) onto ${base}.`);
      ctx.origin.fetch();
      if (merged.length > 0) {
        ctx.log(
          `Stacked catch-up: merging blocker PR(s) ${merged.map((n) => `#${n}`).join(", ")} ` +
            `before ${base}.`,
        );
      }

      // The no-agent clean merge first; only bring in the agent when real
      // conflicts remain. A merge that fails without unresolved paths has
      // nothing there for the agent to resolve.
      const cleanResult = ctx.agent.cleanMerge(pr.headRefName, merged, base);
      if (cleanResult === "pushed") {
        ctx.log(`Clean merge for PR #${pr.prNumber} — pushed.`);
        if (merged.length > 0) {
          ctx.github.postPrComment(pr.prNumber, stackedCatchUpRetractionComment(merged));
        }
        return;
      }
      if (cleanResult === "failed") {
        ctx.log(`Could not start merge for PR #${pr.prNumber} — skipping.`);
        ctx.github.postPrComment(
          pr.prNumber,
          conflictFixFailureComment(pr.prNumber, currentWatermark(ctx, pr)),
        );
        return;
      }

      await ctx.agent.prWorkflow({
        pr: { prNumber: pr.prNumber, headRefName: pr.headRefName },
        promptArgs: {
          PR_NUMBER: String(pr.prNumber),
          PR_BRANCH: pr.headRefName,
          BASE_BRANCH: base,
          BLOCKER_PR_NUMBERS: merged.join(","),
        },
        primeBlockerMerges: merged,
        baseBranch: base,
        onResult: ({ originShaBefore, originShaAfter, localCommitCount, push }) => {
          const prInfo = ctx.github.currentMergeInfo(pr.prNumber);
          if (
            shouldPostConflictFixFailure({
              hostCommitCount: localCommitCount,
              originShaBefore,
              originShaAfter,
              mergeable: prInfo.mergeable,
              mergeStateStatus: prInfo.mergeStateStatus,
            })
          ) {
            ctx.log(
              `Conflict fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
            );
            ctx.github.postPrComment(
              pr.prNumber,
              conflictFixFailureComment(pr.prNumber, currentWatermark(ctx, pr)),
            );
          } else if (localCommitCount > 0) {
            push();
            ctx.log(`Conflict resolved for PR #${pr.prNumber} — pushed.`);
          } else {
            ctx.log(`Conflict resolved for PR #${pr.prNumber} — already pushed by agent.`);
          }
        },
      });
    },
  });
}
