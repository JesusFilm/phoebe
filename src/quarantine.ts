// Poison-unit repeat protection (#75) — a unit-scoped quarantine policy layered
// on #73's `UnitEvent`/`emitUnitEvent` rail and a GitHub-marker durable home.
//
// #72's timeout keeps a hung unit from starving the fleet, but it does not stop
// a *genuinely* poisonous unit — one that hangs the agent every rotation — from
// being re-picked forever, burning the full budget and producing nothing. This
// module is the policy: count consecutive timeouts per `(kind, id)`, and at K
// apply a `phoebe:quarantined` label + an escalation comment so a human takes
// over. State lives entirely on GitHub (a timeout-counter marker + the label),
// so it survives container/volume loss — the reason #73 chose markers over a
// local file. Quarantine is not a one-way door: the engine sweeps labelled units
// every cycle and clears the ones whose *content* has advanced past the baseline
// the escalation comment recorded (`decideAutoUnstick`), and either exit — the
// sweep or a hand-removed label — restarts the count from zero. All of this is
// engine-side, in the per-tenant poll/selection layer: it touches zero of the
// crash-loop guard and sends the supervisor nothing, so a poison *unit* can never
// quarantine a healthy *engine SHA* (#60).
//
// The marker/comment builders here mirror the `*FailWatermark` family in
// orchestrator.ts (`build*`/`parse*`, read via `parseLatestMarker`).

import { createHash } from "node:crypto";

/** Phoebe-owned skip label — distinct from the user-supplied `prOptOutLabel`. */
export const PHOEBE_QUARANTINE_LABEL = "phoebe:quarantined";

/** Consecutive timeouts before quarantine; the #75 house number. */
export const DEFAULT_MAX_UNIT_TIMEOUTS = 3;

/**
 * Resolve K: `PHOEBE_MAX_UNIT_TIMEOUTS` (a positive integer) wins, else the
 * config field, else the default 3. A fleet-protection backstop, not a per-repo
 * tuning knob (mirrors #72's timeout resolution).
 */
export function resolveMaxUnitTimeouts(
  env: NodeJS.ProcessEnv,
  configValue: number = DEFAULT_MAX_UNIT_TIMEOUTS,
): number {
  const raw = Number(env["PHOEBE_MAX_UNIT_TIMEOUTS"]);
  if (Number.isInteger(raw) && raw >= 1) return raw;
  return Number.isInteger(configValue) && configValue >= 1
    ? configValue
    : DEFAULT_MAX_UNIT_TIMEOUTS;
}

// --- Timeout counter marker (posted on every timeout; embeds n) --------------

const UNIT_TIMEOUT_MARKER_RE = /<!--\s*phoebe-unit-timeout:\s*n=(\d+)\s*-->/i;

export function buildUnitTimeoutMarker(n: number): string {
  return `<!-- phoebe-unit-timeout: n=${n} -->`;
}

export function parseUnitTimeoutMarker(text: string): { n: number } | null {
  const match = UNIT_TIMEOUT_MARKER_RE.exec(text);
  return match ? { n: Number(match[1]) } : null;
}

// --- Quarantine baseline marker (in the escalation comment, for auto-unstick) -

// Both markers are anchored to the start of a line: GitHub's "Quote reply"
// reproduces a comment verbatim behind `> `, and an unanchored pattern would let
// a human quoting an old escalation comment resurrect its stale baseline.
const QUARANTINE_BASELINE_RE = /^<!--\s*phoebe-quarantine-baseline:\s*([^\s>]+)\s*-->/im;

/** Stamped on the un-stick comment, marking the quarantine above it as spent. */
const QUARANTINE_CLEARED_MARKER = "<!-- phoebe-quarantine-cleared -->";
const QUARANTINE_CLEARED_RE = /^<!--\s*phoebe-quarantine-cleared\s*-->/im;

export function buildQuarantineBaselineMarker(baseline: string): string {
  return `<!-- phoebe-quarantine-baseline: ${baseline} -->`;
}

export function parseQuarantineBaseline(text: string): string | null {
  const match = QUARANTINE_BASELINE_RE.exec(text);
  return match ? match[1]! : null;
}

/**
 * The baseline recorded for a quarantined issue/research unit: a fingerprint of
 * the issue body. It must be *content*, not a timestamp — GitHub bumps an issue's
 * `updatedAt` on any comment, label change, or reaction, including the quarantine
 * comment and label Phoebe itself writes right after snapshotting the baseline,
 * so a timestamp baseline clears every quarantine on the first sweep (#153).
 * Namespaced with `body:` so it can never be confused with a PR's head-SHA
 * baseline.
 */
export function issueContentBaseline(body: string): string {
  return `body:${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * The baseline of the quarantine currently in force, or `null` when there is
 * none — which is how a human-applied `phoebe:quarantined` label is told apart
 * from Phoebe's own, so the sweep only ever lifts a label it placed itself.
 * Comments come oldest-first, as `gh` returns them, and the scan runs newest-first
 * so it stops at the un-stick comment: a baseline older than that belongs to a
 * quarantine already lifted, and must not clear a label re-applied by hand since.
 */
export function latestQuarantineBaseline(comments: readonly { body: string }[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]!.body;
    if (QUARANTINE_CLEARED_RE.test(body)) {
      return null;
    }
    const baseline = parseQuarantineBaseline(body);
    if (baseline !== null) {
      return baseline;
    }
  }
  return null;
}

/**
 * The one escalation comment posted at threshold: says the unit timed out K
 * times and needs a human, and records the baseline (PR head SHA for
 * conflicts/checks/reviews; `issueContentBaseline` for issues/research) so the
 * auto-un-stick sweep can tell when someone has actually changed the thing.
 */
export function buildQuarantineComment(opts: {
  kind: string;
  id: number;
  k: number;
  baseline: string;
}): string {
  return [
    `⚠️ Phoebe quarantined this unit: the \`${opts.kind}\` work on #${opts.id} timed out ` +
      `${opts.k} times in a row without completing. It has been labelled ` +
      `\`${PHOEBE_QUARANTINE_LABEL}\` and skipped so it stops burning the run budget. ` +
      `A human should take a look.`,
    "",
    `Remove the \`${PHOEBE_QUARANTINE_LABEL}\` label to retry, or push a fix / edit the ` +
      `issue — Phoebe auto-clears the label when the content advances past the baseline below.`,
    "",
    buildQuarantineBaselineMarker(opts.baseline),
  ].join("\n");
}

