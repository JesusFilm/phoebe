// The `checks` work kind: PRs whose CI has failed. Selection picks the oldest
// eligible failing-CI PR; a PR that has merely fallen `BEHIND` its base gets a
// clean catch-up merge instead of an agent (CI re-runs on the next cycle).

import { asBranchRef, type BranchRef, type PrNumber, type Sha } from "../branded.ts";
import { createPhoebeLog } from "../phoebe-log.ts";
import {
  buildChecksFailWatermarkMarker,
  parseChecksFailWatermark,
  parseLatestMarker,
  type ChecksFailWatermark,
} from "../markers.ts";
import { isPrMergeConflicting, parseIssueNumberFromBranch } from "../pr-scope.ts";
import {
  filterBackoffEligible,
  findLatestUnitAttemptComment,
  slugifyFailureSignature,
} from "../quarantine.ts";
import type { UnitAttemptMarker } from "../quarantine.ts";
import {
  getMergedBlockerPrNumbers,
  shouldSkipStackedFix,
  stackedCatchUpRetractionComment,
  type StackContext,
} from "../stack.ts";
import type { WorkflowRunItem } from "../github.ts";
import type { CycleContext } from "../cycle.ts";
import {
  createJanitorHelpers,
  MERGEABLE_RETRY_COUNT,
  MERGEABLE_RETRY_MS,
  pickOldestPr,
  sleep,
} from "./janitor.ts";
import type { KindDeps, UnitRef, UnitResult, WorkKind } from "./kind.ts";

export type StatusCheckItem = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};

export type FailingCheck = { name: string; conclusion: string };

function checkItemName(item: StatusCheckItem): string {
  return item.name ?? item.context ?? "unknown";
}

function isCheckItemFailing(item: StatusCheckItem): boolean {
  if (item.__typename === "CheckRun" || item.status !== undefined) {
    const conclusion = item.conclusion ?? "";
    return (
      conclusion === "FAILURE" ||
      conclusion === "CANCELLED" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "ACTION_REQUIRED"
    );
  }
  const state = item.state ?? "";
  return state === "FAILURE" || state === "ERROR";
}

function isCheckItemPending(item: StatusCheckItem): boolean {
  if (item.__typename === "CheckRun" || item.status !== undefined) {
    const status = item.status ?? "";
    return (
      status === "QUEUED" ||
      status === "IN_PROGRESS" ||
      status === "WAITING" ||
      status === "PENDING" ||
      status === "REQUESTED"
    );
  }
  const state = item.state ?? "";
  return state === "PENDING" || state === "EXPECTED";
}

/** Combined rollup: FAILURE when at least one check failed and none are pending. */
function statusCheckRollupState(
  checks: readonly StatusCheckItem[],
): "FAILURE" | "PENDING" | "SUCCESS" | "NONE" {
  if (checks.length === 0) {
    return "NONE";
  }
  if (checks.some(isCheckItemPending)) {
    return "PENDING";
  }
  if (checks.some(isCheckItemFailing)) {
    return "FAILURE";
  }
  return "SUCCESS";
}

/**
 * Map `gh run list` rows onto StatusCheckItem. The REST Actions API is the
 * check-state source usable by fine-grained PATs — GraphQL statusCheckRollup
 * is GitHub-App/OAuth only. REST enums are lowercase; rows arrive newest
 * first, and only the newest run per workflow counts.
 */
function workflowRunsToCheckItems(runs: readonly WorkflowRunItem[]): StatusCheckItem[] {
  const seen = new Set<string>();
  const items: StatusCheckItem[] = [];
  for (const run of runs) {
    const name = run.workflowName ?? run.name ?? "unknown";
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    items.push({
      name,
      status: (run.status ?? "").toUpperCase(),
      conclusion: run.conclusion ? run.conclusion.toUpperCase() : null,
    });
  }
  return items;
}

function listFailingChecks(checks: readonly StatusCheckItem[]): FailingCheck[] {
  return checks.filter(isCheckItemFailing).map((item) => ({
    name: checkItemName(item),
    conclusion: item.conclusion ?? item.state ?? "",
  }));
}

export function formatFailingChecksForPrompt(checks: readonly FailingCheck[]): string {
  return checks.map((c) => `${c.name}: ${c.conclusion}`).join("\n");
}

