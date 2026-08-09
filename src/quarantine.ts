// Poison-unit repeat protection — one façade over three write paths that used
// to diverge by accident (#68, decided in #45). #72's timeout keeps a hung
// unit from starving the fleet, but not a unit that hangs *every* rotation
// (#75); #25 generalises the same label/comment/baseline machinery to PR-keyed
// units that fail fast with no commit; #22 is the issue-keyed sibling (a
// claim→release cycle that produces no PR). All three count consecutive
// failures per `(kind, id, trigger)` and, at `k`, apply `phoebe:quarantined` +
// one escalation comment so a human takes over. State lives entirely on
// GitHub (this module's marker + the label), so it survives container/volume
// loss (#73) — the read/skip half lives beside each selector
// (`pr-scope.ts#isPrInScope`, `producer.ts#selectIssue`), both pure and both
// importable without this façade.
//
// `createQuarantine` is the one write entry point (`record`/`resolve`),
// constructed once per process alongside the other adapters (#53's `io`
// bundle) and passed into every kind. It owns the marker format, the
// try/catch-and-swallow around every GitHub write (a write failure while
// recording a failure must never take the daemon down), and the one tracking
// comment per `(kind, id)` — up to two `<!-- phoebe-unit:<kind>:<trigger> -->`
// sections, one per active trigger, edited in place and never reposted. The
// trigger tag (not just `kind`) is what keeps a timeout and a no-PR attempt on
// the same issue from colliding into one shared counter.
//
// `ref` is embedded in every marker as carried data (head SHA for PR-keyed
// units, the issue number for issue-keyed ones) — never the reset rule. Two
// counting rules survive the collapse, because they are not accidental:
// activity-based (`timed-out` — a foreign comment or push newer than the
// marker's own `at` means someone touched the hang since; comparing against
// the *marker's* timestamp rather than the comment's `createdAt` is what lets
// the counter live on an edited-in-place comment, since GitHub never bumps a
// comment's `createdAt` on edit) and progress-based (`no-commit`/`no-pr` — a
// moved `ref` resets automatically for PR-keyed units; an issue-keyed unit's
// `ref` never moves on its own, so its caller resets explicitly via
// `resolve()` the moment a run produces a PR).
//
// A quarantine a human clears by hand (removing the label) is invisible to a
// sweep that queries *by* label, so it is handled here, at record time, where
// the unit's comments are already fetched: an escalation section whose label
// is now absent means a human cleared it — that trigger's counter resets to 0
// before recording this new failure.

import { asPrNumber, type Sha } from "./branded.ts";
import type { GitHub } from "./github.ts";
import type { UnitRef } from "./kinds/kind.ts";

/** Phoebe-owned skip label — distinct from the user-supplied `prOptOutLabel`. */
export const PHOEBE_QUARANTINE_LABEL = "phoebe:quarantined";

export type UnitTrigger = "timed-out" | "no-commit" | "no-pr";

const ALL_TRIGGERS: readonly UnitTrigger[] = ["timed-out", "no-commit", "no-pr"];

/** One trigger's counter on a unit's tracking comment. `ref` and `sig` are always filled — never optional. */
export type UnitMarker = {
  trigger: UnitTrigger;
  n: number;
  /** Bound, marker-safe slug for what went wrong this attempt, e.g. `mergeable-conflicting`; `"timeout"` for `timed-out`. */
  signature: string;
  /** The unit's identity reference at this attempt — PR head SHA, or the issue number, as carried data. */
  ref: string;
  /** ISO timestamp of this attempt — the `timed-out` trigger's staleness clock. */
  at: string;
};

function unitMarkerRe(kind: string, trigger: UnitTrigger): RegExp {
  return new RegExp(
    `<!--\\s*phoebe-unit:${kind}:${trigger}\\s+n=(\\d+)\\s+sig=([a-z0-9-]+)\\s+ref=([A-Za-z0-9._:-]+)\\s+at=([0-9TZ:.+-]+)\\s*-->`,
    "i",
  );
}

