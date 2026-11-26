// The observer's record is GitHub (#934): every proposal carries a marker
// naming its finding's key, one search across every state reads them all back,
// and the rules here decide whether a finding is filed, folded into the open
// proposal as a comment, or left alone. No database, nothing in memory.

/** The word the run's one GitHub search looks for. */
export const MARKER_TEXT = "phoebe-observer";

const FINDING_RE = /<!--\s*phoebe-observer\s+finding=([^\s>]+)\s*-->/;
const UNITS_RE = /<!--\s*phoebe-observer\s+units=([0-9a-f,]*)\s*-->/g;

/** How long a proposal a person turned down keeps its finding quiet. */
export const REJECTION_QUIET_MS = 90 * 24 * 3_600_000;

/** `<!-- phoebe-observer finding=<category>:<target> -->`, in a proposal's body. */
export function renderFindingMarker(key: string): string {
  return `<!-- ${MARKER_TEXT} finding=${key} -->`;
}

/** The finding key a body names, or null when it carries no marker. */
export function parseFindingMarker(body: string): string | null {
  return FINDING_RE.exec(body)?.[1] ?? null;
}

/** The units a proposal or one of its comments lists, as a hidden line. */
export function renderUnitsMarker(keys: readonly string[]): string {
  return `<!-- ${MARKER_TEXT} units=${keys.join(",")} -->`;
}

/** Every unit key listed across these texts: a proposal's body and its comments. */
export function listedUnitKeys(texts: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(UNITS_RE)) {
      for (const key of (match[1] ?? "").split(",")) if (key !== "") keys.add(key);
    }
  }
  return keys;
}

/** One issue the observer filed, as the search returns it. */
export type Proposal = {
  number: number;
  key: string;
  body: string;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "reopened" | "duplicate" | null;
  closedAt: string | null;
};

export type FindingDecision =
  | { action: "file"; regressionOf: { number: number; closedAt: string } | null }
  | { action: "fold"; into: Proposal }
  | { action: "skip"; reason: string };

export const SKIP_TURNED_DOWN = "turned down within 90 days";

/**
 * What to do with a finding, given every proposal filed under its key.
 *
 * - An open proposal is where new evidence goes: fold into it.
 * - Otherwise the newest proposal decides. Closed as completed means the fix
 *   was made, so a finding seen again is filed as a regression of it.
 * - Closed any other way (not planned, duplicate, or with no reason) is a
 *   person saying no, which keeps the key quiet for 90 days. A close date that
 *   will not parse is read as recent, so a doubt never files.
 */
export function decideFinding(proposals: readonly Proposal[], now: Date): FindingDecision {
  if (proposals.length === 0) return { action: "file", regressionOf: null };
  const byNewest = [...proposals].sort((a, b) => b.number - a.number);
  const open = byNewest.find((proposal) => proposal.state === "open");
  if (open !== undefined) return { action: "fold", into: open };
  const newest = byNewest[0]!;
  if (newest.stateReason === "completed" && newest.closedAt !== null) {
    return { action: "file", regressionOf: { number: newest.number, closedAt: newest.closedAt } };
  }
  const closedAt = Date.parse(newest.closedAt ?? "");
  if (Number.isNaN(closedAt) || now.getTime() - closedAt < REJECTION_QUIET_MS) {
    return { action: "skip", reason: `${SKIP_TURNED_DOWN} (#${newest.number})` };
  }
  return { action: "file", regressionOf: null };
}