export type ChecksUnit = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  baseRefName?: BranchRef;
  issueNumber?: number;
  headSha?: Sha;
  mergeable: string;
  mergeStateStatus?: string;
  failingChecks: FailingCheck[];
  failureWatermark?: ChecksFailWatermark | null;
  /** No-commit-attempt counter (#25) — read from the unit's tracking comment. */
  attemptMarker?: UnitAttemptMarker | null;
};

export type ChecksData = {
  failingCheckPrs: readonly ChecksUnit[];
  stack: StackContext;
};

function shouldSkipWatermarkFix(opts: {
  watermark: ChecksFailWatermark | null;
  currentPrHead: Sha;
}): boolean {
  if (!opts.watermark) {
    return false;
  }
  return opts.watermark.prHead === opts.currentPrHead;
}

function failureSignature(failingChecks: readonly FailingCheck[]): string {
  if (failingChecks.length === 0) {
    return "checks-failed";
  }
  return slugifyFailureSignature(`checks-failed-${failingChecks.map((c) => c.name).join("-")}`);
}

function failureComment(prNumber: PrNumber, watermark?: ChecksFailWatermark): string {
  const parts = [
    `Phoebe attempted an idle CI fix for PR #${prNumber} but could not resolve the failing ` +
      `checks. The branch was left unchanged. A human should investigate the CI failures.`,
  ];
  if (watermark) {
    parts.push("", buildChecksFailWatermarkMarker(watermark));
  }
  return parts.join("\n");
}

/** Post a failure comment only when the agent made no commits and did not push. */
function shouldPostFailure(opts: {
  hostCommitCount: number;
  originShaBefore: Sha;
  originShaAfter: Sha;
}): boolean {
  if (opts.hostCommitCount > 0) {
    return false;
  }
  return opts.originShaAfter === opts.originShaBefore;
}

