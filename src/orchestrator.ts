// Per-work-kind pure selection logic for Phoebe's orchestrator, plus a
// re-export shim over the cross-kind modules (`stack.ts`, `pr-scope.ts`,
// `markers.ts`) so `main.ts` and existing tests keep a single import path.
// Kept separate from main.ts so it can be unit-tested without Docker/gh.
//
// The re-export shim is temporary (issue #52, step 1 of 3): step 2 deletes
// it once `main.ts` imports the three modules directly.

import type { BranchRef, PrNumber, Sha } from "./branded.ts";
import type { WorkKindName } from "./config/index.ts";
import { config } from "./resolved-config.ts";
import {
  PHOEBE_QUARANTINE_LABEL,
  shouldBackoffUnitRetry,
  type UnitAttemptMarker,
} from "./quarantine.ts";
import {
  issueBlockers,
  resolveWorktreeBase,
  shouldSkipStackedFix,
  stackedPrComment,
  type BaseResolution,
  type BlockerPrState,
  type Issue,
  type NativeBlockerMap,
  type StackConfig,
  type StackContext,
} from "./stack.ts";
import { isPrMergeConflicting, parseIssueNumberFromBranch } from "./pr-scope.ts";
import {
  buildChecksFailWatermarkMarker,
  buildConflictFailWatermarkMarker,
  buildReviewsHandledMarker,
  type ChecksFailWatermark,
  type ConflictFailWatermark,
  type ReviewsHandledWatermark,
} from "./markers.ts";

export {
  validateWorkOrder,
  BLOCKER_SOURCES,
  STACK_MODES,
  WORK_KIND_NAMES,
  type BlockerSource,
  type StackMode,
  type WorkKindName,
} from "./config/index.ts";

export {
  parseBlockedBy,
  mergeBlockerNumbers,
  issueBlockers,
  issueBranch,
  resolveWorktreeBase,
  resolveStackedPrPlan,
  stackedPrComment,
  nativeStackGitConfig,
  ghStackExtensionInstallArgs,
  getMergedBlockerPrNumbers,
  stackedCatchUpRetractionComment,
  selectStackRetargetCandidates,
  stackRetargetedComment,
  findBlockedDependents,
  type BaseResolution,
  type BlockerConfig,
  type BlockerPrState,
  type NativeBlockerMap,
  type Issue,
  type StackConfig,
  type StackContext,
  type StackedPrPlan,
  type StackRetargetCandidate,
} from "./stack.ts";

export {
  isPhoebeHeadBranch,
  isPrInScope,
  isPrMergeConflicting,
  parseIssueNumberFromBranch,
  type PrScanFields,
  type PrScopeConfig,
} from "./pr-scope.ts";

export {
  parseLatestMarker,
  buildConflictFailWatermarkMarker,
  parseConflictFailWatermark,
  buildChecksFailWatermarkMarker,
  parseChecksFailWatermark,
  buildReviewsHandledMarker,
  parseReviewsHandledWatermark,
  type ChecksFailWatermark,
  type ConflictFailWatermark,
  type ReviewsHandledWatermark,
} from "./markers.ts";

const PRIORITY_ORDER = ["bug", "tracer", "polish", "refactor"] as const;
export type Priority = (typeof PRIORITY_ORDER)[number];

export function classifyPriority(issue: Issue): Priority {
  const text = `${issue.title} ${issue.body}`.toLowerCase();
  if (/\b(bug|broken|crash|regression|fix)\b/.test(text)) return "bug";
  if (/\b(tracer|wire|poc)\b/.test(text)) return "tracer";
  if (/\brefactor\b/.test(text)) return "refactor";
  return "polish";
}

export function compareIssues(a: Issue, b: Issue): number {
  const pa = PRIORITY_ORDER.indexOf(classifyPriority(a));
  const pb = PRIORITY_ORDER.indexOf(classifyPriority(b));
  if (pa !== pb) return pa - pb;
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return ta - tb;
  return a.number - b.number;
}

/** The blocker/branch config `resolveWorktreeBase`/`issueBlockers` need, read from the singleton. */
function stackConfigFromConfig(): StackConfig {
  return {
    blockedByPattern: config.blockedByPattern,
    blockerSource: config.blockerSource,
    branchPrefix: config.branchPrefix,
    stackMode: config.stackMode,
  };
}

export type IssueScopeConfig = {
  issueAuthors: readonly string[];
};

const defaultIssueScopeConfig = (): IssueScopeConfig => ({
  issueAuthors: config.issueAuthors,
});

