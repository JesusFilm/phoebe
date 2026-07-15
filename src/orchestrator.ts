// Pure selection + base-resolution logic for Phoebe's orchestrator.
// Kept separate from main.ts so it can be unit-tested without Docker/gh.

import { config } from "../phoebe.config.ts";

export type Issue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
};

export type BlockerPrState = {
  hasOpenPr: boolean;
  openPrNumber?: number;
  hasMergedPr: boolean;
  mergedPrNumber?: number;
};

export type BaseResolution = {
  worktreeBase: string;
  stacked: boolean;
  blockerIssueNumber?: number;
  blockerPrNumber?: number;
};

const PRIORITY_ORDER = ["bug", "tracer", "polish", "refactor"] as const;
export type Priority = (typeof PRIORITY_ORDER)[number];

/** Parse `Blocked by #N` lines from issue body text (and optional comments). */
export function parseBlockedBy(...texts: string[]): number[] {
  const blockers: number[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/Blocked by\s+#(\d+)/gi)) {
      blockers.push(Number(match[1]));
    }
  }
  return [...new Set(blockers)];
}

export function classifyPriority(issue: Issue): Priority {
  const text = `${issue.title} ${issue.body}`.toLowerCase();
  if (/\b(bug|broken|crash|regression|fix)\b/.test(text)) return "bug";
  if (/\b(tracer|wire\b|poc\b)/.test(text)) return "tracer";
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

export function issueBranch(issueNumber: number): string {
  return `${config.branchPrefix}issue-${issueNumber}`;
}

/**
 * Resolve the worktree base for an issue.
 * Returns `null` when the issue should be skipped this cycle (blocked with no
 * open/merged blocker PR).
 */
export function resolveWorktreeBase(
  issue: Issue,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
): BaseResolution | null {
  if (phoebeBase) {
    return { worktreeBase: phoebeBase, stacked: false };
  }

  const blockers = parseBlockedBy(issue.body);
  if (blockers.length === 0) {
    return { worktreeBase: "origin/main", stacked: false };
  }

  const blockerIssueNumber = blockers[0]!;
  const state = blockerStates.get(blockerIssueNumber);
  if (!state) {
    return null;
  }

  if (state.hasOpenPr) {
    return {
      worktreeBase: `origin/${issueBranch(blockerIssueNumber)}`,
      stacked: true,
      blockerIssueNumber,
      blockerPrNumber: state.openPrNumber,
    };
  }

  if (state.hasMergedPr) {
    return { worktreeBase: "origin/main", stacked: false };
  }

  return null;
}

/** Pick the highest-priority workable issue, or `null` when none qualify. */
export function selectIssue(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
): { issue: Issue; resolution: BaseResolution } | null {
  const sorted = [...issues].sort(compareIssues);
  for (const issue of sorted) {
    const resolution = resolveWorktreeBase(issue, blockerStates, phoebeBase);
    if (resolution) {
      return { issue, resolution };
    }
  }
  return null;
}

export function stackedPrComment(blockerIssueNumber: number, blockerPrNumber: number): string {
  return (
    `⛓️ Blocked by #${blockerIssueNumber} (PR #${blockerPrNumber}). ` +
    `Its commits appear in this diff until #${blockerPrNumber} merges. ` +
    `**Do not merge this PR before #${blockerPrNumber}** — doing so would pull ` +
    `#${blockerIssueNumber}'s work into \`main\` ahead of its own review.`
  );
}

export type ConflictingPrCandidate = {
  prNumber: number;
  headRefName: string;
  issueNumber?: number;
  headSha?: string;
  failureWatermark?: ConflictFailWatermark | null;
};

export type ConflictFailWatermark = {
  prHead: string;
  mainHead: string;
};

const CONFLICT_FAIL_WATERMARK_RE =
  /<!--\s*phoebe-conflict-fail:\s*prHead=([0-9a-f]+)\s+mainHead=([0-9a-f]+)\s*-->/i;

export function buildConflictFailWatermarkMarker(watermark: ConflictFailWatermark): string {
  return `<!-- phoebe-conflict-fail: prHead=${watermark.prHead} mainHead=${watermark.mainHead} -->`;
}

export function parseConflictFailWatermark(text: string): ConflictFailWatermark | null {
  const match = CONFLICT_FAIL_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { prHead: match[1]!, mainHead: match[2]! };
}

/** Latest marker wins when several failure comments exist on one PR. */
export function parseConflictFailWatermarkFromComments(
  comments: readonly string[],
): ConflictFailWatermark | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const watermark = parseConflictFailWatermark(comments[i]!);
    if (watermark) {
      return watermark;
    }
  }
  return null;
}