function buildUnitMarker(kind: string, marker: UnitMarker): string {
  return `<!-- phoebe-unit:${kind}:${marker.trigger} n=${marker.n} sig=${marker.signature} ref=${marker.ref} at=${marker.at} -->`;
}

// --- Quarantine baseline marker (in the escalation section, for auto-unstick) -

const QUARANTINE_BASELINE_RE = /<!--\s*phoebe-quarantine-baseline:\s*([^\s>]+)\s*-->/i;

export function buildQuarantineBaselineMarker(baseline: string): string {
  return `<!-- phoebe-quarantine-baseline: ${baseline} -->`;
}

export function parseQuarantineBaseline(text: string): string | null {
  const match = QUARANTINE_BASELINE_RE.exec(text);
  return match ? match[1]! : null;
}

/**
 * The one escalation section posted at threshold: says the unit failed K
 * times and needs a human, and records the baseline (PR head SHA for
 * conflicts/checks; issue `updatedAt` for issues/research) so the auto-un-stick
 * sweep can tell when someone has actually changed the thing.
 */
export function buildQuarantineComment(opts: {
  kind: string;
  id: number;
  k: number;
  baseline: string;
  /** What kept happening, e.g. "timed out" (#75) or "produced no commit" (#25). */
  reason: string;
  /** Last observed failure detail (#25) — carried so the cause is visible without container logs. */
  signature?: string;
  /** Open issues blocked on this one (#22) — named so a stalled chain is visible without digging. */
  dependents?: readonly number[];
}): string {
  const detail = opts.signature ? ` Last failure: \`${opts.signature}\`.` : "";
  const dependentsLine =
    opts.dependents && opts.dependents.length > 0
      ? [
          "",
          `This also keeps ${opts.dependents.map((n) => `#${n}`).join(", ")} blocked until it's resolved.`,
        ]
      : [];
  return [
    `⚠️ Phoebe quarantined this unit: the \`${opts.kind}\` work on #${opts.id} ${opts.reason} ` +
      `${opts.k} times in a row without completing.${detail} It has been labelled ` +
      `\`${PHOEBE_QUARANTINE_LABEL}\` and skipped so it stops burning the run budget. ` +
      `A human should take a look.`,
    ...dependentsLine,
    "",
    `Remove the \`${PHOEBE_QUARANTINE_LABEL}\` label to retry, or push a fix / edit the ` +
      `issue — Phoebe auto-clears the label when the content advances past the baseline below.`,
    "",
    buildQuarantineBaselineMarker(opts.baseline),
  ].join("\n");
}

/**
 * Whether a quarantined unit should be auto-un-stuck: someone changed the thing
 * that hung. A PR unit clears when its head SHA advanced past baseline; an issue
 * unit clears when its `lastEditedAt` is newer than baseline. A bare human
 * comment (no content change) does not clear it — it can't silently re-arm a
 * unit no one has fixed.
 */
export function shouldAutoUnstick(opts: {
  baseline: string;
  currentHeadSha?: Sha;
  currentIssueEditedAt?: string;
}): boolean {
  if (opts.currentHeadSha !== undefined) {
    return opts.currentHeadSha !== opts.baseline;
  }
  if (opts.currentIssueEditedAt !== undefined) {
    return opts.currentIssueEditedAt > opts.baseline;
  }
  return false;
}

// --- The one tracking comment: up to two trigger-scoped sections -------------

type TrackingSection = { prose: string; marker: UnitMarker };
type TrackingSections = Partial<Record<UnitTrigger, TrackingSection>>;
type TrackingComment = { commentId: string | null; sections: TrackingSections };