/**
 * The comment posted when the sweep auto-un-sticks a unit. It embeds an `n=0`
 * timeout marker, so clearing the label also clears the counter — otherwise the
 * unit would re-quarantine on its very next timeout instead of getting a fresh K.
 */
export function buildUnstickComment(): string {
  return [
    `♻️ This has changed since it was quarantined, so Phoebe removed the ` +
      `\`${PHOEBE_QUARANTINE_LABEL}\` label and reset its timeout count. It is eligible ` +
      `for work again.`,
    "",
    buildUnitTimeoutMarker(0),
    QUARANTINE_CLEARED_MARKER,
  ].join("\n");
}

// --- Pure counting + quarantine decision -------------------------------------

/**
 * The next timeout count to record for a unit. Reset-on-activity (#75): if the
 * unit has newer activity than the latest timeout marker (a newer commit or
 * comment), the prior count is stale and treated as 0; otherwise carry it. Then
 * increment for this timeout. A missing prior marker means this is the first.
 */
export function nextTimeoutCount(previous: number | null, staleActivity: boolean): number {
  const base = staleActivity ? 0 : (previous ?? 0);
  return base + 1;
}

/** Quarantine when the recorded count reaches the threshold. */
export function shouldQuarantine(count: number, k: number): boolean {
  return count >= k;
}

/**
 * The latest `phoebe-unit-timeout` marker among a unit's comments (given
 * oldest-first, as `gh` returns them), paired with the `createdAt` of the comment
 * carrying it — the timestamp the reset-on-activity check compares against. Scans
 * newest-first so the most recent marker wins. `null` when the unit has never
 * timed out. This is the timeout-counter analogue of orchestrator's
 * `parseLatestMarker`, but it must keep the marker comment's timestamp.
 */
export function latestTimeoutMarker(
  comments: readonly { body: string; createdAt: string }[],
): { n: number; createdAt: string } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const parsed = parseUnitTimeoutMarker(comments[i]!.body);
    if (parsed) {
      return { n: parsed.n, createdAt: comments[i]!.createdAt };
    }
  }
  return null;
}

/**
 * The newest comment instant NOT authored by Phoebe, or `null`. This is the reset
 * signal for a hung unit: a human comment counts, but Phoebe's own timeout
 * markers must not — otherwise every rotation's marker would look like fresh
 * activity and the count could never climb to K.
 */
export function newestForeignCommentAt(
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

/** Later of two optional ISO instants (`gh` returns them Z-normalized, so `>` is chronological). */
function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * Decide the count to record for a just-timed-out unit and whether it crosses the
 * quarantine threshold. Pure: the engine supplies the unit's fetched comments
 * (body + createdAt + authorLogin), Phoebe's own login, an optional extra
 * external-activity instant (`extraActivityAt` — e.g. a PR head commit's
 * committedDate), and `k`. Reset-on-activity fires when the newest external
 * activity (a foreign comment or that extra instant) is strictly newer than the
 * latest timeout marker, so a unit someone has touched since its last timeout
 * starts counting afresh.
 */
export function decideTimeoutRecord(opts: {
  comments: readonly { body: string; createdAt: string; authorLogin: string }[];
  phoebeLogin: string;
  extraActivityAt?: string | null;
  k: number;
}): { count: number; quarantine: boolean } {
  const marker = latestTimeoutMarker(opts.comments);
  const latestActivityAt = maxIso(
    newestForeignCommentAt(opts.comments, opts.phoebeLogin),
    opts.extraActivityAt ?? null,
  );
  const staleActivity =
    marker !== null && latestActivityAt !== null && latestActivityAt > marker.createdAt;
  // A marker already at or past K means the unit *was* quarantined — and
  // selection skips quarantined units, so its being picked again at all means the
  // label is gone: either a human removed it or the sweep did. Either way that is
  // a deliberate retry and deserves a fresh K, not the single retry a carried-over
  // count would buy (#153). (If the label write itself failed back at K, this
  // resets too — so quarantine is re-attempted every K timeouts until one of those
  // writes lands, rather than the unit being stuck uncounted.)
  const clearedSinceQuarantine = marker !== null && marker.n >= opts.k;
  const count = nextTimeoutCount(marker ? marker.n : null, staleActivity || clearedSinceQuarantine);
  return { count, quarantine: shouldQuarantine(count, opts.k) };
}

/**
 * The auto-un-stick sweep's decision for one quarantined unit: someone changed
 * the thing that hung. `currentBaseline` is the unit's content fingerprint right
 * now — a PR's head SHA, an issue's `issueContentBaseline` — and any difference
 * from the in-force quarantine's baseline clears it. A bare comment or reaction
 * changes no fingerprint, so nothing can silently re-arm a unit no one has fixed;
 * a label with no live escalation comment behind it is never touched at all.
 */
export function decideAutoUnstick(opts: {
  comments: readonly { body: string }[];
  currentBaseline: string;
}): boolean {
  const baseline = latestQuarantineBaseline(opts.comments);
  return baseline !== null && baseline !== opts.currentBaseline;
}