/**
 * Whether a `ready`/`research` issue is eligible for pickup — an author
 * allowlist mirroring `isPrInScope`'s, so one operator's Phoebe on a
 * multi-operator repo skips tickets filed for someone else's instance.
 * Unset `issueAuthors` (the default) admits every author.
 */
export function isIssueInScope(
  issue: Pick<Issue, "authorLogin">,
  scopeConfig: IssueScopeConfig = defaultIssueScopeConfig(),
): boolean {
  if (scopeConfig.issueAuthors.length === 0) {
    return true;
  }
  return scopeConfig.issueAuthors.some(
    (author) => author.toLowerCase() === (issue.authorLogin ?? "").toLowerCase(),
  );
}

/** Pick the highest-priority workable issue, or `null` when none qualify. */
export function selectIssue(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): { issue: Issue; resolution: BaseResolution } | null {
  // Quarantined issues/research tickets (#75) are skipped for work until a human
  // clears the label or the issue is edited (the auto-un-stick sweep).
  const eligible = issues.filter((issue) => !issue.labels.includes(PHOEBE_QUARANTINE_LABEL));
  const sorted = [...eligible].sort(compareIssues);
  for (const issue of sorted) {
    const resolution = resolveWorktreeBase(
      issue,
      blockerStates,
      phoebeBase,
      nativeBlockersByIssue.get(issue.number) ?? [],
      stackConfigFromConfig(),
    );
    if (resolution) {
      return { issue, resolution };
    }
  }
  return null;
}

/**
 * The full `issues` work order, ordered as {@link selectIssue} would take it,
 * with each entry's resolved blocker set and whether it is workable this
 * cycle — the status-v2 `queue` lookahead. Unlike `selectIssue`, which stops at
 * the first workable candidate, this walks every eligible issue so an operator
 * can see what comes after `activeWork`, not just what runs next.
 */
export function buildIssueQueue(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): Array<{ issueNumber: number; blockedBy: readonly number[]; workable: boolean }> {
  const eligible = issues.filter((issue) => !issue.labels.includes(PHOEBE_QUARANTINE_LABEL));
  const sorted = [...eligible].sort(compareIssues);
  return sorted.map((issue) => {
    const nativeBlockers = nativeBlockersByIssue.get(issue.number) ?? [];
    const stackConfig = stackConfigFromConfig();
    return {
      issueNumber: issue.number,
      blockedBy: issueBlockers(issue, stackConfig, nativeBlockers),
      workable:
        resolveWorktreeBase(issue, blockerStates, phoebeBase, nativeBlockers, stackConfig) !== null,
    };
  });
}

export type ConflictingPrCandidate = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  baseRefName?: BranchRef;
  issueNumber?: number;
  headSha?: Sha;
  baseSha?: Sha;
  failureWatermark?: ConflictFailWatermark | null;
  /** No-commit-attempt counter (#25) — read from the unit's tracking comment. */
  attemptMarker?: UnitAttemptMarker | null;
};

