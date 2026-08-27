// The `conflicts` kind: catch conflicted PRs up with their blockers and the
// default branch — a clean no-agent merge when possible, an agent pass when
// real conflicts remain, and a watermarked failure comment when neither works.

import type { PhoebeConfig } from "../config-schema.ts";
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
import type { PrNumber, Sha } from "../branded.ts";
import {
  defineWorkKind,
  type AnyWorkKindDefinition,
  type WorkKindCtx,
  type WorkUnitGitHubTarget,
} from "./definition.ts";
import { collectIssueBodies, issueNumberOf, mergedBlockersFor } from "./pr-stack.ts";

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

/** Fresh origin snapshot for the failure-comment watermark. */
function currentWatermark(ctx: WorkKindCtx, pr: ConflictingPrCandidate): ConflictFailWatermark {
  ctx.origin.fetch();
  return {
    prHead: ctx.origin.branchHead(pr.headRefName),
    mainHead: ctx.origin.branchHead(ctx.config.defaultBranch),
  };
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
      describe: (unit) => `conflict fix for PR #${unit.pr.prNumber} (${unit.pr.headRefName})`,
      idle: (_gathered, total) => `${total} ${noun} but none fixable this cycle.`,
    },
    async fetch(ctx) {
      const raw: ConflictingPrCandidate[] = [];
      for (const pr of ctx.github.openPrs()) {
        try {
          const info = await ctx.github.mergeInfo(pr.number);
          if (!isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) continue;
          const issueNumber = issueNumberOf({ headRefName: info.headRefName });
          raw.push({
            prNumber: info.number,
            headRefName: info.headRefName,
            headSha: info.headRefOid,
            ...(issueNumber !== null ? { issueNumber } : {}),
          });
        } catch (error) {
          console.warn(
            `[phoebe] Skipping PR #${pr.number} for conflicts this cycle — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      ctx.origin.fetch();
      const currentMainHead = ctx.origin.branchHead(ctx.config.defaultBranch);
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
      const stack = {
        issueBodies: gathered.issueBodies,
        blockerStates: ctx.cycle.blockerStates(),
      };
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
      ctx.log(`Conflict fix: PR #${pr.prNumber} (${pr.headRefName}).`);
      ctx.origin.fetch();
      if (merged.length > 0) {
        ctx.log(
          `Stacked catch-up: merging blocker PR(s) ${merged.map((n) => `#${n}`).join(", ")} ` +
            `before ${ctx.config.defaultBranch}.`,
        );
      }

      // The no-agent clean merge first; only bring in the agent when real
      // conflicts remain. A merge that fails without unresolved paths has
      // nothing there for the agent to resolve.
      const cleanResult = ctx.agent.cleanMerge(pr.headRefName, merged);
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
          BLOCKER_PR_NUMBERS: merged.join(","),
        },
        primeBlockerMerges: merged,
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
