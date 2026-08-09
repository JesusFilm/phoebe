// Blockers and stacked-PR shape — the cross-kind pure logic for `blocked by`
// parsing, worktree-base resolution, and the native/banner stacked-PR
// machinery. Every function takes the config it needs as a parameter; no
// reads of the resolved-config.ts singleton happen in this module.

import { asBranchRef, type BranchRef, type PrNumber } from "./branded.ts";
import type { BlockerSource, StackMode } from "./config/index.ts";
import { parseIssueNumberFromBranch } from "./pr-scope.ts";

/** Native blocker issue numbers keyed by the blocked issue's number. */
export type NativeBlockerMap = ReadonlyMap<number, readonly number[]>;

export type Issue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  /** Absent from most fixtures — populated by `GitHub#issuesWithLabel` (#51 author scoping). */
  authorLogin?: string;
};

export type BlockerPrState = {
  hasOpenPr: boolean;
  openPrNumber?: PrNumber;
  hasMergedPr: boolean;
  mergedPrNumber?: PrNumber;
};

export type BaseResolution = {
  worktreeBase: string;
  stacked: boolean;
  blockerIssueNumber?: number;
  blockerPrNumber?: PrNumber;
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

/**
 * Parse blocker references from issue body text (and optional comments).
 * `pattern` is `config.blockedByPattern`; capture group 1 must yield the
 * blocker issue number.
 */
export function parseBlockedBy(pattern: string, ...texts: string[]): number[] {
  const blockers: number[] = [];
  const regex = new RegExp(pattern, "gi");
  for (const text of texts) {
    for (const match of text.matchAll(regex)) {
      blockers.push(Number(match[1]));
    }
  }
  return [...new Set(blockers)];
}

/**
 * Combine body-regex and native (issue-dependencies API) blocker numbers per
 * `source` (`config.blockerSource`), deduplicating while preserving first-seen
 * order (body refs before native ones under `both`). This is the single seam the
 * native-blocker source feeds through: every downstream stacking decision keeps
 * consuming a plain `number[]`, so only *where* the numbers come from changes.
 */
export function mergeBlockerNumbers(
  bodyBlockers: readonly number[],
  nativeBlockers: readonly number[],
  source: BlockerSource,
): number[] {
  const combined: number[] = [];
  if (source === "body" || source === "both") {
    combined.push(...bodyBlockers);
  }
  if (source === "native" || source === "both") {
    combined.push(...nativeBlockers);
  }
  return [...new Set(combined)];
}

/** The subset of blocker config every blocker-scanning function needs. */
export type BlockerConfig = {
  blockedByPattern: string;
  blockerSource: BlockerSource;
};

/** An issue's effective blockers: body refs merged with its native blockers. */
export function issueBlockers(
  issue: Issue,
  blockerConfig: BlockerConfig,
  nativeBlockers: readonly number[] = [],
): number[] {
  return mergeBlockerNumbers(
    parseBlockedBy(blockerConfig.blockedByPattern, issue.body),
    nativeBlockers,
    blockerConfig.blockerSource,
  );
}

export function issueBranch(branchPrefix: string, issueNumber: number): BranchRef {
  return asBranchRef(`${branchPrefix}issue-${issueNumber}`);
}

/** The subset of config `resolveWorktreeBase` needs beyond the blocker scan. */
export type StackConfig = BlockerConfig & {
  branchPrefix: string;
  stackMode: StackMode;
};

/**
 * Resolve the worktree base for an issue.
 * Returns `null` when the issue should be skipped this cycle (blocked with no
 * open/merged blocker PR).
 *
 * A diamond/multi-blocker issue (#13) must gate on *every* blocker, not just
 * the first: any blocker with no PR at all yet parks the issue, exactly as the
 * single-blocker case always has. Once every blocker has at least an open PR,
 * the issue is workable — stacked on whichever blocker is still unmerged
 * (the last one in blocker-list order, so a diamond re-bases forward as each
 * of its parents merges in turn) unless every blocker has already merged, in
 * which case the branch cuts off `main` same as an unblocked issue.
 */
export function resolveWorktreeBase(
  issue: Issue,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase: string | undefined,
  nativeBlockers: readonly number[],
  stackConfig: StackConfig,
): BaseResolution | null {
  if (phoebeBase) {
    return { worktreeBase: phoebeBase, stacked: false };
  }

  const blockers = issueBlockers(issue, stackConfig, nativeBlockers);
  if (blockers.length === 0) {
    return { worktreeBase: "origin/main", stacked: false };
  }

  let lastUnmergedBlocker: { issueNumber: number; state: BlockerPrState } | null = null;
  for (const blockerIssueNumber of blockers) {
    const state = blockerStates.get(blockerIssueNumber);
    if (!state) {
      return null;
    }
    if (state.hasMergedPr) {
      continue;
    }
    if (!state.hasOpenPr) {
      return null;
    }
    lastUnmergedBlocker = { issueNumber: blockerIssueNumber, state };
  }

  if (!lastUnmergedBlocker) {
    // Every blocker has merged.
    return { worktreeBase: "origin/main", stacked: false };
  }

  // `off` still honors every blocker for the skip decision above, but never
  // stacks: the branch is cut off main and no banner is added downstream.
  if (stackConfig.stackMode === "off") {
    return { worktreeBase: "origin/main", stacked: false };
  }

  // `banner` and `native` both cut the branch off the unmerged blocker's tip;
  // they diverge only in the PR base + banner, decided by `resolveStackedPrPlan`.
  return {
    worktreeBase: `origin/${issueBranch(stackConfig.branchPrefix, lastUnmergedBlocker.issueNumber)}`,
    stacked: true,
    blockerIssueNumber: lastUnmergedBlocker.issueNumber,
    blockerPrNumber: lastUnmergedBlocker.state.openPrNumber,
  };
}

export function stackedPrComment(blockerIssueNumber: number, blockerPrNumber: PrNumber): string {
  const issueRef = `#${blockerIssueNumber}`;
  return (
    `⛓️ Blocked by ${issueRef} (PR #${blockerPrNumber}). ` +
    `Its commits appear in this diff until #${blockerPrNumber} merges. ` +
    `**Do not merge this PR before #${blockerPrNumber}** — doing so would pull ` +
    `${issueRef}'s work into \`main\` ahead of its own review.`
  );
}

/**
 * Pure PR-shape decision for a freshly-pushed issue branch, given the resolved
 * base and the configured {@link StackMode}. Everything the impure PR-open step
 * needs — the `--base` branch, whether to add the stacked banner to the body,
 * and the `gh stack link` argv (or `null`) — is decided here so it can be unit
 * tested without shelling out to `gh`.
 *
 * The three modes:
 *  - not stacked (unblocked / merged blocker / `PHOEBE_BASE` / `off`): base is
 *    `defaultBranch`, no banner, no stack link. Byte-for-byte the historical
 *    behavior.
 *  - `banner`: base is `defaultBranch`, banner added, no stack link — today's
 *    behavior exactly.
 *  - `native`: base is the blocker's branch (`<branchPrefix>issue-<blocker>`),
 *    no banner, and a `gh stack link <predecessor> <successor>` argv registers
 *    the native GitHub stack (bottom-to-top). The PR is created first with
 *    Phoebe's own title/body, so `link` only corrects the base chain and never
 *    auto-generates a title over ours.
 */
export type StackedPrPlan = {
  /** The branch the PR is opened against (`gh pr create --base`). */
  prBase: string;
  /** Whether the stacked "do not merge before the blocker" banner is added. */
  includeBanner: boolean;
  /** The bottom-to-top branch pair to register as a native stack, or `null`. Argv-building is `GitHub#linkStack`'s job, not this module's. */
  stackLink: { predecessor: BranchRef; successor: BranchRef } | null;
};

export function resolveStackedPrPlan(opts: {
  issueNumber: number;
  resolution: Pick<BaseResolution, "stacked" | "blockerIssueNumber">;
  stackMode: StackMode;
  defaultBranch: string;
  branchPrefix: string;
}): StackedPrPlan {
  const notStacked: StackedPrPlan = {
    prBase: opts.defaultBranch,
    includeBanner: false,
    stackLink: null,
  };

  // `off` never reaches here stacked (resolveWorktreeBase collapses it), so an
  // unstacked resolution — or any non-native mode below — falls through to a
  // main-based, unbannered PR.
  if (!opts.resolution.stacked || opts.resolution.blockerIssueNumber === undefined) {
    return notStacked;
  }

  if (opts.stackMode === "native") {
    const predecessor = issueBranch(opts.branchPrefix, opts.resolution.blockerIssueNumber);
    const successor = issueBranch(opts.branchPrefix, opts.issueNumber);
    return {
      prBase: predecessor,
      includeBanner: false,
      // Bottom-to-top: the lower (blocker) branch first, then this run's branch.
      stackLink: { predecessor, successor },
    };
  }

  // `banner` (the only remaining stacked mode): base on main + add the banner.
  return { prBase: opts.defaultBranch, includeBanner: true, stackLink: null };
}

/**
 * Local git config the native-stack path pre-sets on the private clone so
 * `gh stack` / rebase operations run non-interactively — `remote.pushDefault`
 * removes the "which remote?" prompt when more than one exists, and
 * `rerere.enabled` lets cascade-rebases reuse recorded conflict resolutions.
 * Returned as `git` argv (sans the `git` program) so the impure caller runs
 * them against the clone directory. Only applied when `stackMode === 'native'`.
 */
export function nativeStackGitConfig(): readonly (readonly string[])[] {
  return [
    ["config", "remote.pushDefault", "origin"],
    ["config", "rerere.enabled", "true"],
  ];
}

/** `gh` argv (sans the `gh` program) that installs the gh-stack extension. */
export function ghStackExtensionInstallArgs(): readonly string[] {
  return ["extension", "install", "github/gh-stack"];
}

/**
 * Skip idle conflict/checks/reviews fix when the PR's issue is still stacked
 * on a blocker with an open PR — its divergence from `main` is expected, not
 * a real conflict/failure/discussion in need of a fix.
 */
export function shouldSkipStackedFix(
  issueBody: string,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  blockedByPattern: string,
): boolean {
  for (const blockerIssueNumber of parseBlockedBy(blockedByPattern, issueBody)) {
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
  blockedByPattern: string,
): PrNumber[] {
  const merged: PrNumber[] = [];
  for (const blockerIssueNumber of parseBlockedBy(blockedByPattern, issueBody)) {
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

export type StackRetargetCandidate = {
  prNumber: PrNumber;
  baseRefName: BranchRef;
};

/**
 * Open Phoebe PRs whose base is a native-stack blocker branch (#13) whose own
 * PR has since merged. GitHub only auto-retargets a PR onto its grandparent
 * when the base branch is *deleted*; tenant repos run
 * `delete_branch_on_merge=false`, so a merged blocker's branch survives and
 * nothing else ever moves its successor's base off it. `blockerStates` here is
 * keyed by the blocker issue number parsed straight out of each candidate's
 * `baseRefName` — the base branch name *is* the evidence of the native stack,
 * independent of `blocked by` body/native refs.
 */
export function selectStackRetargetCandidates<T extends StackRetargetCandidate>(
  prs: readonly T[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  branchPrefix: string,
): T[] {
  return prs.filter((pr) => {
    const blockerIssueNumber = parseIssueNumberFromBranch(pr.baseRefName, branchPrefix);
    if (blockerIssueNumber === null) {
      return false;
    }
    return blockerStates.get(blockerIssueNumber)?.hasMergedPr === true;
  });
}

/** Posted after a successor PR's base is moved from a merged blocker's branch to `defaultBranch` (#13). */
export function stackRetargetedComment(defaultBranch: string): string {
  return (
    `Blocker merged; this PR's base has been retargeted to \`${defaultBranch}\` ` +
    `so it can merge independently.`
  );
}

/**
 * Open issues that name `blockerIssueNumber` as a blocker (#22) — the
 * dependents a quarantine comment names as "stays blocked", so the stalled
 * chain is visible without walking the graph by hand.
 */
export function findBlockedDependents(
  blockerIssueNumber: number,
  issues: readonly Issue[],
  blockerConfig: BlockerConfig,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): number[] {
  return issues
    .filter(
      (issue) =>
        issue.number !== blockerIssueNumber &&
        issueBlockers(issue, blockerConfig, nativeBlockersByIssue.get(issue.number) ?? []).includes(
          blockerIssueNumber,
        ),
    )
    .map((issue) => issue.number);
}
