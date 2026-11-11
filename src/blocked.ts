// A run that stops because a person has to act (#817). An `issues` or `research`
// agent that cannot go on for a reason other than an open `Blocked by #N` blocker
// (a Question only a human can decide, a source it cannot reach, a map it cannot
// find) leaves a comment and no PR. Without this module the stranded-unit sweep
// reads that as a crashed run, hands the ticket back to the queue, and burns
// `maxUnproductiveRuns` more agent runs before quarantine says what the first
// run already said.
//
// The agent's half is one line in its comment, the `phoebe-blocked` marker the
// shipped prompts tell it to write. Agents still touch no labels. The engine's
// half is the sweep: when a stranded claim's newest Phoebe-authored marker is
// live, the sweep swaps the claim for `phoebe:blocked`, which selection skips,
// and posts a comment saying how to hand the ticket back. Removing the label is
// that hand-back, and nothing else clears it: a human answering the question is
// the event that matters, and only the human knows when they have.
//
// A marker is live until the engine's acknowledgement or an unproductive-run
// marker lands after it. Either one means the engine has already acted on the run
// that wrote it, so an old marker can never block a later run that said nothing.

import type { PhoebeLabel } from "./labels.ts";
import { parseUnitTimeoutMarker } from "./quarantine.ts";

/** Phoebe-owned label on a ticket whose run said it needs a human. */
export const PHOEBE_BLOCKED_LABEL = "phoebe:blocked";

/** The label as {@link addLabelCreatingIfMissing} creates it in a repo that lacks it. */
export const PHOEBE_BLOCKED: PhoebeLabel = {
  name: PHOEBE_BLOCKED_LABEL,
  description: "Phoebe stopped on this ticket — a human needs to act, then remove this label",
};

/** The line an agent writes in its blocked comment, on a line of its own. */
export const BLOCKED_MARKER = "<!-- phoebe-blocked -->";

// Anchored to the start of a line, like the quarantine markers, so a quoted copy
// of an old comment (`> <!-- phoebe-blocked -->`) is not read as a fresh one.
const BLOCKED_MARKER_RE = /^<!--\s*phoebe-blocked\s*-->/im;

const ACK_MARKER = "<!-- phoebe-blocked-ack -->";
const ACK_MARKER_RE = /^<!--\s*phoebe-blocked-ack\s*-->/im;

/**
 * Whether the ticket's latest run left a blocked marker the engine has not acted
 * on yet. `comments` come oldest-first, as `gh` returns them; the scan runs
 * newest-first and stops at the first acknowledgement or unproductive-run marker.
 * Only Phoebe's own comments count, so a passer-by on a public repo cannot
 * take a ticket out of the queue by pasting the marker.
 */
export function hasLiveBlockedMarker(
  comments: readonly { body: string; authorLogin: string | null }[],
  phoebeLogin: string,
): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    if (comment.authorLogin !== phoebeLogin) continue;
    if (ACK_MARKER_RE.test(comment.body)) return false;
    if (parseUnitTimeoutMarker(comment.body) !== null) return false;
    if (BLOCKED_MARKER_RE.test(comment.body)) return true;
  }
  return false;
}

/** The acknowledgement the sweep posts when it labels a ticket `phoebe:blocked`. */
export function buildBlockedComment(): string {
  return [
    `⏸️ Phoebe's last run on this ticket stopped because a person has to act, and ` +
      `its comment above says what it needs. Phoebe labelled the ticket ` +
      `\`${PHOEBE_BLOCKED_LABEL}\` and won't pick it up again while the label is on.`,
    "",
    `Once you have answered or fixed what the run asked about, remove the ` +
      `\`${PHOEBE_BLOCKED_LABEL}\` label and the ticket goes back in the queue.`,
    "",
    ACK_MARKER,
  ].join("\n");
}