export function shouldSkipWatermarkConflictFix(opts: {
  watermark: ConflictFailWatermark | null;
  currentPrHead: string;
  currentMainHead: string;
}): boolean {
  if (!opts.watermark) {
    return false;
  }
  return (
    opts.watermark.prHead === opts.currentPrHead && opts.watermark.mainHead === opts.currentMainHead
  );
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ISSUE_BRANCH_RE = new RegExp(`^${escapeRegExp(config.branchPrefix)}issue-(\\d+)$`);

export function isPhoebeHeadBranch(branch: string): boolean {
  return branch.startsWith(config.branchPrefix);
}

export type PrScopeConfig = {
  branchPrefix: string;
  prScope: "phoebe" | "all";
  draftPrs: "skip-non-phoebe" | "skip-all" | "include";
  prOptOutLabel: string;
};

export type PrScanFields = {
  headRefName: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  labels: readonly string[];
};

const defaultPrScopeConfig = (): PrScopeConfig => ({
  branchPrefix: config.branchPrefix,
  prScope: config.prScope,
  draftPrs: config.draftPrs,
  prOptOutLabel: config.prOptOutLabel,
});

/** Whether an open PR is eligible for conflicts/checks/reviews scanning. */
export function isPrInScope(
  pr: PrScanFields,
  scopeConfig: PrScopeConfig = defaultPrScopeConfig(),
): boolean {
  if (pr.isCrossRepository) {
    return false;
  }
  if (pr.labels.includes(scopeConfig.prOptOutLabel)) {
    return false;
  }
  const isPhoebe = pr.headRefName.startsWith(scopeConfig.branchPrefix);
  if (scopeConfig.prScope === "phoebe" && !isPhoebe) {
    return false;
  }
  if (pr.isDraft) {
    if (scopeConfig.draftPrs === "skip-all") {
      return false;
    }
    if (scopeConfig.draftPrs === "skip-non-phoebe" && !isPhoebe) {
      return false;
    }
  }
  return true;
}

export function parseIssueNumberFromBranch(branch: string): number | null {
  const match = ISSUE_BRANCH_RE.exec(branch);
  return match ? Number(match[1]) : null;
}

/** GitHub may return UNKNOWN while mergeability is still computing. */
export function isPrMergeConflicting(mergeable: string, mergeStateStatus?: string): boolean {
  if (mergeable === "CONFLICTING") return true;
  if (mergeable === "UNKNOWN" && mergeStateStatus === "DIRTY") return true;
  return false;
}

/**
 * Skip idle conflict-fix when the PR's issue is still stacked on a blocker with
 * an open PR — its divergence from `main` is expected, not a real conflict.
 */
export function shouldSkipStackedConflictFix(
  issueBody: string,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
): boolean {
  for (const blockerIssueNumber of parseBlockedBy(issueBody)) {
    const state = blockerStates.get(blockerIssueNumber);
    if (state?.hasOpenPr) {
      return true;
    }
  }
  return false;
}

/** Merged blocker PR numbers for lazy catch-up (bottom-up stack order). */
export function getMergedBlockerPrNumbers(
  issueBody: string,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
): number[] {
  const merged: number[] = [];
  for (const blockerIssueNumber of parseBlockedBy(issueBody)) {
    const state = blockerStates.get(blockerIssueNumber);
    if (state?.hasMergedPr && state.mergedPrNumber !== undefined) {
      merged.push(state.mergedPrNumber);
    }
  }
  return merged;
}

export function stackedCatchUpRetractionComment(blockerPrNumbers: readonly number[]): string {
  if (blockerPrNumbers.length === 1) {
    return (
      `Blocker #${blockerPrNumbers[0]} merged; this branch has been caught up to \`main\` ` +
      `and is now independently mergeable.`
    );
  }
  const list = blockerPrNumbers.map((n) => `#${n}`).join(", ");
  return (
    `Blockers ${list} merged; this branch has been caught up to \`main\` ` +
    `and is now independently mergeable.`
  );
}

export function selectConflictFixCandidates(
  prs: readonly ConflictingPrCandidate[],
  issueBodies: ReadonlyMap<number, string>,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  opts?: { currentMainHead: string },
): ConflictingPrCandidate[] {
  return prs.filter((pr) => {
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedConflictFix(body, blockerStates)) {
        return false;
      }
    }
    if (opts?.currentMainHead && pr.headSha) {
      if (
        shouldSkipWatermarkConflictFix({
          watermark: pr.failureWatermark ?? null,
          currentPrHead: pr.headSha,
          currentMainHead: opts.currentMainHead,
        })
      ) {
        return false;
      }
    }
    return true;
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
  prNumber: number;
  headRefName: string;
  issueNumber?: number;
  headSha?: string;
  mergeable: string;
  mergeStateStatus?: string;
  failingChecks: FailingCheck[];
  failureWatermark?: ChecksFailWatermark | null;
};

export type ChecksFailWatermark = {
  prHead: string;
};

const CHECKS_FAIL_WATERMARK_RE = /<!--\s*phoebe-checks-fail:\s*prHead=([0-9a-f]+)\s*-->/i;

export function buildChecksFailWatermarkMarker(watermark: ChecksFailWatermark): string {
  return `<!-- phoebe-checks-fail: prHead=${watermark.prHead} -->`;
}

export function parseChecksFailWatermark(text: string): ChecksFailWatermark | null {
  const match = CHECKS_FAIL_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { prHead: match[1]! };
}

export function parseChecksFailWatermarkFromComments(
  comments: readonly string[],
): ChecksFailWatermark | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const watermark = parseChecksFailWatermark(comments[i]!);
    if (watermark) {
      return watermark;
    }
  }
  return null;
}

