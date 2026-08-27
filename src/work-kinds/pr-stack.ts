// Shared fetch/select plumbing for the PR-keyed kinds: reading each
// candidate's issue body through the cycle cache (dropping candidates whose
// body cannot be read — a body the selectors cannot find would read as "not
// stacked"), and deriving the merged-blocker list a unit's run catches up on.

import {
  getMergedBlockerPrNumbers,
  parseIssueNumberFromBranch,
  type BlockerPrState,
} from "../orchestrator.ts";
import type { BranchRef, PrNumber } from "../branded.ts";
import type { WorkKindCtx } from "./definition.ts";

type PrCandidate = { issueNumber?: number; headRefName: BranchRef };

export function issueNumberOf(pr: PrCandidate): number | null {
  return pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
}

/**
 * Read every candidate's issue body through the cycle cache, dropping the
 * candidates whose body could not be read. The returned map holds exactly the
 * surviving candidates' bodies — the kind's select-time stack context.
 */
export function collectIssueBodies<T extends PrCandidate>(
  candidates: readonly T[],
  ctx: WorkKindCtx,
): { candidates: T[]; issueBodies: ReadonlyMap<number, string> } {
  const issueBodies = new Map<number, string>();
  const kept = candidates.filter((pr) => {
    const issueNumber = issueNumberOf(pr);
    if (issueNumber === null) return true;
    if (issueBodies.has(issueNumber)) return true;
    const body = ctx.cycle.issueBody(issueNumber);
    if (body === null) return false;
    issueBodies.set(issueNumber, body);
    return true;
  });
  return { candidates: kept, issueBodies };
}

/** The merged blocker PRs `pr` should catch up on before the default branch. */
export function mergedBlockersFor(
  pr: PrCandidate,
  issueBodies: ReadonlyMap<number, string>,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
): PrNumber[] {
  const issueNumber = issueNumberOf(pr);
  const body = issueNumber !== null ? (issueBodies.get(issueNumber) ?? "") : "";
  return getMergedBlockerPrNumbers(body, blockerStates);
}
