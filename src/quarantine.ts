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
// `createQuarantine` is the one write entry point (`record`/`resolve`/
// `sweepUnstuck`), constructed once per process alongside the other adapters
// (#53's `io` bundle) and passed into every kind. It owns the marker format, the
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
// `resolve()` the moment a run produces a PR). Progress-based triggers also
// reset on a changed `signature` (#173) — the typed reason a caller passes
// in `QuarantineDetail` — so a streak only compounds toward quarantine while
// the *same* problem keeps recurring; three attempts each failing a
// different way reset to n=1 every time instead of stacking into a false
// quarantine.
//
// A quarantine a human clears by hand (removing the label) is invisible to a
// sweep that queries *by* label — it can't discover a unit that no longer
// carries the label at all. `record()` handles the fully-lazy case, at the
// unit's next failure, where the comments are already fetched: an escalation
// section whose label is now absent means a human cleared it — that trigger's
// counter resets to 0 before recording this new failure.
//
// The auto-un-stick sweep is the other side of that same escalation comment's
// promise (#69): `sweepUnstuck()` runs once a cycle, before selection — one
// `phoebe:quarantined` list query apiece for issues and PRs, then per hit, a
// baseline compare against the escalation section(s) still on its tracking
// comment(s). On a clear it resets the counter and drops the label together,
// so the retry that follows doesn't re-quarantine itself on its first slip.
// A unit can still lose the label between that list query and this per-unit
// fetch — a human unlabelling it mid-cycle. `unstickViaManualClear` (#138)
// catches that race eagerly instead of leaving it to the next failure: the
// `unlabeled` timeline confirms a real human removal before resetting
// counters and posting an audit comment naming the actor, and it falls back
// silently to `record()`'s lazy path if the timeline read itself fails.

import { createHash } from "node:crypto";
import { asPrNumber } from "./branded.ts";
import { WORK_KIND_NAMES, type WorkKindName } from "./config/index.ts";
import type { GitHub, LabelRemoval } from "./github.ts";
import type { UnitRef } from "./kinds/kind.ts";

/** Phoebe-owned skip label — distinct from the user-supplied `prOptOutLabel`. */
export const PHOEBE_QUARANTINE_LABEL = "phoebe:quarantined";

/**
 * Phoebe-owned escape hatch (#136): a human applies this to say "retry this
 * unit as-is" — environment fixed, flaky infra resolved, or a PR-keyed unit
 * whose head can't move. `sweepUnstuck()` consumes it unconditionally,
 * unlike the baseline-advance check the label-only `PHOEBE_QUARANTINE_LABEL`
 * path requires.
 */
export const PHOEBE_RETRY_LABEL = "phoebe:retry";

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

// Both markers are anchored to the start of a line: GitHub's "Quote reply"
// reproduces a comment verbatim behind `> `, and an unanchored pattern would let
// a human quoting an old escalation comment resurrect its stale baseline.
const QUARANTINE_BASELINE_RE = /^<!--\s*phoebe-quarantine-baseline:\s*([^\s>]+)\s*-->/im;

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
 * conflicts/checks; a content hash of the issue body for issues/research) so
 * the auto-un-stick sweep can tell when someone has actually changed the
 * thing — a Phoebe-authored write (label, comment) never moves either.
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
      `issue — Phoebe auto-clears the label when the content advances past the baseline below. ` +
      `Edit the body if the spec changed; apply \`${PHOEBE_RETRY_LABEL}\` to retry unchanged.`,
    "",
    buildQuarantineBaselineMarker(opts.baseline),
  ].join("\n");
}

/**
 * Whether a quarantined unit should be auto-un-stuck: someone changed the
 * thing that hung. `current` is the PR's head SHA, or a content hash of the
 * issue body — either way, "has the identity ref moved past what was
 * recorded at escalation". A bare human comment (no content change) does not
 * move either, so it can't silently re-arm a unit no one has fixed.
 */
