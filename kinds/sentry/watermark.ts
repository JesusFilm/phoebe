// The house watermark and the regression rule (#471). GitHub is the record:
// every issue the kind files carries an HTML marker naming the Sentry group,
// one search per cycle reads them all back across every state, and the
// linked issues' `state_reason` and `closed_at` decide whether a group is
// filed, skipped, or filed again as a regression. No database, no writes to
// Sentry.

/** The word the cycle's one GitHub search looks for. */
export const MARKER_TEXT = "phoebe-sentry";

const MARKER_RE = /<!--\s*phoebe-sentry\s+group=([^\s>]+)\s*-->/;

/** The marker a filed issue carries: `<!-- phoebe-sentry group=<id> -->`. */
export function renderMarker(groupId: string): string {
  return `<!-- ${MARKER_TEXT} group=${groupId} -->`;
}

/** The group id an issue body names, or null when it carries no marker. */
export function parseMarker(body: string): string | null {
  return MARKER_RE.exec(body)?.[1] ?? null;
}

/** One issue linked to a group, as the search returns it. */
export type FiledIssue = {
  number: number;
  state: "open" | "closed";
  /** GitHub's close reason; null while open or when GitHub sends none. */
  stateReason: "completed" | "not_planned" | "reopened" | "duplicate" | null;
  closedAt: string | null;
};

export type GroupDecision =
  | { action: "file"; regressionOf: number | null }
  | { action: "skip"; reason: string };

export const SKIP_ALREADY_FILED = "already filed";
export const SKIP_NOT_PLANNED = "closed as not planned";
export const SKIP_DUPLICATE = "closed as duplicate";
export const SKIP_AWAITING_RESOLUTION = "fixed, awaiting resolution";

/**
 * What to do with an unresolved group given the issues already linked to it.
 * An open issue anywhere means the group is spoken for. A close as not
 * planned is a person's decision and holds forever — it is also the one
 * suppression channel for noise (#472) — and a close as duplicate is the same
 * kind of decision pointing elsewhere. A close as completed is a fix: if the
 * group has been seen since, the fix did not hold and a **new** issue is
 * filed opening "Regression of #N"; if not, Sentry has not aged the group out
 * yet and the kind waits.
 */
export function decideGroup(filed: readonly FiledIssue[], lastSeen: string): GroupDecision {
  if (filed.length === 0) return { action: "file", regressionOf: null };
  if (filed.some((issue) => issue.state === "open")) {
    return { action: "skip", reason: SKIP_ALREADY_FILED };
  }
  if (filed.some((issue) => issue.stateReason === "not_planned")) {
    return { action: "skip", reason: SKIP_NOT_PLANNED };
  }
  // A close as duplicate is a person saying the crash lives on another issue;
  // that issue is the record now, and a new one here would duplicate it again.
  if (filed.some((issue) => issue.stateReason === "duplicate")) {
    return { action: "skip", reason: SKIP_DUPLICATE };
  }
  // Every linked issue is closed and none was a decision to drop it: the newest
  // close is the fix whose survival the group's last sighting judges.
  const newest = [...filed].sort(
    (a, b) => Date.parse(b.closedAt ?? "") - Date.parse(a.closedAt ?? ""),
  )[0]!;
  const closedAt = Date.parse(newest.closedAt ?? "");
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(closedAt) || Number.isNaN(seen) || seen <= closedAt) {
    return { action: "skip", reason: SKIP_AWAITING_RESOLUTION };
  }
  return { action: "file", regressionOf: newest.number };
}

/** The select order (#471): highest count first, then most recently seen. */
export function compareByLoudness(
  a: { count: number; lastSeen: string },
  b: { count: number; lastSeen: string },
): number {
  if (a.count !== b.count) return b.count - a.count;
  return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
}
