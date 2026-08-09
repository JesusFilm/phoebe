// PR scoping and branch parsing — the cross-kind rules that decide which open
// PRs Phoebe considers for conflicts/checks/reviews scanning, and how a
// `<branchPrefix>issue-<n>` branch name maps back to an issue number.

import type { BranchRef } from "./branded.ts";
import { PHOEBE_QUARANTINE_LABEL } from "./quarantine.ts";

export type PrScopeConfig = {
  branchPrefix: string;
  prScope: "phoebe" | "all";
  prAuthors: readonly string[];
  draftPrs: "skip-non-phoebe" | "skip-all" | "include";
  prOptOutLabel: string;
};

export type PrScanFields = {
  headRefName: BranchRef;
  authorLogin: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  labels: readonly string[];
};

/** Whether an open PR is eligible for conflicts/checks/reviews scanning. */
export function isPrInScope(pr: PrScanFields, scopeConfig: PrScopeConfig): boolean {
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
  if (
    scopeConfig.prAuthors.length > 0 &&
    !scopeConfig.prAuthors.some((author) => author.toLowerCase() === pr.authorLogin.toLowerCase())
  ) {
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

export function isPhoebeHeadBranch(branch: BranchRef, branchPrefix: string): boolean {
  return branch.startsWith(branchPrefix);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Memoized on `branchPrefix` rather than rebuilt on every call — call sites
// pass the same handful of prefix values (usually just one) over and over.
const issueBranchRePool = new Map<string, RegExp>();

function issueBranchRegex(branchPrefix: string): RegExp {
  let re = issueBranchRePool.get(branchPrefix);
  if (!re) {
    re = new RegExp(`^${escapeRegExp(branchPrefix)}issue-(\\d+)$`);
    issueBranchRePool.set(branchPrefix, re);
  }
  return re;
}

export function parseIssueNumberFromBranch(branch: BranchRef, branchPrefix: string): number | null {
  const match = issueBranchRegex(branchPrefix).exec(branch);
  return match ? Number(match[1]) : null;
}

/** GitHub may return UNKNOWN while mergeability is still computing. */
export function isPrMergeConflicting(mergeable: string, mergeStateStatus?: string): boolean {
  if (mergeable === "CONFLICTING") return true;
  if (mergeable === "UNKNOWN" && mergeStateStatus === "DIRTY") return true;
  return false;
}
