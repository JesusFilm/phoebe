// The integration PR's `Closes` section (#341, ticket #380): the honest record
// of which issues a feature branch has actually absorbed.
//
// GitHub only honours a closing keyword on a PR that targets the *default*
// branch, so a member PR merging into `<branchPrefix>feature-<M>` closes
// nothing, and the integration PR Phoebe opened carries no keywords of its own.
// Left alone, the whole set of member issues stays open until somebody closes a
// dozen tickets by hand. So Phoebe writes the keywords onto the one PR that does
// reach the default branch, and GitHub closes the set at the moment the work
// lands — not before.
//
// Two rules the shape here exists to keep:
//
//   • **On merge, not on open.** A member PR opened and then abandoned put no
//     work on the branch. Only merged members earn a line.
//   • **Only ever append, inside markers.** The sweep re-runs every cycle, so a
//     rebuild would fight a human editing the same body, and a short read of the
//     merged list would silently drop lines. Existing lines are never removed.

import type { BranchRef, PrNumber } from "./branded.ts";
import { parseIssueNumberFromBranch } from "./orchestrator.ts";

/** A member PR that merged into a feature branch, as the sweep reads it. */
export type MergedMemberPr = {
  number: PrNumber;
  headRefName: BranchRef;
};

export const CLOSES_SECTION_START = "<!-- phoebe:closes:start -->";
export const CLOSES_SECTION_END = "<!-- phoebe:closes:end -->";

/**
 * The note above the lines, so a human reading the integration PR knows who
 * owns the block and that editing inside it is a losing fight.
 */
const SECTION_NOTE =
  "Phoebe adds a line here as each member PR merges into this branch. " +
  "Edit around the block, not inside it.";

/**
 * The issue a merged member PR resolved, read from its head branch — or `null`
 * when the branch is not a Phoebe issue branch.
 *
 * The branch, not the PR body. Phoebe derives the branch from the issue it was
 * handed, so it cannot name an issue whose work is elsewhere; body prose can,
 * and a wrong line here closes an issue whose work never reached the feature.
 * The cost is that a human's own PR onto the feature branch earns no line —
 * they can write their own `Closes` outside the block, which the sweep leaves
 * alone.
 */
export function memberIssueNumber(pr: MergedMemberPr): number | null {
  return parseIssueNumberFromBranch(pr.headRefName);
}

/**
 * The issues `text` already carries a `Closes` line for, in the order they
 * appear. Trailing blanks count as part of the line — a human typing the two
 * spaces of a Markdown hard break onto `Closes #418` still means it, and a line
 * that fails to match here reads as unlisted, which is how the sweep would come
 * to write a second line for an issue the body already closes.
 */
function listedIssueNumbers(text: string): number[] {
  return [...text.matchAll(/^Closes #(\d+)[ \t\r]*$/gm)].map((match) => Number(match[1]));
}

function renderSection(issueNumbers: readonly number[]): string {
  const lines = issueNumbers.map((n) => `Closes #${n}`).join("\n");
  return [CLOSES_SECTION_START, "", SECTION_NOTE, "", lines, "", CLOSES_SECTION_END].join("\n");
}

/**
 * `body` with every issue in `issueNumbers` listed in the `Closes` block, or
 * `null` when the body already says it and there is nothing to write.
 *
 * Idempotent by construction: the answer is a function of what the body already
 * closes, so however many cycles run over the same merged members, each one gets
 * exactly one line. Phoebe's own lines always land between the markers, and
 * everything outside them is copied through untouched — including a `Closes`
 * line a human wrote there, which counts as said. Integration PR #430 carried
 * three such lines: the sweep cannot attribute a stacked member whose PR merged
 * into a blocker branch rather than the feature branch, so a human recorded them
 * below the block. Should the sweep later attribute one, a line inside the
 * markers would only repeat the body. Phoebe neither adopts the human's line nor
 * moves it.
 */
export function withClosesSection(
  body: string,
  issueNumbers: readonly number[],
): { body: string; added: readonly number[] } | null {
  const start = body.indexOf(CLOSES_SECTION_START);
  const end = body.indexOf(CLOSES_SECTION_END);
  const hasSection = start !== -1 && end > start;
  const listed = hasSection ? listedIssueNumbers(body.slice(start, end)) : [];
  const closed = listedIssueNumbers(body);
  const added = [...new Set(issueNumbers)].filter((n) => !closed.includes(n)).sort((a, b) => a - b);
  if (added.length === 0) {
    return null;
  }
  const section = renderSection([...listed, ...added]);
  if (hasSection) {
    const tail = body.slice(end + CLOSES_SECTION_END.length);
    return { body: body.slice(0, start) + section + tail, added };
  }
  const head = body.trim() ? `${body.trimEnd()}\n\n` : "";
  return { body: `${head}${section}\n`, added };
}
