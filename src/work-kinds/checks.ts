// The `checks` kind: fix PRs whose CI is red. A PR that is merely BEHIND gets
// a catch-up merge first (CI may pass once caught up, no agent needed); a
// catch-up that conflicts defers to the `conflicts` kind; otherwise the checks
// agent runs, pushing what it committed or watermarking the failure.

import type { PhoebeConfig } from "../config-schema.ts";
import {
  checksFixFailureComment,
  formatFailingChecksForPrompt,
  isPrMergeConflicting,
  listFailingChecks,
  parseChecksFailWatermark,
  parseLatestMarker,
  pickOldestPr,
  selectChecksCandidates,
  shouldPostChecksFixFailure,
  stackedCatchUpRetractionComment,
  statusCheckRollupState,
  workflowRunsToCheckItems,
  type ChecksCandidate,
  type ChecksFailWatermark,
} from "../orchestrator.ts";
import type { PrNumber } from "../branded.ts";
import {
  defineWorkKind,
  type AnyWorkKindDefinition,
  type WorkKindCtx,
  type WorkUnitGitHubTarget,
} from "./definition.ts";
import { collectIssueBodies, issueNumberOf, mergedBlockersFor } from "./pr-stack.ts";

const CHECKS_PENDING_RETRY_MS = 5_000;
const CHECKS_PENDING_RETRY_COUNT = 3;

type ChecksGathered = {
  candidates: readonly ChecksCandidate[];
  issueBodies: ReadonlyMap<number, string>;
};

type ChecksUnit = {
  ref: string;
  github: WorkUnitGitHubTarget;
  pr: ChecksCandidate;
  mergedBlockerPrNumbers: readonly PrNumber[];
};

/** Fresh origin snapshot for the failure-comment watermark. */
function currentWatermark(ctx: WorkKindCtx, pr: ChecksCandidate): ChecksFailWatermark {
  ctx.origin.fetch();
  return { prHead: ctx.origin.branchHead(pr.headRefName) };
}

export function checksKind(config: PhoebeConfig): AnyWorkKindDefinition {
  const noun = "failing-CI PR(s)";
  return defineWorkKind<ChecksGathered, ChecksUnit>({
    name: "checks",
    oneShotEligible: false,
    promptFile: config.promptFiles.checks,
    workspace: "worktree",
    report: {
      noun,
      describe: (unit) => `checks fix for PR #${unit.pr.prNumber} (${unit.pr.headRefName})`,
      idle: (_gathered, total) => `${total} ${noun} but none fixable this cycle.`,
    },
    async fetch(ctx) {
      const raw: ChecksCandidate[] = [];
      for (const pr of ctx.github.openPrs()) {
        try {
          const info = await ctx.github.mergeInfo(pr.number);
          if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) continue;
          // CI still settling reads as PENDING; retry briefly before deciding.
          for (let attempt = 0; attempt < CHECKS_PENDING_RETRY_COUNT; attempt++) {
            const checkItems = workflowRunsToCheckItems(
              ctx.github.commitCheckItems(info.headRefOid),
            );
            const rollup = statusCheckRollupState(checkItems);
            if (rollup === "FAILURE") {
              const issueNumber = issueNumberOf({ headRefName: info.headRefName });
              raw.push({
                prNumber: info.number,
                headRefName: info.headRefName,
                headSha: info.headRefOid,
                mergeable: info.mergeable,
                mergeStateStatus: info.mergeStateStatus,
                failingChecks: listFailingChecks(checkItems),
                ...(issueNumber !== null ? { issueNumber } : {}),
              });
              break;
            }
            if (rollup !== "PENDING") break;
            if (attempt < CHECKS_PENDING_RETRY_COUNT - 1) {
              await ctx.clock.sleep(CHECKS_PENDING_RETRY_MS);
            }
          }
        } catch (error) {
          console.warn(
            `[phoebe] Skipping PR #${pr.number} for checks this cycle — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const withWatermarks = raw.map((pr) => ({
        ...pr,
        failureWatermark: parseLatestMarker(
          ctx.github.prCommentBodies(pr.prNumber),
          parseChecksFailWatermark,
        ),
      }));
      const { candidates, issueBodies } = collectIssueBodies(withWatermarks, ctx);
      return { candidates, issueBodies };
    },
    select(gathered, ctx) {
      const stack = {
        issueBodies: gathered.issueBodies,
        blockerStates: ctx.cycle.blockerStates(),
      };
      const candidates = selectChecksCandidates(gathered.candidates, stack);
      const pick = pickOldestPr(candidates);
      const turnedAway = gathered.candidates.length - candidates.length;
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
        skipped:
          turnedAway > 0
            ? [{ reason: "conflicting, stacked, or watermarked", count: turnedAway }]
            : [],
        total: gathered.candidates.length,
      };
    },
    async run(unit, ctx) {
      const pr = unit.pr;
      ctx.log(
        `Checks fix: PR #${pr.prNumber} (${pr.headRefName}) — ` +
          `${pr.failingChecks.map((c) => c.name).join(", ")}.`,
      );
      ctx.origin.fetch();

      if (pr.mergeStateStatus === "BEHIND") {
        const merged = unit.mergedBlockerPrNumbers;
        if (merged.length > 0) {
          ctx.log(
            `Behind main — catch-up merging blocker PR(s) ${merged.map((n) => `#${n}`).join(", ")} ` +
              `before ${ctx.config.defaultBranch}.`,
          );
        } else {
          ctx.log(`Behind main — catch-up merge for PR #${pr.prNumber}.`);
        }

        const cleanResult = ctx.agent.cleanMerge(pr.headRefName, merged);
        if (cleanResult === "pushed") {
          ctx.log(`Catch-up merge for PR #${pr.prNumber} — pushed; waiting for CI on next cycle.`);
          if (merged.length > 0) {
            ctx.github.postPrComment(pr.prNumber, stackedCatchUpRetractionComment(merged));
          }
          return;
        }
        if (cleanResult === "conflicted" || cleanResult === "failed") {
          ctx.log(
            `Catch-up merge conflicted for PR #${pr.prNumber} — deferring to the conflicts kind.`,
          );
          return;
        }
      }

      await ctx.agent.prWorkflow({
        pr: { prNumber: pr.prNumber, headRefName: pr.headRefName },
        promptArgs: {
          PR_NUMBER: String(pr.prNumber),
          PR_BRANCH: pr.headRefName,
          FAILING_CHECKS: formatFailingChecksForPrompt(pr.failingChecks),
        },
        onResult: ({ originShaBefore, originShaAfter, localCommitCount, push }) => {
          if (
            shouldPostChecksFixFailure({
              hostCommitCount: localCommitCount,
              originShaBefore,
              originShaAfter,
            })
          ) {
            ctx.log(
              `Checks fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
            );
            ctx.github.postPrComment(
              pr.prNumber,
              checksFixFailureComment(pr.prNumber, currentWatermark(ctx, pr)),
            );
          } else if (localCommitCount > 0) {
            push();
            ctx.log(`Checks fixed for PR #${pr.prNumber} — pushed.`);
          } else {
            ctx.log(`Checks fixed for PR #${pr.prNumber} — already pushed by agent.`);
          }
        },
      });
    },
  });
}
