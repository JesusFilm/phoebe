// Shared fetch/select plumbing for the PR-keyed kinds: walking the cycle's open
// PRs, reading each candidate's issue body through the cycle cache (dropping
// candidates whose body cannot be read — a body the selectors cannot find would
// read as "not stacked"), assembling the select-time stack context, deriving the
// merged-blocker list a unit's run catches up on, resolving the base branch its
// catch-up merges target, and taking the fresh origin snapshot a failure
// watermark is built from.

import {
  getMergedBlockerPrNumbers,
  parseIssueNumberFromBranch,
  type BlockerPrState,
  type StackContext,
} from "../orchestrator.ts";
import type { OpenPhoebePr, PrMergeInfo } from "../github-client.ts";
import type { BranchRef, PrNumber, Sha } from "../branded.ts";
import type { WorkKindCtx } from "./definition.ts";

type PrCandidate = { issueNumber?: number; headRefName: BranchRef };

/**
 * The branch a PR should be caught up with: its own base, falling back to the
 * default branch when the candidate does not carry one (#392).
 *
 * Before the feature arm every Phoebe PR was based on the default branch, so
 * the two answers coincided and the janitors hardcoded the default. A feature
 * member is based on `<branchPrefix>feature-<M>`, and merging the default
 * branch into it resolves a merge GitHub never reported while dragging in every
 * commit `main` has moved by.
 */
export function baseBranchOf(
  pr: { baseRefName?: BranchRef },
  ctx: { config: { defaultBranch: string } },
): string {
  return pr.baseRefName ?? ctx.config.defaultBranch;
}

/**
 * Walk this cycle's open PRs, resolving each one's merge info, and collect the
 * candidates `visit` builds — returning `null` for a PR this kind does not
 * want. A PR whose read throws is warned (naming `ctx.kind`) and dropped: one
 * unreadable PR must not sink the whole kind's fetch.
 */
export async function collectPrCandidates<T>(
  ctx: WorkKindCtx,
  visit: (info: PrMergeInfo, pr: OpenPhoebePr) => Promise<T | null> | T | null,
): Promise<T[]> {
  const collected: T[] = [];
  for (const pr of ctx.github.openPrs()) {
    try {
      const candidate = await visit(await ctx.github.mergeInfo(pr.number), pr);
      if (candidate !== null) collected.push(candidate);
    } catch (error) {
      ctx.log(
        `Skipping PR #${pr.number} this cycle — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return collected;
}

/**
 * The select-time stack context: the bodies this kind's fetch kept, paired with
 * the cycle's shared blocker states. Every PR-keyed select needs both.
 */
export function stackContextFor(
  gathered: { issueBodies: ReadonlyMap<number, string> },
  ctx: WorkKindCtx,
): StackContext {
  return { issueBodies: gathered.issueBodies, blockerStates: ctx.cycle.blockerStates() };
}

/**
 * Take a fresh origin snapshot and read the PR's head off it — the base every
 * failure watermark is built on. A caller needing a second head (the conflicts
 * watermark pins the default branch too) reads it from the same snapshot rather
 * than fetching again.
 */
export function freshPrHeadWatermark(ctx: WorkKindCtx, pr: PrCandidate): { prHead: Sha } {
  ctx.origin.fetch();
  return { prHead: ctx.origin.branchHead(pr.headRefName) };
}

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