export function shouldSkipWatermarkChecksFix(opts: {
  watermark: ChecksFailWatermark | null;
  currentPrHead: string;
}): boolean {
  if (!opts.watermark) {
    return false;
  }
  return opts.watermark.prHead === opts.currentPrHead;
}

/** Reuse stacked-blocker skip logic — stacked PR red CI is handled at blocker merge. */
export const shouldSkipStackedChecksFix = shouldSkipStackedConflictFix;

export function selectChecksCandidates(
  prs: readonly ChecksCandidate[],
  issueBodies: ReadonlyMap<number, string>,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
): ChecksCandidate[] {
  return prs.filter((pr) => {
    if (isPrMergeConflicting(pr.mergeable, pr.mergeStateStatus)) {
      return false;
    }
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedChecksFix(body, blockerStates)) {
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
  issueBodies: ReadonlyMap<number, string>,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
): ChecksCandidate | null {
  const candidates = selectChecksCandidates(prs, issueBodies, blockerStates);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((oldest, pr) => (pr.prNumber < oldest.prNumber ? pr : oldest));
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
  prNumber: number;
  headRefName: string;
  issueNumber?: number;
  authorLogin?: string;
  mergeable: string;
  mergeStateStatus?: string;
  threads: readonly ReviewThread[];
  handledWatermark?: ReviewsHandledWatermark | null;
};

export type ReviewsHandledWatermark = {
  latest: string;
};

const REVIEWS_HANDLED_WATERMARK_RE = /<!--\s*phoebe-reviews-handled:\s*latest=([^\s>]+)\s*-->/i;

export const REVIEW_SUMMARY_HEADING = "## Review feedback addressed";

export function buildReviewsHandledMarker(watermark: ReviewsHandledWatermark): string {
  return `<!-- phoebe-reviews-handled: latest=${watermark.latest} -->`;
}

export function parseReviewsHandledWatermark(text: string): ReviewsHandledWatermark | null {
  const match = REVIEWS_HANDLED_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { latest: match[1]! };
}

export function parseReviewsHandledWatermarkFromComments(
  comments: readonly string[],
): ReviewsHandledWatermark | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const watermark = parseReviewsHandledWatermark(comments[i]!);
    if (watermark) {
      return watermark;
    }
  }
  return null;
}

