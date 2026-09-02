// Pure selection + base-resolution logic for Phoebe's orchestrator.
// Kept separate from main.ts so it can be unit-tested without Docker/gh.

import { asBranchRef, asSha, type BranchRef, type PrNumber, type Sha } from "./branded.ts";
import { WORK_KIND_NAMES, type WorkKindName } from "./config-schema.ts";
import { config } from "./resolved-config.ts";
import { PHOEBE_QUARANTINE_LABEL } from "./quarantine.ts";
import type { Feature } from "./feature-branch.ts";

export type Issue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
};

export type BlockerPrState = {
  hasOpenPr: boolean;
  openPrNumber?: PrNumber;
  hasMergedPr: boolean;
  mergedPrNumber?: PrNumber;
  /**
   * Blocker issue is closed as `COMPLETED` — the work landed, whoever did it and
   * on whatever branch. Only fetched when both PR lookups miss, so it is
   * `undefined` whenever an open or merged Phoebe PR already answered the
   * question. `false` covers `NOT_PLANNED`, which does *not* satisfy the block.
   */
  blockerCompleted?: boolean;
};

export type BaseResolution = {
  worktreeBase: string;
  stacked: boolean;
  blockerIssueNumber?: number;
  blockerPrNumber?: PrNumber;
  /** Set when the issue belongs to a live feature; the branch and PR target it instead of the default. */
  featureIssueNumber?: number;
  featureIssueTitle?: string;
};

/**
 * The stack-aware context every candidate selector needs: issue bodies (to read
 * `blocked by` references) keyed by issue number, and the open/merged PR state of
 * each referenced blocker. Bundled so the three work-kind flows thread one value
 * instead of the same `(issueBodies, blockerStates)` pair.
 */
export type StackContext = {
  issueBodies: ReadonlyMap<number, string>;
  blockerStates: ReadonlyMap<number, BlockerPrState>;
};

const PRIORITY_ORDER = ["bug", "tracer", "polish", "refactor"] as const;
export type Priority = (typeof PRIORITY_ORDER)[number];

/**
 * Parse blocker references from issue body text (and optional comments).
 * The pattern is configurable via `config.blockedByPattern`; capture group 1
 * must yield the blocker issue number.
 */
export function parseBlockedBy(...texts: string[]): number[] {
  const blockers: number[] = [];
  const pattern = new RegExp(config.blockedByPattern, "gi");
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      blockers.push(Number(match[1]));
    }
  }
  return [...new Set(blockers)];
}

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

export function issueBranch(issueNumber: number): BranchRef {
  return asBranchRef(`${config.branchPrefix}issue-${issueNumber}`);
}

/**
 * How the engine answers "which live feature does this issue belong to?" —
 * `null` for an issue that belongs to none. Base resolution asks twice: once for
 * the issue, once for its blocker, because the two answers together decide
 * whether a dependency stacks or waits (#383).
 */
export type FeatureLookup = (issueNumber: number) => Feature | null;

/**
 * Resolve the worktree base for an issue.
 * Returns `null` when the issue should be skipped this cycle (blocked with no
 * usable blocker state, or blocked across a feature's boundary).
 *
 * Three arms after the `PHOEBE_BASE` escape hatch:
 *   1. Blocked → stacking arm, floored on the feature branch for a member (#383).
 *   2. Unblocked member of a live feature → feature branch arm (#379).
 *   3. Unblocked, no feature → default branch arm.
 */
export function resolveWorktreeBase(
  issue: Issue,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
  featureOf?: FeatureLookup,
): BaseResolution | null {
  if (phoebeBase) {
    return { worktreeBase: phoebeBase, stacked: false };
  }

  const feature = featureOf?.(issue.number) ?? null;

  // Where this issue starts when nothing is holding it: the feature branch for a
  // member (#379), the default branch for everyone else. Also where a member
  // lands once its blocker is done, since a resolved blocker leaves no stack to
  // join.
  const ownBase = (): BaseResolution =>
    feature
      ? {
          worktreeBase: `origin/${feature.branch}`,
          stacked: false,
          featureIssueNumber: feature.issueNumber,
          featureIssueTitle: feature.title,
        }
      : { worktreeBase: `origin/${config.defaultBranch}`, stacked: false };

  const blockers = parseBlockedBy(issue.body);
  if (blockers.length > 0) {
    const blockerIssueNumber = blockers[0]!;
    const state = blockerStates.get(blockerIssueNumber);
    if (!state) {
      return null;
    }
    const blockerFeature = featureOf?.(blockerIssueNumber) ?? null;

    // A dependency that crosses a feature's boundary cannot be stacked: the two
    // branches are bound for different places, so basing either on the other
    // would strand its work on the wrong side (#383). Both sides therefore wait
    // — the idle log names the blocker.
    if (feature?.issueNumber !== blockerFeature?.issueNumber) {
      // Unless the outside blocker is already done: its work is on the default
      // branch, and the catch-up (#382) carries it onto the feature branch. A
      // blocker *inside* a feature is never done in this sense — its work
      // reaches the default branch only when the whole feature does.
      if (blockerFeature === null && (state.hasMergedPr || state.blockerCompleted)) {
        return ownBase();
      }
      return null;
    }

    if (state.hasOpenPr) {
      return {
        worktreeBase: `origin/${issueBranch(blockerIssueNumber)}`,
        stacked: true,
        blockerIssueNumber,
        blockerPrNumber: state.openPrNumber,
        // Carried so the member's stack is floored on the feature branch rather
        // than the default one: the bottom layer is the blocker's PR, which
        // already targets the feature branch, and the fallback when the Stacks
        // API cannot express the stack must not retarget off it (#376).
        ...(feature
          ? { featureIssueNumber: feature.issueNumber, featureIssueTitle: feature.title }
          : {}),
      };
    }

    if (state.hasMergedPr) {
      return ownBase();
    }

    // Work that landed outside `branchPrefix` leaves no Phoebe PR to find; a
    // blocker issue closed as completed is the signal that it is done anyway.
    if (state.blockerCompleted) {
      return ownBase();
    }

    return null;
  }

  return ownBase();
}