export function shouldAutoUnstick(opts: { baseline: string; current: string }): boolean {
  return opts.current !== opts.baseline;
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

// --- Escalated-section scan (for sweepUnstuck, #69) --------------------------

/** Same shape as `unitMarkerRe`, but `kind` and `trigger` are captures rather than fixed — the auto-un-stick sweep finds units by label, not by kind. */
const ANY_UNIT_MARKER_RE =
  /<!--\s*phoebe-unit:([a-z][a-z-]*):([a-z][a-z-]*)\s+n=\d+\s+sig=[a-z0-9-]+\s+ref=[A-Za-z0-9._:-]+\s+at=[0-9TZ:.+-]+\s*-->/gi;

function asWorkKindName(value: string): WorkKindName | null {
  return (WORK_KIND_NAMES as readonly string[]).includes(value) ? (value as WorkKindName) : null;
}

function asUnitTrigger(value: string): UnitTrigger | null {
  return (ALL_TRIGGERS as readonly string[]).includes(value) ? (value as UnitTrigger) : null;
}

export type EscalatedSection = { kind: WorkKindName; trigger: UnitTrigger; baseline: string };

/**
 * Every trigger section, across all of a unit's tracking comments, that is
 * currently the escalation (its prose still carries the `phoebe-quarantine-
 * baseline` marker `buildQuarantineComment` writes at threshold) — a
 * below-threshold section never carries that marker, so it's excluded for
 * free. Kind and trigger are read off the marker itself rather than guessed,
 * since `sweepUnstuck` only knows the unit by its label, not by kind.
 */
export function findEscalatedSections(comments: readonly { body: string }[]): EscalatedSection[] {
  const sections: EscalatedSection[] = [];
  for (const comment of comments) {
    let cursor = 0;
    for (const match of comment.body.matchAll(ANY_UNIT_MARKER_RE)) {
      const prose = comment.body.slice(cursor, match.index).trim();
      cursor = match.index + match[0].length;
      const baseline = parseQuarantineBaseline(prose);
      const kind = asWorkKindName(match[1]!);
      const trigger = asUnitTrigger(match[2]!);
      if (baseline !== null && kind !== null && trigger !== null) {
        sections.push({ kind, trigger, baseline });
      }
    }
  }
  return sections;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An issue-keyed unit's baseline (#135): a content hash, not a timestamp — no Phoebe write (comment, label) can move it, only an edit to the body itself. */
function issueContentBaseline(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

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
 *
 * Progress-based triggers also reset when `signature` — the typed reason a
 * caller passes as `QuarantineDetail.signature` (#173) — differs from the
 * prior marker's, on top of the `ref` check: three attempts that failed for
 * three different reasons are not the same recurring problem three times
 * over, so they must not compound into one streak toward quarantine. Only a
 * reason repeating attempt over attempt is the signal quarantine exists to
 * catch.
 */
function nextCount(
  trigger: UnitTrigger,
  previous: UnitMarker | null,
  opts: {
    ref: string;
    signature: string;
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
  const stale =
    previous === null || previous.ref !== opts.ref || previous.signature !== opts.signature;
  return (stale ? 0 : previous!.n) + 1;
}

export type QuarantineDetail = {
  /**
   * Bound, marker-safe slug for what went wrong this attempt, e.g.
   * `mergeable-conflicting` — a typed reason where the caller has one (#173;
   * see `producer.ts#issueAttemptFailureSignature`), a free-text-derived slug
   * otherwise. Beyond display, this is also part of the progress-based
   * triggers' counter key (`nextCount`): a change in signature resets the
   * streak, the same as a moved `ref`. Ignored for `timed-out`, whose
   * counter is purely activity-based.
   */
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

/** A unit's identity as the status rail (`runtime-status.ts`) names it — never the reset rule, just carried data. */
type QuarantineWorkRef = { kind: WorkKindName; issueNumber?: number; pullRequestNumber?: number };

/**
 * The one reporting rail a quarantine label going on or off routes through
 * (#70/#60) — structurally `RuntimeStatusTransition`'s `unit-quarantined`/
 * `unit-unquarantined` cases, narrowed so this module doesn't need to import
 * the whole union. Defaults to a no-op: most callers (tests, and any future
 * standalone use of this façade) don't care that the status rail exists.
 */
export type QuarantineReport = (
  event:
    | { kind: "unit-quarantined"; work: QuarantineWorkRef; reason: string }
    | { kind: "unit-unquarantined"; work: QuarantineWorkRef; reason: string },
) => void;

export type Quarantine = {
  /** Fold one failure into the unit's `(kind, id, trigger)` counter; at threshold, label + escalate. Best-effort. */
  record(unit: UnitRef, trigger: UnitTrigger, detail: QuarantineDetail): void;
  /** Clear a trigger's counter on forward progress (e.g. an issue produced a PR) — `note` replaces its section. */
  resolve(unit: UnitRef, trigger: UnitTrigger, note: string): void;
  /**
   * Cycle-level, run once before selection (#69): every issue and PR still
   * carrying `phoebe:quarantined`, auto-cleared — counter reset and label
   * removed together — the moment its content has moved past the baseline
   * recorded at escalation. The manual-clear path (a human removing the
   * label by hand) is a different event, handled at `record()` time instead.
   */
  sweepUnstuck(): void;
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
  report?: QuarantineReport;
}): Quarantine {
  const { github, config, log } = opts;
  const report = opts.report ?? (() => {});

  function workRefFor(unit: UnitRef): QuarantineWorkRef {
    return unit.target.type === "pr"
      ? { kind: unit.kind, pullRequestNumber: unit.target.number }
      : { kind: unit.kind, issueNumber: unit.target.number };
  }

  /** Takes a bare target (not a full `UnitRef`) — `kind` plays no part in what gets fetched, and `sweepUnstuck` doesn't know it yet when it calls this. */
  function fetchActivity(target: UnitRef["target"]): UnitActivity {
    if (target.type === "issue") {
      const activity = github.issueActivity(target.number);
      return {
        comments: activity.comments,
        labels: activity.labels,
        ref: String(target.number),
        baseline: issueContentBaseline(activity.body),
        lastCommitAt: null,
      };
    }
    const activity = github.prActivity(asPrNumber(target.number));
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
      const activity = fetchActivity(target);
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
          report({
            kind: "unit-unquarantined",
            work: workRefFor(unit),
            reason: `the ${PHOEBE_QUARANTINE_LABEL} label was removed by hand — the ${trigger} counter reset to 0`,
          });
        }
      }

      const now = new Date().toISOString();
      const k = trigger === "timed-out" ? config.maxUnitTimeouts : config.maxUnitAttempts;
      const n = nextCount(trigger, previous, {
        ref: activity.ref,
        signature: detail.signature,
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
        report({
          kind: "unit-quarantined",
          work: workRefFor(unit),
          reason: `${detail.reason} ${n} time(s) — labelled ${PHOEBE_QUARANTINE_LABEL}`,
        });
      }
    } catch (error) {
      log(
        `Could not record ${trigger} toward quarantine for ${kind} #${id} — ${errorMessage(error)}`,
      );
    }
  }

  function resolve(unit: UnitRef, trigger: UnitTrigger, note: string): void {
    const { kind, target } = unit;
    try {
      const activity = fetchActivity(target);
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
        `Could not clear ${trigger} tracking for ${kind} #${target.number} — ${errorMessage(error)}`,
      );
    }
  }

  function sweepUnstuck(): void {
    const issueNumbers = new Set<number>();
    try {
      for (const issue of github.issuesWithLabel(PHOEBE_QUARANTINE_LABEL)) {
        issueNumbers.add(issue.number);
      }
    } catch (error) {
      log(`Could not list quarantined issues for the auto-un-stick sweep — ${errorMessage(error)}`);
    }
    try {
      for (const issue of github.issuesWithLabel(PHOEBE_RETRY_LABEL)) {
        issueNumbers.add(issue.number);
      }
    } catch (error) {
      log(
        `Could not list ${PHOEBE_RETRY_LABEL} issues for the auto-un-stick sweep — ${errorMessage(error)}`,
      );
    }
    for (const number of issueNumbers) {
      unstickOne({ type: "issue", number });
    }

    const prNumbers = new Set<number>();
    try {
      for (const pr of github.prsWithLabel(PHOEBE_QUARANTINE_LABEL)) {
        prNumbers.add(pr.number);
      }
    } catch (error) {
      log(`Could not list quarantined PRs for the auto-un-stick sweep — ${errorMessage(error)}`);
    }
    try {
      for (const pr of github.prsWithLabel(PHOEBE_RETRY_LABEL)) {
        prNumbers.add(pr.number);
      }
    } catch (error) {
      log(
        `Could not list ${PHOEBE_RETRY_LABEL} PRs for the auto-un-stick sweep — ${errorMessage(error)}`,
      );
    }
    for (const number of prNumbers) {
      unstickOne({ type: "pr", number });
    }
  }

  /**
   * `phoebe:retry`'s audit trail (#136) — a top-level comment distinct from
   * the tracking-comment edit `resolve()` makes, so the "why" survives even
   * though the trigger sections it names get folded back into their prose.
   */
  function buildRetryAuditComment(opts: {
    wasQuarantined: boolean;
    resetTriggers: readonly UnitTrigger[];
  }): string {
    if (!opts.wasQuarantined) {
      return (
        `♻️ Phoebe cleared \`${PHOEBE_RETRY_LABEL}\` — this unit wasn't ` +
        `\`${PHOEBE_QUARANTINE_LABEL}\`, so there was nothing to reset.`
      );
    }
    const triggerList = opts.resetTriggers.map((t) => `\`${t}\``).join(", ");
    const resetNote = triggerList ? ` and reset its ${triggerList} counter(s) to 0` : "";
    return (
      `♻️ Phoebe retried this unit at a human's request (\`${PHOEBE_RETRY_LABEL}\`): removed ` +
      `\`${PHOEBE_QUARANTINE_LABEL}\`${resetNote}.`
    );
  }

  /**
   * The `phoebe:retry` escape hatch (#136): unconditional, unlike the
   * baseline-advance check below — a human is vouching for the retry, so no
   * content-moved evidence is required. Every escalated trigger's counter
   * resets via the normal `resolve()` path, both labels come off, and an
   * audit comment records what happened even when the unit was never
   * quarantined in the first place (a human may apply the label pre-
   * emptively, or after the quarantine already cleared) — that case still
   * needs the label consumed, just with nothing to reset.
   */
  function unstickViaRetry(target: UnitRef["target"], activity: UnitActivity): void {
    const wasQuarantined = activity.labels.includes(PHOEBE_QUARANTINE_LABEL);
    const sections = wasQuarantined ? findEscalatedSections(activity.comments) : [];

    for (const section of sections) {
      resolve(
        { kind: section.kind, target },
        section.trigger,
        `Phoebe reset this via \`${PHOEBE_RETRY_LABEL}\` — a human asked to retry as-is; the ` +
          `\`${section.trigger}\` counter reset to 0.`,
      );
      report({
        kind: "unit-unquarantined",
        work: workRefFor({ kind: section.kind, target }),
        reason: `a human applied \`${PHOEBE_RETRY_LABEL}\` — retried as-is`,
      });
    }

    if (wasQuarantined) {
      if (target.type === "issue") {
        github.unlabelIssue(target.number, PHOEBE_QUARANTINE_LABEL);
      } else {
        github.unlabelPr(asPrNumber(target.number), PHOEBE_QUARANTINE_LABEL);
      }
    }

    const auditBody = buildRetryAuditComment({
      wasQuarantined,
      resetTriggers: sections.map((s) => s.trigger),
    });
    if (target.type === "issue") {
      github.unlabelIssue(target.number, PHOEBE_RETRY_LABEL);
      github.commentIssue(target.number, auditBody);
    } else {
      const prNumber = asPrNumber(target.number);
      github.unlabelPr(prNumber, PHOEBE_RETRY_LABEL);
      github.commentPr(prNumber, auditBody);
    }
  }

  /**
   * Eager manual-clear detection (#138): a by-label sweep structurally can't
   * *discover* a hand-unlabelled unit — it only gets here because it still
   * carried `PHOEBE_QUARANTINE_LABEL` at `sweepUnstuck`'s list-query moment,
   * and lost it before this per-unit fetch ran. The timeline read confirms
   * that was a genuine `unlabeled` event (not just a unit with nothing to
   * clear) before resetting counters and reporting, so the acknowledgment
   * lands this cycle instead of waiting on the unit's next failure — the
   * `record()` reset at #68/#544-558 stays as the fallback for when the
   * timeline call itself fails.
   */
  function unstickViaManualClear(target: UnitRef["target"], activity: UnitActivity): void {
    const sections = findEscalatedSections(activity.comments);
    if (sections.length === 0) {
      return;
    }
    let removals: readonly LabelRemoval[];
    try {
      removals = github.labelRemovals(target.number, PHOEBE_QUARANTINE_LABEL);
    } catch (error) {
      log(
        `Could not read the unlabeled timeline for ${target.type} #${target.number} — ` +
          `falling back to the lazy manual-clear reset at next record() — ${errorMessage(error)}`,
      );
      return;
    }
    const latest = removals[removals.length - 1];
    if (!latest) {
      return;
    }
    for (const section of sections) {
      resolve(
        { kind: section.kind, target },
        section.trigger,
        `Phoebe detected that @${latest.actorLogin} removed \`${PHOEBE_QUARANTINE_LABEL}\` by hand — ` +
          `the \`${section.trigger}\` counter reset to 0.`,
      );
      report({
        kind: "unit-unquarantined",
        work: workRefFor({ kind: section.kind, target }),
        reason: `@${latest.actorLogin} removed the ${PHOEBE_QUARANTINE_LABEL} label by hand — manually cleared`,
      });
    }
    const auditBody =
      `🔓 Phoebe noticed @${latest.actorLogin} removed \`${PHOEBE_QUARANTINE_LABEL}\` by hand and reset ` +
      `its counter${sections.length > 1 ? "s" : ""} to 0.`;
    if (target.type === "issue") {
      github.commentIssue(target.number, auditBody);
    } else {
      github.commentPr(asPrNumber(target.number), auditBody);
    }
  }

  /**
   * One quarantined and/or retry-flagged unit: read its baseline(s) off the
   * escalation section(s) still on its tracking comment(s) — kind and
   * trigger are read straight off the marker, never assumed, since this is
   * called from a plain label list with no kind attached. `phoebe:retry`
   * short-circuits straight to `unstickViaRetry` — unconditional, no
   * baseline check. If `PHOEBE_QUARANTINE_LABEL` is already gone by the time
   * this per-unit fetch runs (it was present at `sweepUnstuck`'s list-query
   * moment, or this unit wouldn't be a candidate at all), that's a manual
   * clear caught mid-race — `unstickViaManualClear` confirms it via the
   * timeline before resetting. With the label still present, clears (resets
   * every escalated trigger's counter + removes the label, together) only
   * when every escalated section has advanced past its own baseline — a unit
   * stuck on two triggers at once stays labelled until both let go.
   */
  function unstickOne(target: UnitRef["target"]): void {
    try {
      const activity = fetchActivity(target);
      if (activity.labels.includes(PHOEBE_RETRY_LABEL)) {
        unstickViaRetry(target, activity);
        return;
      }
      if (!activity.labels.includes(PHOEBE_QUARANTINE_LABEL)) {
        unstickViaManualClear(target, activity);
        return;
      }
      const sections = findEscalatedSections(activity.comments);
      if (sections.length === 0) {
        return;
      }
      const cleared = sections.every((section) =>
        shouldAutoUnstick({ baseline: section.baseline, current: activity.baseline }),
      );
      if (!cleared) {
        return;
      }
      for (const section of sections) {
        resolve(
          { kind: section.kind, target },
          section.trigger,
          `Phoebe auto-cleared \`${PHOEBE_QUARANTINE_LABEL}\` — the content advanced past the recorded baseline.`,
        );
        report({
          kind: "unit-unquarantined",
          work: workRefFor({ kind: section.kind, target }),
          reason: "the content advanced past the recorded baseline — auto-cleared",
        });
      }
      if (target.type === "issue") {
        github.unlabelIssue(target.number, PHOEBE_QUARANTINE_LABEL);
      } else {
        github.unlabelPr(asPrNumber(target.number), PHOEBE_QUARANTINE_LABEL);
      }
    } catch (error) {
      log(
        `Could not evaluate auto-un-stick for ${target.type} #${target.number} — ${errorMessage(error)}`,
      );
    }
  }

  return { record, resolve, sweepUnstuck };
}