export function isReviewSummaryComment(body: string): boolean {
  return body.includes(REVIEW_SUMMARY_HEADING);
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

/** Reuse stacked-blocker skip logic — stacked PR review comments are often about blocker code. */
export const shouldSkipStackedReviewsFix = shouldSkipStackedConflictFix;

export function selectReviewsCandidates(
  prs: readonly ReviewsCandidate[],
  issueBodies: ReadonlyMap<number, string>,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeLogin: string,
): ReviewsCandidate[] {
  return prs.filter((pr) => {
    if (isPrMergeConflicting(pr.mergeable, pr.mergeStateStatus)) {
      return false;
    }
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedReviewsFix(body, blockerStates)) {
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
  issueBodies: ReadonlyMap<number, string>,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeLogin: string,
): ReviewsCandidate | null {
  const candidates = selectReviewsCandidates(prs, issueBodies, blockerStates, phoebeLogin);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((oldest, pr) => (pr.prNumber < oldest.prNumber ? pr : oldest));
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

export const WORK_KIND_NAMES = ["conflicts", "checks", "reviews", "issues"] as const;
export type WorkKindName = (typeof WORK_KIND_NAMES)[number];

/** Whether a work-kind may run under `--run-once`. Janitor kinds are persistent-mode only. */
export const WORK_KIND_ONE_SHOT_ELIGIBLE: Record<WorkKindName, boolean> = {
  conflicts: false,
  checks: false,
  reviews: false,
  issues: true,
};

export const RUN_ONCE_NOTHING_MESSAGE =
  "[phoebe] Nothing to do under --run-once (janitor kinds are persistent-mode only).";

export function oneShotWorkKinds(workOrder: readonly WorkKindName[]): readonly WorkKindName[] {
  return workOrder.filter((kind) => WORK_KIND_ONE_SHOT_ELIGIBLE[kind]);
}

/** Fail fast when `WORK_ORDER` is empty or names an unknown kind. */
export function validateWorkOrder(order: readonly string[]): readonly WorkKindName[] {
  if (order.length === 0) {
    throw new Error(
      "WORK_ORDER must not be empty. Include at least one of: conflicts, checks, reviews, issues.",
    );
  }
  const validated: WorkKindName[] = [];
  for (const kind of order) {
    if (!WORK_KIND_NAMES.includes(kind as WorkKindName)) {
      throw new Error(
        `Unknown work kind "${kind}" in WORK_ORDER. Use one of: ${WORK_KIND_NAMES.join(", ")}.`,
      );
    }
    validated.push(kind as WorkKindName);
  }
  return validated;
}

/** Pick the single conflict unit — oldest PR number among unblocked candidates. */
export function selectConflictUnit(
  prs: readonly ConflictingPrCandidate[],
  issueBodies: ReadonlyMap<number, string>,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  opts?: { currentMainHead: string },
): ConflictingPrCandidate | null {
  const candidates = selectConflictFixCandidates(prs, issueBodies, blockerStates, opts);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((oldest, pr) => (pr.prNumber < oldest.prNumber ? pr : oldest));
}

/** Oldest conflicting PR by number that is eligible for an idle conflict fix. */
export function selectConflictFixUnit(
  prs: readonly ConflictingPrCandidate[],
  issueBodies: ReadonlyMap<number, string>,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  opts?: { currentMainHead: string },
): ConflictingPrCandidate | null {
  return selectConflictUnit(prs, issueBodies, blockerStates, opts);
}

export type IssueWorkUnit = { issue: Issue; resolution: BaseResolution };

export type WorkUnit =
  | { kind: "conflicts"; unit: ConflictingPrCandidate }
  | { kind: "checks"; unit: ChecksCandidate }
  | { kind: "reviews"; unit: ReviewsCandidate }
  | { kind: "issues"; unit: IssueWorkUnit };

export type WorkSelectionData = {
  issues: readonly Issue[];
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  conflictingPrs: readonly ConflictingPrCandidate[];
  failingCheckPrs: readonly ChecksCandidate[];
  reviewActivityPrs: readonly ReviewsCandidate[];
  issueBodies: ReadonlyMap<number, string>;
  phoebeBase?: string;
  phoebeLogin?: string;
  currentMainHead?: string;
};

export type WorkSelectionOptions = {
  /** When true, skip kinds with `WORK_KIND_ONE_SHOT_ELIGIBLE[kind] === false`. */
  oneShotOnly?: boolean;
};

function conflictSelectionOpts(currentMainHead?: string): { currentMainHead: string } | undefined {
  return currentMainHead ? { currentMainHead } : undefined;
}

/** Walk `workOrder` and return the first kind that has a unit of work. */
export function selectFirstWorkUnit(
  workOrder: readonly WorkKindName[],
  data: WorkSelectionData,
  opts?: WorkSelectionOptions,
): WorkUnit | null {
  for (const kind of workOrder) {
    if (opts?.oneShotOnly && !WORK_KIND_ONE_SHOT_ELIGIBLE[kind]) {
      continue;
    }
    if (kind === "conflicts") {
      const unit = selectConflictUnit(
        data.conflictingPrs,
        data.issueBodies,
        data.blockerStates,
        conflictSelectionOpts(data.currentMainHead),
      );
      if (unit) {
        return { kind: "conflicts", unit };
      }
    } else if (kind === "checks") {
      const unit = selectChecksUnit(data.failingCheckPrs, data.issueBodies, data.blockerStates);
      if (unit) {
        return { kind: "checks", unit };
      }
    } else if (kind === "reviews") {
      if (!data.phoebeLogin) {
        continue;
      }
      const unit = selectReviewsUnit(
        data.reviewActivityPrs,
        data.issueBodies,
        data.blockerStates,
        data.phoebeLogin,
      );
      if (unit) {
        return { kind: "reviews", unit };
      }
    } else if (kind === "issues") {
      const unit = selectIssue(data.issues, data.blockerStates, data.phoebeBase);
      if (unit) {
        return { kind: "issues", unit };
      }
    }
  }
  return null;
}

export function conflictFixFailureComment(
  prNumber: number,
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
  originShaBefore: string;
  originShaAfter: string;
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

export function checksFixFailureComment(prNumber: number, watermark?: ChecksFailWatermark): string {
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
  originShaBefore: string;
  originShaAfter: string;
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
  stacked?: { blockerIssueNumber: number; blockerPrNumber: number };
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