function parseTrackingSections(kind: string, body: string): TrackingSections {
  const found: Array<{ trigger: UnitTrigger; marker: UnitMarker; start: number; end: number }> = [];
  for (const trigger of ALL_TRIGGERS) {
    const match = unitMarkerRe(kind, trigger).exec(body);
    if (match) {
      found.push({
        trigger,
        marker: {
          trigger,
          n: Number(match[1]),
          signature: match[2]!,
          ref: match[3]!,
          at: match[4]!,
        },
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const sections: TrackingSections = {};
  let cursor = 0;
  for (const f of found) {
    sections[f.trigger] = { prose: body.slice(cursor, f.start).trim(), marker: f.marker };
    cursor = f.end;
  }
  return sections;
}

/**
 * The unit's one tracking comment for `kind` (newest match wins), or `null`
 * comment id with empty sections when it has never failed. Scans newest-first
 * so a comment carrying stale markers under an older format can never shadow
 * a fresher one — moot today (#68's cutover is free, no deployed state uses
 * the old per-trigger comment formats) but keeps the scan direction correct.
 */
function findTrackingComment(
  comments: readonly { id: string; body: string }[],
  kind: string,
): TrackingComment {
  for (let i = comments.length - 1; i >= 0; i--) {
    const sections = parseTrackingSections(kind, comments[i]!.body);
    if (Object.keys(sections).length > 0) {
      return { commentId: comments[i]!.id, sections };
    }
  }
  return { commentId: null, sections: {} };
}

function serializeTrackingSections(sections: TrackingSections, kind: string): string {
  const parts: string[] = [];
  for (const trigger of ALL_TRIGGERS) {
    const section = sections[trigger];
    if (!section) continue;
    if (section.prose) parts.push(section.prose);
    parts.push(buildUnitMarker(kind, section.marker));
  }
  return parts.join("\n\n");
}

/**
 * The latest trigger-scoped marker on a unit's tracking comment, read-only —
 * the no-commit backoff filter's window into the counter (#25) without
 * reaching for the write-side façade.
 */
export function findLatestUnitAttemptComment(
  comments: readonly { id: string; body: string }[],
  kind: string,
  trigger: UnitTrigger,
): { marker: UnitMarker; commentId: string } | null {
  const { commentId, sections } = findTrackingComment(comments, kind);
  const section = sections[trigger];
  if (!commentId || !section) {
    return null;
  }
  return { marker: section.marker, commentId };
}

// --- No-commit / no-PR backoff (#25) ------------------------------------------

const DEFAULT_UNIT_BACKOFF_BASE_MS = 5 * 60_000;
const DEFAULT_UNIT_BACKOFF_CAP_MS = 60 * 60_000;

function unitBackoffMs(
  attemptCount: number,
  baseMs: number = DEFAULT_UNIT_BACKOFF_BASE_MS,
  capMs: number = DEFAULT_UNIT_BACKOFF_CAP_MS,
): number {
  if (attemptCount <= 0) {
    return 0;
  }
  return Math.min(baseMs * 2 ** (attemptCount - 1), capMs);
}

/**
 * Whether a unit that has already failed `attemptCount` times in a row should
 * skip dispatch this cycle — a transient failure (rate limit, 504) then gets a
 * growing gap before the next try instead of burning a full cycle every poll.
 */
function shouldBackoffUnitRetry(opts: {
  attemptCount: number;
  lastAttemptAt: string;
  now: string;
}): boolean {
  if (opts.attemptCount <= 0) {
    return false;
  }
  const elapsedMs = Date.parse(opts.now) - Date.parse(opts.lastAttemptAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return false;
  }
  return elapsedMs < unitBackoffMs(opts.attemptCount);
}

/**
 * Drop PR-keyed candidates that are inside their no-commit-attempt backoff
 * window (#25) — a transient failure (rate limit, 504) then recovers on its
 * own instead of burning a full agent cycle every poll while it's within the
 * growing gap between retries. A quarantined unit never reaches this filter:
 * it's already excluded upstream by the `PHOEBE_QUARANTINE_LABEL` scope check.
 */
export function filterBackoffEligible<T extends { attemptMarker?: UnitMarker | null }>(
  candidates: readonly T[],
  now: string,
): T[] {
  return candidates.filter((c) => {
    const marker = c.attemptMarker;
    if (!marker) {
      return true;
    }
    return !shouldBackoffUnitRetry({ attemptCount: marker.n, lastAttemptAt: marker.at, now });
  });
}

/** Bound, marker-safe slug for a `UnitMarker.signature`. */
export function slugifyFailureSignature(input: string, maxLen = 80): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLen) || "unknown";
}

// --- The façade ----------------------------------------------------------

/** Later of two optional ISO instants (`gh` returns them Z-normalized, so `>` is chronological). */
function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * The newest comment instant NOT authored by Phoebe, or `null`. This is the
 * `timed-out` trigger's reset signal: a human comment counts, but Phoebe's own
 * marker edits must not — otherwise every rotation's edit would look like
 * fresh activity and the count could never climb to K.
 */
function newestForeignCommentAt(
  comments: readonly { createdAt: string; authorLogin: string }[],
  phoebeLogin: string,
): string | null {
  let newest: string | null = null;
  for (const comment of comments) {
    if (comment.authorLogin === phoebeLogin) {
      continue;
    }
    if (newest === null || comment.createdAt > newest) {
      newest = comment.createdAt;
    }
  }
  return newest;
}

/**
 * The next count for one trigger. `timed-out` is activity-based: reset when
 * newer foreign activity (a comment or, for PR-keyed units, a push) exists
 * than the prior marker's own `at` — comparing against the marker's embedded
 * timestamp rather than the comment's `createdAt` is what survives the move
 * onto an edited-in-place comment. `no-commit`/`no-pr` are progress-based:
 * reset when `ref` has moved since the prior marker — automatic for PR-keyed
 * units (the head SHA changes on push); a no-op for issue-keyed units (the
 * issue number never moves), whose caller resets explicitly via `resolve()`.
 */
function nextCount(
  trigger: UnitTrigger,
  previous: UnitMarker | null,
  opts: {
    ref: string;
    comments: readonly { createdAt: string; authorLogin: string }[];
    phoebeLogin: string;
    extraActivityAt: string | null;
  },
): number {
  if (trigger === "timed-out") {
    const latestActivityAt = maxIso(
      newestForeignCommentAt(opts.comments, opts.phoebeLogin),
      opts.extraActivityAt,
    );
    const stale = previous !== null && latestActivityAt !== null && latestActivityAt > previous.at;
    return (stale ? 0 : (previous?.n ?? 0)) + 1;
  }
  const stale = previous === null || previous.ref !== opts.ref;
  return (stale ? 0 : previous!.n) + 1;
}

export type QuarantineDetail = {
  /** Bound, marker-safe slug for what went wrong this attempt, e.g. `mergeable-conflicting`. Ignored for `timed-out`. */
  signature: string;
  /** What kept happening, for the escalation comment: "timed out" / "produced no commit" / "was claimed and released with no PR". */
  reason: string;
  /**
   * Prose shown while below threshold — trigger/kind-specific wording the
   * caller owns. A function because the attempt count (`n`) and threshold
   * (`k`) are only known once the façade has read the unit's current state;
   * most callers ignore the arguments entirely.
   */
  belowThresholdNote(n: number, k: number): string;
  /** Open issues blocked on this one — the `no-pr` trigger's addition (#22). */
  dependents?: readonly number[];
};

export type Quarantine = {
  /** Fold one failure into the unit's `(kind, id, trigger)` counter; at threshold, label + escalate. Best-effort. */
  record(unit: UnitRef, trigger: UnitTrigger, detail: QuarantineDetail): void;
  /** Clear a trigger's counter on forward progress (e.g. an issue produced a PR) — `note` replaces its section. */
  resolve(unit: UnitRef, trigger: UnitTrigger, note: string): void;
};

type UnitActivity = {
  comments: readonly { id: string; body: string; createdAt: string; authorLogin: string }[];
  labels: readonly string[];
  ref: string;
  baseline: string;
  lastCommitAt: string | null;
};

/**
 * `createQuarantine({ github, config, log })` — the one write entry point for
 * all three quarantine triggers, built once per process alongside the other
 * adapters (#53) and passed into every kind's `io` bundle.
 */
export function createQuarantine(opts: {
  github: GitHub;
  config: { maxUnitTimeouts: number; maxUnitAttempts: number };
  log: (message: string) => void;
}): Quarantine {
  const { github, config, log } = opts;

  function fetchActivity(unit: UnitRef): UnitActivity {
    if (unit.target.type === "issue") {
      const activity = github.issueActivity(unit.target.number);
      return {
        comments: activity.comments,
        labels: activity.labels,
        ref: String(unit.target.number),
        baseline: activity.updatedAt,
        lastCommitAt: null,
      };
    }
    const activity = github.prActivity(asPrNumber(unit.target.number));
    return {
      comments: activity.comments,
      labels: activity.labels,
      ref: activity.headRefOid,
      baseline: activity.headRefOid,
      lastCommitAt: activity.lastCommitAt,
    };
  }

  function writeComment(unit: UnitRef, body: string): void {
    if (unit.target.type === "issue") {
      github.commentIssue(unit.target.number, body);
    } else {
      github.commentPr(asPrNumber(unit.target.number), body);
    }
  }

  function applyLabel(unit: UnitRef): void {
    if (unit.target.type === "issue") {
      github.labelIssue(unit.target.number, PHOEBE_QUARANTINE_LABEL);
    } else {
      github.labelPr(asPrNumber(unit.target.number), PHOEBE_QUARANTINE_LABEL);
    }
  }

  function record(unit: UnitRef, trigger: UnitTrigger, detail: QuarantineDetail): void {
    const { kind, target } = unit;
    const id = target.number;
    try {
      const activity = fetchActivity(unit);
      const tracking = findTrackingComment(activity.comments, kind);
      let previous = tracking.sections[trigger]?.marker ?? null;

      // The manual-clear reset (#68): a sweep that queries *by* label can
      // never see a unit a human unlabelled by hand, so it's handled here,
      // where the comments are already fetched — an escalation section whose
      // label is now absent means a human cleared it.
      const priorProse = tracking.sections[trigger]?.prose ?? "";
      if (previous && parseQuarantineBaseline(priorProse) !== null) {
        if (!activity.labels.includes(PHOEBE_QUARANTINE_LABEL)) {
          previous = null;
        }
      }

      const now = new Date().toISOString();
      const k = trigger === "timed-out" ? config.maxUnitTimeouts : config.maxUnitAttempts;
      const n = nextCount(trigger, previous, {
        ref: activity.ref,
        comments: activity.comments,
        phoebeLogin: github.login(),
        extraActivityAt: activity.lastCommitAt,
      });
      const quarantined = n >= k;
      const marker: UnitMarker = {
        trigger,
        n,
        signature: detail.signature,
        ref: activity.ref,
        at: now,
      };

      const prose = quarantined
        ? buildQuarantineComment({
            kind,
            id,
            k,
            baseline: activity.baseline,
            reason: detail.reason,
            ...(trigger === "timed-out" ? {} : { signature: detail.signature }),
            ...(detail.dependents ? { dependents: detail.dependents } : {}),
          })
        : detail.belowThresholdNote(n, k);

      const nextSections: TrackingSections = { ...tracking.sections, [trigger]: { prose, marker } };
      const body = serializeTrackingSections(nextSections, kind);
      if (tracking.commentId) {
        github.updateComment(tracking.commentId, body);
      } else {
        writeComment(unit, body);
      }

      if (quarantined) {
        applyLabel(unit);
        log(
          `Quarantined ${kind} unit for #${id} after ${n} time(s) — labelled ${PHOEBE_QUARANTINE_LABEL} (${detail.reason}).`,
        );
      }
    } catch (error) {
      log(
        `Could not record ${trigger} toward quarantine for ${kind} #${id} — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function resolve(unit: UnitRef, trigger: UnitTrigger, note: string): void {
    const { kind, target } = unit;
    try {
      const activity = fetchActivity(unit);
      const tracking = findTrackingComment(activity.comments, kind);
      if (!tracking.commentId || !tracking.sections[trigger]) {
        return;
      }
      const remaining: TrackingSections = { ...tracking.sections };
      delete remaining[trigger];
      const remainingBody = serializeTrackingSections(remaining, kind);
      const body = remainingBody ? `${note}\n\n${remainingBody}` : note;
      github.updateComment(tracking.commentId, body);
    } catch (error) {
      log(
        `Could not clear ${trigger} tracking for ${kind} #${target.number} — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { record, resolve };
}