export function shouldSkipWatermarkConflictFix(opts: {
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

/** Pick the single conflict unit — oldest PR number among unblocked candidates. */
export function selectConflictUnit(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): ConflictingPrCandidate | null {
  return pickOldestPr(selectConflictFixCandidates(prs, ctx, opts));
}

export function selectConflictFixCandidates(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): ConflictingPrCandidate[] {
  return prs.filter((pr) => {
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
        shouldSkipWatermarkConflictFix({
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

/**
 * Drop PR-keyed candidates that are inside their no-commit-attempt backoff
 * window (#25) — a transient failure (rate limit, 504) then recovers on its
 * own instead of burning a full agent cycle every poll while it's within the
 * growing gap between retries. A quarantined unit never reaches this filter:
 * it's already excluded upstream by the `PHOEBE_QUARANTINE_LABEL` scope check.
 */
export function filterBackoffEligible<T extends { attemptMarker?: UnitAttemptMarker | null }>(
  candidates: readonly T[],
  now: string,
): T[] {
  return candidates.filter((c) => {
    const marker = c.attemptMarker;
    if (!marker) {
      return true;
    }
    return !shouldBackoffUnitRetry({ attemptCount: marker.n, lastAttemptAt: marker.at, now });
  });
}

export type StatusCheckItem = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};

export type FailingCheck = {
  name: string;
  conclusion: string;
};

export function checkItemName(item: StatusCheckItem): string {
  return item.name ?? item.context ?? "unknown";
}

export function isCheckItemFailing(item: StatusCheckItem): boolean {
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

export function isCheckItemPending(item: StatusCheckItem): boolean {
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
export function statusCheckRollupState(
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

export type WorkflowRunItem = {
  workflowName?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
};

/**
 * Map `gh run list` rows onto StatusCheckItem. The REST Actions API is the
 * check-state source usable by fine-grained PATs — GraphQL statusCheckRollup
 * is GitHub-App/OAuth only. REST enums are lowercase; rows arrive newest
 * first, and only the newest run per workflow counts.
 */
export function workflowRunsToCheckItems(runs: readonly WorkflowRunItem[]): StatusCheckItem[] {
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

export function listFailingChecks(checks: readonly StatusCheckItem[]): FailingCheck[] {
  return checks.filter(isCheckItemFailing).map((item) => ({
    name: checkItemName(item),
    conclusion: item.conclusion ?? item.state ?? "",
  }));
}

export type ChecksCandidate = {
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

export function shouldSkipWatermarkChecksFix(opts: {
  watermark: ChecksFailWatermark | null;
  currentPrHead: Sha;
}): boolean {
  if (!opts.watermark) {
    return false;
  }
  return opts.watermark.prHead === opts.currentPrHead;
}

export function selectChecksCandidates(
  prs: readonly ChecksCandidate[],
  ctx: StackContext,
): ChecksCandidate[] {
  return prs.filter((pr) => {
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
        shouldSkipWatermarkChecksFix({
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

/** Pick the single checks unit — oldest PR number among eligible failing-CI candidates. */
export function selectChecksUnit(
  prs: readonly ChecksCandidate[],
  ctx: StackContext,
): ChecksCandidate | null {
  return pickOldestPr(selectChecksCandidates(prs, ctx));
}

export type ReviewThreadComment = {
  createdAt: string;
  authorLogin: string;
};

export type ReviewThread = {
  isResolved: boolean;
  isOutdated: boolean;
  comments: readonly ReviewThreadComment[];
};

export type ReviewsCandidate = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  baseRefName?: BranchRef;
  issueNumber?: number;
  authorLogin?: string;
  mergeable: string;
  mergeStateStatus?: string;
  threads: readonly ReviewThread[];
  handledWatermark?: ReviewsHandledWatermark | null;
};

export function isReviewSummaryComment(body: string): boolean {
  return body.includes(config.reviewsSuccessHeading);
}

export function isActivityNewerThanWatermark(
  createdAt: string,
  watermark: ReviewsHandledWatermark | null,
): boolean {
  if (!watermark) {
    return true;
  }
  return createdAt > watermark.latest;
}

export function newestReviewThreadCommentCreatedAt(
  threads: readonly ReviewThread[],
): string | null {
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

export function hasNewNonPhoebeReviewActivity(opts: {
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

export function selectReviewsCandidates(
  prs: readonly ReviewsCandidate[],
  ctx: StackContext,
  phoebeLogin: string,
): ReviewsCandidate[] {
  return prs.filter((pr) => {
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

/** Pick the single reviews unit — oldest PR number among eligible review-feedback candidates. */
export function selectReviewsUnit(
  prs: readonly ReviewsCandidate[],
  ctx: StackContext,
  phoebeLogin: string,
): ReviewsCandidate | null {
  return pickOldestPr(selectReviewsCandidates(prs, ctx, phoebeLogin));
}

export function buildReviewsHandledComment(opts: {
  latestActivityAt: string | null;
  failed: boolean;
}): string {
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

/** Whether a work-kind may run under `--run-once`. Janitor kinds are persistent-mode only. */
export const WORK_KIND_ONE_SHOT_ELIGIBLE: Record<WorkKindName, boolean> = {
  conflicts: false,
  checks: false,
  reviews: false,
  issues: true,
  research: true,
};

export const RUN_ONCE_NOTHING_MESSAGE =
  "Nothing to do under --run-once (janitor kinds are persistent-mode only).";

export function oneShotWorkKinds(workOrder: readonly WorkKindName[]): readonly WorkKindName[] {
  return workOrder.filter((kind) => WORK_KIND_ONE_SHOT_ELIGIBLE[kind]);
}

/** Oldest PR (lowest number) among candidates, or `null` when the list is empty. */
function pickOldestPr<T extends { prNumber: number }>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((oldest, pr) => (pr.prNumber < oldest.prNumber ? pr : oldest));
}

export type IssueWorkUnit = { issue: Issue; resolution: BaseResolution };

export type WorkUnit =
  | { kind: "conflicts"; unit: ConflictingPrCandidate }
  | { kind: "checks"; unit: ChecksCandidate }
  | { kind: "reviews"; unit: ReviewsCandidate }
  | { kind: "issues"; unit: IssueWorkUnit }
  | { kind: "research"; unit: IssueWorkUnit };

export type WorkSelectionData = {
  issues: readonly Issue[];
  /** Wayfinder research tickets selected by the `research` kind (reuses the issues path). */
  researchIssues?: readonly Issue[];
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  /** Native (issue-dependencies API) blockers per issue number; empty in body-only mode. */
  nativeBlockersByIssue?: NativeBlockerMap;
  conflictingPrs: readonly ConflictingPrCandidate[];
  failingCheckPrs: readonly ChecksCandidate[];
  reviewActivityPrs: readonly ReviewsCandidate[];
  issueBodies: ReadonlyMap<number, string>;
  phoebeBase?: string;
  phoebeLogin?: string;
  currentMainHead?: Sha;
};

export type WorkSelectionOptions = {
  /** When true, skip kinds with `WORK_KIND_ONE_SHOT_ELIGIBLE[kind] === false`. */
  oneShotOnly?: boolean;
};

function conflictSelectionOpts(currentMainHead?: Sha): { currentMainHead: Sha } | undefined {
  return currentMainHead ? { currentMainHead } : undefined;
}

/** Walk `workOrder` and return the first kind that has a unit of work. */
export function selectFirstWorkUnit(
  workOrder: readonly WorkKindName[],
  data: WorkSelectionData,
  opts?: WorkSelectionOptions,
): WorkUnit | null {
  const ctx: StackContext = {
    issueBodies: data.issueBodies,
    blockerStates: data.blockerStates,
  };
  for (const kind of workOrder) {
    if (opts?.oneShotOnly && !WORK_KIND_ONE_SHOT_ELIGIBLE[kind]) {
      continue;
    }
    if (kind === "conflicts") {
      const unit = selectConflictUnit(
        data.conflictingPrs,
        ctx,
        conflictSelectionOpts(data.currentMainHead),
      );
      if (unit) {
        return { kind: "conflicts", unit };
      }
    } else if (kind === "checks") {
      const unit = selectChecksUnit(data.failingCheckPrs, ctx);
      if (unit) {
        return { kind: "checks", unit };
      }
    } else if (kind === "reviews") {
      if (!data.phoebeLogin) {
        continue;
      }
      const unit = selectReviewsUnit(data.reviewActivityPrs, ctx, data.phoebeLogin);
      if (unit) {
        return { kind: "reviews", unit };
      }
    } else if (kind === "issues") {
      const unit = selectIssue(
        data.issues,
        data.blockerStates,
        data.phoebeBase,
        data.nativeBlockersByIssue,
      );
      if (unit) {
        return { kind: "issues", unit };
      }
    } else if (kind === "research") {
      // Research reuses the issues selection path (blocker + priority ordering)
      // against the researchLabel-tagged tickets gathered separately this cycle.
      const unit = selectIssue(
        data.researchIssues ?? [],
        data.blockerStates,
        data.phoebeBase,
        data.nativeBlockersByIssue,
      );
      if (unit) {
        return { kind: "research", unit };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Idle-cycle selection summaries
//
// These sit beside the selectors so main's idle logging asks "what did you skip,
// and why?" instead of rebuilding blocker maps and re-running every selector. The
// `unit` field is the same pick the live loop would make; the skip counts explain
// an idle cycle to the operator.
// ---------------------------------------------------------------------------

export type ConflictSelectionSummary = {
  unit: ConflictingPrCandidate | null;
  skippedStacked: number;
  skippedWatermark: number;
};

export function summarizeConflictSelection(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): ConflictSelectionSummary {
  const withoutWatermark = selectConflictFixCandidates(prs, ctx);
  const candidates = selectConflictFixCandidates(prs, ctx, opts);
  return {
    unit: pickOldestPr(candidates),
    skippedStacked: prs.length - withoutWatermark.length,
    skippedWatermark: withoutWatermark.length - candidates.length,
  };
}

export type ChecksSelectionSummary = {
  unit: ChecksCandidate | null;
  skipped: number;
};

export function summarizeChecksSelection(
  prs: readonly ChecksCandidate[],
  ctx: StackContext,
): ChecksSelectionSummary {
  const candidates = selectChecksCandidates(prs, ctx);
  return { unit: pickOldestPr(candidates), skipped: prs.length - candidates.length };
}

export type ReviewsSelectionSummary = {
  unit: ReviewsCandidate | null;
  skipped: number;
};

export function summarizeReviewsSelection(
  prs: readonly ReviewsCandidate[],
  ctx: StackContext,
  phoebeLogin: string,
): ReviewsSelectionSummary {
  const candidates = selectReviewsCandidates(prs, ctx, phoebeLogin);
  return { unit: pickOldestPr(candidates), skipped: prs.length - candidates.length };
}

/** Bound, marker-safe slug for a `UnitAttemptMarker.signature` (#25). */
export function slugifyFailureSignature(input: string, maxLen = 80): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLen) || "unknown";
}

/** Failure signature for a conflict unit that produced no commit (#25). */
export function conflictFailureSignature(opts: {
  mergeable?: string;
  mergeStateStatus?: string;
}): string {
  if (!opts.mergeable) {
    return "merge-setup-failed";
  }
  return slugifyFailureSignature(
    `mergeable-${opts.mergeable}${opts.mergeStateStatus ? `-${opts.mergeStateStatus}` : ""}`,
  );
}

/** Failure signature for a checks unit that produced no commit (#25). */
export function checksFailureSignature(failingChecks: readonly FailingCheck[]): string {
  if (failingChecks.length === 0) {
    return "checks-failed";
  }
  return slugifyFailureSignature(`checks-failed-${failingChecks.map((c) => c.name).join("-")}`);
}

/**
 * Failure signature for an issue/research unit that ran and produced no PR
 * (#22) — the verification command the agent's own report last failed on
 * (e.g. `apply_patch`), so the cause is visible on the issue without
 * container logs. Falls back to the agent's exit code, then a generic
 * marker when neither signal is available (a clean exit with no commits).
 */
export function issueAttemptFailureSignature(opts: {
  failedCommand?: string;
  agentExitCode: number | null;
}): string {
  if (opts.failedCommand) {
    return slugifyFailureSignature(`${opts.failedCommand}-failed`);
  }
  if (opts.agentExitCode !== null && opts.agentExitCode !== 0) {
    return slugifyFailureSignature(`agent-exit-${opts.agentExitCode}`);
  }
  return "no-commit-produced";
}

export function conflictFixFailureComment(
  prNumber: PrNumber,
  watermark?: ConflictFailWatermark,
): string {
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
 * After a sandbox conflict fix, the host may see 0 unpushed commits even when the sandbox
 * already pushed. Only post a failure comment when origin is unchanged and the PR still
 * conflicts.
 */
export function shouldPostConflictFixFailure(opts: {
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

export function checksFixFailureComment(
  prNumber: PrNumber,
  watermark?: ChecksFailWatermark,
): string {
  const parts = [
    `Phoebe attempted an idle CI fix for PR #${prNumber} but could not resolve the failing ` +
      `checks. The branch was left unchanged. A human should investigate the CI failures.`,
  ];
  if (watermark) {
    parts.push("", buildChecksFailWatermarkMarker(watermark));
  }
  return parts.join("\n");
}

/**
 * After a checks fix agent run, post a failure comment only when the agent made
 * no commits and did not push.
 */
export function shouldPostChecksFixFailure(opts: {
  hostCommitCount: number;
  originShaBefore: Sha;
  originShaAfter: Sha;
}): boolean {
  if (opts.hostCommitCount > 0) {
    return false;
  }
  return opts.originShaAfter === opts.originShaBefore;
}

export function formatFailingChecksForPrompt(checks: readonly FailingCheck[]): string {
  return checks.map((c) => `${c.name}: ${c.conclusion}`).join("\n");
}

export function buildInitialPrBody(opts: {
  issueNumber: number;
  commitCount: number;
  stacked?: { blockerIssueNumber: number; blockerPrNumber: PrNumber };
}): string {
  const parts = [`Closes #${opts.issueNumber}`, "", "Automated PR from Phoebe.", ""];
  if (opts.stacked) {
    parts.push(stackedPrComment(opts.stacked.blockerIssueNumber, opts.stacked.blockerPrNumber), "");
  }
  parts.push(`Commits: ${opts.commitCount}`);
  return parts.join("\n");
}

/** Incremental note for follow-up pushes — no stacked-PR banner. */
export function followUpPrComment(issueNumber: number, commitCount: number): string {
  return `Phoebe update for #${issueNumber}: ${commitCount} new commit(s) pushed to this branch.`;
}