export function createChecksKind(deps: KindDeps): WorkKind<ChecksData, ChecksUnit> {
  const { config, io } = deps;
  const { phoebeLog, phoebeError } = createPhoebeLog(config.repoSlug);
  const janitor = createJanitorHelpers(deps, phoebeLog);
  const defaultBranchRef = asBranchRef(config.defaultBranch);

  function candidates(units: readonly ChecksUnit[], ctx: StackContext): ChecksUnit[] {
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
      if (pr.headSha) {
        if (
          shouldSkipWatermarkFix({
            watermark: pr.failureWatermark ?? null,
            currentPrHead: pr.headSha,
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
  }): Promise<ChecksUnit | null> {
    for (let attempt = 0; attempt < MERGEABLE_RETRY_COUNT; attempt++) {
      const info = io.github.prMergeInfo(pr.number);
      if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
        return null;
      }
      const checkItems = workflowRunsToCheckItems(io.github.commitCheckRuns(info.headRefOid));
      const rollup = statusCheckRollupState(checkItems);
      if (rollup === "FAILURE") {
        const issueNumber = parseIssueNumberFromBranch(info.headRefName, config.branchPrefix);
        return {
          prNumber: info.number,
          headRefName: info.headRefName,
          baseRefName: info.baseRefName,
          headSha: info.headRefOid,
          mergeable: info.mergeable,
          mergeStateStatus: info.mergeStateStatus,
          failingChecks: listFailingChecks(checkItems),
          ...(issueNumber !== null ? { issueNumber } : {}),
        };
      }
      if (rollup !== "PENDING" && info.mergeable !== "UNKNOWN") {
        return null;
      }
      if (attempt < MERGEABLE_RETRY_COUNT - 1) {
        await sleep(MERGEABLE_RETRY_MS);
      }
    }
    return null;
  }

  async function fetch(ctx: CycleContext): Promise<ChecksData> {
    const raw: ChecksUnit[] = [];
    for (const pr of ctx.openPrs) {
      try {
        const candidate = await candidateForPr(pr);
        if (candidate) {
          raw.push(candidate);
        }
      } catch (error) {
        phoebeError(
          `Skipping PR #${pr.number} for checks this cycle — ${error instanceof Error ? error.message : String(error)}`,
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
          parseChecksFailWatermark,
        ),
        attemptMarker: findLatestUnitAttemptComment(comments, "checks")?.marker ?? null,
      };
    });
    // #25: a unit still inside its no-commit-attempt backoff window sits this cycle out.
    const failingCheckPrs = filterBackoffEligible(withMarkers, nowIso);
    const stack: StackContext = { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates };
    return { failingCheckPrs, stack };
  }

  function select(data: ChecksData, ctx: CycleContext): ChecksUnit | null {
    const stack: StackContext = { issueBodies: ctx.issueBodies, blockerStates: ctx.blockerStates };
    return pickOldestPr(candidates(data.failingCheckPrs, stack));
  }

  function refFor(unit: ChecksUnit): UnitRef {
    return {
      kind: "checks",
      target: { type: "pr", number: unit.prNumber },
      branch: unit.headRefName,
    };
  }

  function describeIdle(data: ChecksData): string | null {
    if (data.failingCheckPrs.length === 0) {
      return null;
    }
    const eligible = candidates(data.failingCheckPrs, data.stack);
    const skipped = data.failingCheckPrs.length - eligible.length;
    if (skipped > 0) {
      phoebeLog(`${skipped} failing-CI PR(s) skipped (conflicting, stacked, or watermarked).`);
    }
    if (pickOldestPr(eligible)) {
      return null;
    }
    return `${data.failingCheckPrs.length} failing-CI PR(s) but none fixable this cycle.`;
  }

  function currentFailureWatermark(branch: BranchRef): ChecksFailWatermark {
    io.git.fetchOrigin();
    return { prHead: io.git.originBranchSha(branch) };
  }

  async function runResolutionAgent(pr: ChecksUnit): Promise<UnitResult> {
    return janitor.runAgentWorkflow({
      pr,
      promptFile: config.promptFiles.checks,
      promptArgs: {
        PR_NUMBER: String(pr.prNumber),
        PR_BRANCH: pr.headRefName,
        FAILING_CHECKS: formatFailingChecksForPrompt(pr.failingChecks),
      },
      onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
        if (
          shouldPostFailure({ hostCommitCount: localCommitCount, originShaBefore, originShaAfter })
        ) {
          phoebeLog(
            `Checks fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
          );
          const watermark = currentFailureWatermark(pr.headRefName);
          janitor.recordFailedAttempt({
            kind: "checks",
            prNumber: pr.prNumber,
            currentPrHead: watermark.prHead,
            signature: failureSignature(pr.failingChecks),
            failureComment: failureComment(pr.prNumber, watermark),
          });
        } else if (localCommitCount > 0) {
          io.git.pushBranch(worktreeDir, branch);
          phoebeLog(`Checks fixed for PR #${pr.prNumber} — pushed.`);
        } else {
          phoebeLog(`Checks fixed for PR #${pr.prNumber} — already pushed by agent.`);
        }
      },
    });
  }

  async function run(pr: ChecksUnit, ctx: CycleContext): Promise<UnitResult> {
    const baseBranch = pr.baseRefName ?? defaultBranchRef;
    phoebeLog(
      `Checks fix: PR #${pr.prNumber} (${pr.headRefName}) — ${pr.failingChecks.map((c) => c.name).join(", ")}.`,
    );
    io.git.fetchOrigin();

    if (pr.mergeStateStatus === "BEHIND") {
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
          `Behind ${baseBranch} — catch-up merging blocker PR(s) ${mergedBlockerPrNumbers.map((n) => `#${n}`).join(", ")} before ${baseBranch}.`,
        );
      } else {
        phoebeLog(`Behind ${baseBranch} — catch-up merge for PR #${pr.prNumber}.`);
      }

      const cleanResult = janitor.tryCleanMerge(pr.headRefName, mergedBlockerPrNumbers, baseBranch);
      if (cleanResult === "pushed") {
        phoebeLog(`Catch-up merge for PR #${pr.prNumber} — pushed; waiting for CI on next cycle.`);
        if (mergedBlockerPrNumbers.length > 0) {
          io.github.commentPr(pr.prNumber, stackedCatchUpRetractionComment(mergedBlockerPrNumbers));
        }
        return { exitCode: null };
      }
      if (cleanResult === "conflicted" || cleanResult === "failed") {
        phoebeLog(
          `Catch-up merge conflicted for PR #${pr.prNumber} — deferring to conflicts mode.`,
        );
        return { exitCode: null };
      }
    }

    return runResolutionAgent(pr);
  }

  return { name: "checks", oneShot: false, fetch, select, run, refFor, describeIdle };
}