/**
 * Does a blocker `gh issue view --json state,stateReason` payload mean "done"?
 * `CLOSED`/`COMPLETED` does; `NOT_PLANNED` (abandoned) leaves dependents on
 * unbuilt ground and does not.
 */
export function isCompletedBlockerIssue(view: {
  state: string;
  stateReason?: string | null;
}): boolean {
  return (
    view.state.toUpperCase() === "CLOSED" && (view.stateReason ?? "").toUpperCase() === "COMPLETED"
  );
}

/**
 * Blocker issue numbers that are holding back otherwise-eligible issues this
 * cycle, ascending. Names in the idle log what the bare skip count cannot: a
 * blocker with no Phoebe PR looks identical to one nobody has started.
 *
 * Reports the same blocker `resolveWorktreeBase` gated on — the first — so the
 * log never names a blocker that is not actually what is holding the issue.
 * `featureOf` is passed through for the same reason: without it a member waiting
 * across its feature's boundary (#383) reads as workable here and its blocker
 * goes unnamed.
 */
export function unresolvedBlockerNumbers(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
  processingLabel?: string,
  featureOf?: FeatureLookup,
): number[] {
  const waiting = new Set<number>();
  for (const issue of issues) {
    if (issue.labels.includes(PHOEBE_QUARANTINE_LABEL)) continue;
    if (processingLabel && issue.labels.includes(processingLabel)) continue;
    if (resolveWorktreeBase(issue, blockerStates, phoebeBase, featureOf)) continue;
    const gating = parseBlockedBy(issue.body)[0];
    if (gating !== undefined) {
      waiting.add(gating);
    }
  }
  return [...waiting].sort((a, b) => a - b);
}

/** Pick the highest-priority workable issue, or `null` when none qualify. */
export function selectIssue(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
  processingLabel?: string,
  resolveFeatureFor?: FeatureLookup,
): { issue: Issue; resolution: BaseResolution } | null {
  // Quarantined issues/research tickets (#75) are skipped for work until a human
  // clears the label or the issue is edited (the auto-un-stick sweep).
  // Already-claimed issues (carrying processingLabel) are skipped so the engine
  // never double-picks an issue that another run is already working (#365).
  const eligible = issues.filter(
    (issue) =>
      !issue.labels.includes(PHOEBE_QUARANTINE_LABEL) &&
      (!processingLabel || !issue.labels.includes(processingLabel)),
  );
  const sorted = [...eligible].sort(compareIssues);
  for (const issue of sorted) {
    const resolution = resolveWorktreeBase(issue, blockerStates, phoebeBase, resolveFeatureFor);
    if (resolution) {
      return { issue, resolution };
    }
  }
  return null;
}

/** The blocker a stacked PR sits on: the blocking issue and its open PR. */
export type StackedOn = { blockerIssueNumber: number; blockerPrNumber: PrNumber };

/**
 * The ⛓️ do-not-merge banner, used when native stacking is unavailable.
 * `mergesInto` names where merging early would land the blocker's work — the
 * default branch for an ordinary PR, the feature branch for a member (#383).
 */
export function stackedPrComment(
  blockerIssueNumber: number,
  blockerPrNumber: PrNumber,
  mergesInto: string = config.defaultBranch,
): string {
  return (
    `⛓️ Blocked by #${blockerIssueNumber} (PR #${blockerPrNumber}). ` +
    `Its commits appear in this diff until #${blockerPrNumber} merges. ` +
    `**Do not merge this PR before #${blockerPrNumber}** — doing so would pull ` +
    `#${blockerIssueNumber}'s work into \`${mergesInto}\` ahead of its own review.`
  );
}

