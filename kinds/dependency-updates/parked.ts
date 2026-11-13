// The dependency tickets the stranded sweep parked under `phoebe:blocked`
// (#862). When every bump in a bundle drops, the implementer opens no PR. It
// comments on the issue with the `## Dropped` section and the blocked marker,
// and the sweep swaps the claim for `phoebe:blocked` rather than re-arming the
// ticket until it is quarantined as unproductive.
//
// The detector reads those comments for two things:
//
//   - the failures. With no PR, the comment is the only record that the bumps
//     dropped, so each one counts toward the two-failure stop like a PR's;
//   - the way back. A ticket parked only because its releases were too new
//     needs nobody: the bumps pass once they age. A later scan that still
//     plans the bundle lifts the label, which bounds the retries to one per
//     scan. So does a scan that refreshes the bundle, because the run that
//     parked it worked a set of bumps the ticket no longer holds.

import { PHOEBE_BLOCKED_LABEL, hasBlockedMarker } from "../../src/blocked.ts";
import type { MentioningIssue } from "../../src/github-client.ts";
import type { WorkKindCtx } from "../../src/work-kinds/definition.ts";
import { parseDropped } from "../dependencies-work/dropped.ts";
import { bundleKey } from "../dependencies/fingerprint.ts";
import type { FilingAction } from "../dependencies/filing.ts";
import type { DroppedRecord } from "./plan.ts";

/**
 * A dependency ticket with Phoebe's comments on it, oldest first. `blocked` says
 * whether it wears `phoebe:blocked` now; its drop history counts either way.
 */
export type ParkedIssue = {
  number: number;
  open: boolean;
  blocked: boolean;
  comments: readonly string[];
};

/**
 * Every issue in `issues`, open or closed, with the comments Phoebe's own
 * login wrote. The history is read whether or not the ticket still wears
 * `phoebe:blocked`: a bundle that dropped everything opened no PR, so lifting
 * the label must not erase the only record of its failures. Only Phoebe's count, so a passer-by on a
 * public repo cannot pad a failure count or lift a label by pasting a section.
 * An issue whose comments cannot be read is logged and left out.
 */
export function readParked(
  issues: readonly MentioningIssue[],
  ctx: Pick<WorkKindCtx, "github" | "env" | "log">,
): ParkedIssue[] {
  if (issues.length === 0) return [];
  const login = ctx.github.resolveLogin(ctx.env["PHOEBE_GH_LOGIN"]);
  const read: ParkedIssue[] = [];
  for (const issue of issues) {
    try {
      const { comments } = ctx.github.issueTimeoutInputs(issue.number);
      read.push({
        number: issue.number,
        open: issue.state === "open",
        blocked: issue.labels.includes(PHOEBE_BLOCKED_LABEL),
        comments: comments.filter((c) => c.authorLogin === login).map((c) => c.body),
      });
    } catch (error) {
      ctx.log(
        `Could not read the comments on #${issue.number}; its drops are not counted ` +
          `this scan. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return read;
}

/** Each of Phoebe's comments on a parked issue, under the issue's number. */
export function parkedRecords(parked: readonly ParkedIssue[]): DroppedRecord[] {
  return parked.flatMap((issue) => issue.comments.map((body) => ({ number: issue.number, body })));
}

/** The bumps the newest comment with a `## Dropped` section listed, or none. */
function lastDropped(issue: ParkedIssue) {
  for (let i = issue.comments.length - 1; i >= 0; i--) {
    const body = issue.comments[i]!;
    const dropped = parseDropped(body);
    if (dropped.length > 0) return dropped;
    // A newer blocked run without drops ends the search: a person has to act (#817).
    if (hasBlockedMarker(body)) return [];
  }
  return [];
}

/**
 * Lift `phoebe:blocked` from each open parked ticket this scan still plans,
 * when the run that parked it dropped every bump and the ticket can pass with
 * nobody acting: either every drop was only too new, or the scan refreshed
 * the bundle. A ticket parked for any other reason keeps its label for a
 * person. A label that cannot be removed is logged; the next scan tries again.
 */
export function releaseParked(
  actions: readonly FilingAction[],
  parked: readonly ParkedIssue[],
  ctx: Pick<WorkKindCtx, "github" | "log">,
): number[] {
  const byNumber = new Map(parked.map((issue) => [issue.number, issue]));
  const released: number[] = [];
  for (const a of actions) {
    if (a.action !== "leave" && a.action !== "update") continue;
    const issue = byNumber.get(a.issue);
    if (issue === undefined || !issue.open || !issue.blocked) continue;
    const dropped = lastDropped(issue);
    if (dropped.length === 0) continue;
    const tooNew = dropped.every((bump) => bump.tooNew);
    if (a.action === "leave" && !tooNew) continue;
    const key = bundleKey(a.planned.bundle);
    try {
      ctx.github.removeIssueLabel(issue.number, PHOEBE_BLOCKED_LABEL);
      released.push(issue.number);
      ctx.log(
        `${key}: lifted ${PHOEBE_BLOCKED_LABEL} from #${issue.number}; ` +
          (a.action === "update"
            ? "the bundle it was parked on has moved."
            : "its bumps were only too new."),
      );
    } catch (error) {
      ctx.log(
        `${key}: could not lift ${PHOEBE_BLOCKED_LABEL} from #${issue.number}. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return released;
}