export type ConflictingPrCandidate = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  issueNumber?: number;
  headSha?: Sha;
  failureWatermark?: ConflictFailWatermark | null;
};

export type ConflictFailWatermark = {
  prHead: Sha;
  mainHead: Sha;
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
  return { prHead: asSha(match[1]!), mainHead: asSha(match[2]!) };
}

/**
 * Scan comment bodies newest-first and return the first marker `parse` extracts,
 * or `null` when none match. Shared by every work kind's watermark lookup — the
 * latest marker wins when several exist on one PR.
 */
export function parseLatestMarker<T>(
  bodies: readonly string[],
  parse: (text: string) => T | null,
): T | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const parsed = parse(bodies[i]!);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Built per call rather than once at module load: `config` is installed by the
 * CLI *after* this module is imported (src/cli.ts imports the engine
 * statically), so reading `branchPrefix` at import time would throw before the
 * install ever happened.
 */
const issueBranchRe = (): RegExp =>
  new RegExp(`^${escapeRegExp(config.branchPrefix)}issue-(\\d+)$`);

export function isPhoebeHeadBranch(branch: BranchRef): boolean {
  return branch.startsWith(config.branchPrefix);
}

export type PrScopeConfig = {
  branchPrefix: string;
  prScope: "phoebe" | "all";
  draftPrs: "skip-non-phoebe" | "skip-all" | "include";
  prOptOutLabel: string;
};

export type PrScanFields = {
  headRefName: BranchRef;
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
  // Poison-unit quarantine (#75): a unit that timed out K times is labelled and
  // skipped for *work* (still inspected for auto-un-stick elsewhere). Reuses the
  // existing opt-out filter mechanism; the label is a Phoebe-owned constant.
  if (pr.labels.includes(PHOEBE_QUARANTINE_LABEL)) {
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

export function parseIssueNumberFromBranch(branch: BranchRef): number | null {
  const match = issueBranchRe().exec(branch);
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
): PrNumber[] {
  const merged: PrNumber[] = [];
  for (const blockerIssueNumber of parseBlockedBy(issueBody)) {
    const state = blockerStates.get(blockerIssueNumber);
    if (state?.hasMergedPr && state.mergedPrNumber !== undefined) {
      merged.push(state.mergedPrNumber);
    }
  }
  return merged;
}

export function stackedCatchUpRetractionComment(blockerPrNumbers: readonly PrNumber[]): string {
  if (blockerPrNumbers.length === 1) {
    return (
      `Blocker #${blockerPrNumbers[0]} merged; this branch has been caught up to \`${config.defaultBranch}\` ` +
      `and is now independently mergeable.`
    );
  }
  const list = blockerPrNumbers.map((n) => `#${n}`).join(", ");
  return (
    `Blockers ${list} merged; this branch has been caught up to \`${config.defaultBranch}\` ` +
    `and is now independently mergeable.`
  );
}

/** Oldest PR (lowest number) among candidates, or `null` when the list is empty. */
export function pickOldestPr<T extends { prNumber: number }>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((oldest, pr) => (pr.prNumber < oldest.prNumber ? pr : oldest));
}

/**
 * The conflicting PRs worth fixing, and a count for each rule that turned one
 * away. Both come out of the same walk: the counts used to be backed out by
 * running the filter twice and subtracting, which is a second selector — and a
 * second selector is a second answer to "what would run this cycle?".
 */
export function partitionConflictFixCandidates(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): { candidates: ConflictingPrCandidate[]; stacked: number; watermarked: number } {
  const candidates: ConflictingPrCandidate[] = [];
  let stacked = 0;
  let watermarked = 0;
  for (const pr of prs) {
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = ctx.issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedConflictFix(body, ctx.blockerStates)) {
        stacked++;
        continue;
      }
    }
    if (
      opts?.currentMainHead &&
      pr.headSha &&
      shouldSkipWatermarkConflictFix({
        watermark: pr.failureWatermark ?? null,
        currentPrHead: pr.headSha,
        currentMainHead: opts.currentMainHead,
      })
    ) {
      watermarked++;
      continue;
    }
    candidates.push(pr);
  }
  return { candidates, stacked, watermarked };
}

/**
 * Just the candidates, for callers with no use for the counts. Conflicts is the
 * one kind whose filter has to be a partition rather than a `filter` — it is the
 * only one that reports two skip rules apart — so this is the projection that
 * puts it back in line with `selectChecksCandidates` and `selectReviewsCandidates`.
 */
export function selectConflictFixCandidates(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): ConflictingPrCandidate[] {
  return partitionConflictFixCandidates(prs, ctx, opts).candidates;
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
  issueNumber?: number;
  headSha?: Sha;
  mergeable: string;
  mergeStateStatus?: string;
  failingChecks: FailingCheck[];
  failureWatermark?: ChecksFailWatermark | null;
};

export type ChecksFailWatermark = {
  prHead: Sha;
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
  return { prHead: asSha(match[1]!) };
}

export function shouldSkipWatermarkChecksFix(opts: {
  watermark: ChecksFailWatermark | null;
  currentPrHead: Sha;
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
  ctx: StackContext,
): ChecksCandidate[] {
  return prs.filter((pr) => {
    if (isPrMergeConflicting(pr.mergeable, pr.mergeStateStatus)) {
      return false;
    }
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = ctx.issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedChecksFix(body, ctx.blockerStates)) {
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

export type ReviewThreadComment = {
  createdAt: string;
  /** `null` when the comment has no author — a deleted account, so never Phoebe. */
  authorLogin: string | null;
};

export type ReviewThread = {
  isResolved: boolean;
  isOutdated: boolean;
  comments: readonly ReviewThreadComment[];
};

export type ReviewsCandidate = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  issueNumber?: number;
  /** The PR's own author, or `null` when it has none. */
  authorLogin?: string | null;
  mergeable: string;
  mergeStateStatus?: string;
  threads: readonly ReviewThread[];
  handledWatermark?: ReviewsHandledWatermark | null;
};

export type ReviewsHandledWatermark = {
  latest: string;
};

const REVIEWS_HANDLED_WATERMARK_RE = /<!--\s*phoebe-reviews-handled:\s*latest=([^\s>]+)\s*-->/i;

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
  authorLogin?: string | null;
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
      // `authorLogin` and the comment's are both nullable, and two missing
      // authors are two different nobodies — a ghost reviewer's comment on a
      // ghost-authored PR is still feedback someone left.
      if (opts.authorLogin != null && comment.authorLogin === opts.authorLogin) {
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
  ctx: StackContext,
  phoebeLogin: string,
): ReviewsCandidate[] {
  return prs.filter((pr) => {
    if (isPrMergeConflicting(pr.mergeable, pr.mergeStateStatus)) {
      return false;
    }
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = ctx.issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedReviewsFix(body, ctx.blockerStates)) {
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

// The closed set lives in config-schema.ts (the `workKinds` field is keyed by
// it, #300); re-exported here because the orchestrator is its historical home
// and the module the engine reads it from. Since #303 it names only the five
// *built-in* kinds — the registry (src/work-kinds/registry.ts) is the full,
// per-tenant set.
export { WORK_KIND_NAMES, type WorkKindName };

export const RUN_ONCE_NOTHING_MESSAGE =
  "[phoebe] Nothing to do under --run-once (janitor kinds are persistent-mode only).";

/**
 * Fail fast when `WORK_ORDER` is empty or names a kind outside `legalKinds` —
 * this tenant's registry names: the built-ins plus whatever custom kinds it
 * declared (#350). The registry must therefore already be assembled wherever
 * this runs.
 */
export function validateWorkOrder(
  order: readonly string[],
  legalKinds: readonly string[],
): readonly string[] {
  if (order.length === 0) {
    throw new Error(
      `WORK_ORDER must not be empty. Include at least one of: ${legalKinds.join(", ")}.`,
    );
  }
  for (const kind of order) {
    if (!legalKinds.includes(kind)) {
      throw new Error(
        `Unknown work kind "${kind}" in WORK_ORDER. Use one of: ${legalKinds.join(", ")}.`,
      );
    }
  }
  return order;
}

export function conflictFixFailureComment(
  prNumber: PrNumber,
  watermark?: ConflictFailWatermark,
): string {
  const parts = [
    `Phoebe attempted an idle merge-conflict fix (merge \`origin/${config.defaultBranch}\` into this branch) ` +
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
  stacked?: StackedOn;
}): string {
  const parts = [`Closes #${opts.issueNumber}`, "", "Automated PR from Phoebe.", ""];
  // A neutral note only: whether the do-not-merge warning applies is decided
  // after creation (native stacking may take the ordering problem over), so the
  // warning travels as a comment on the fallback path, never in the body.
  if (opts.stacked) {
    parts.push(
      `Stacked on PR #${opts.stacked.blockerPrNumber} (blocked by #${opts.stacked.blockerIssueNumber}).`,
      "",
    );
  }
  parts.push(`Commits: ${opts.commitCount}`);
  return parts.join("\n");
}

/** Incremental note for follow-up pushes — no stacked-PR banner. */
export function followUpPrComment(issueNumber: number, commitCount: number): string {
  return `Phoebe update for #${issueNumber}: ${commitCount} new commit(s) pushed to this branch.`;
}
