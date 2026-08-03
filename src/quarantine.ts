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
// local file. All of this is engine-side, in the per-tenant poll/selection
// layer: it touches zero of the crash-loop guard and sends the supervisor
// nothing, so a poison *unit* can never quarantine a healthy *engine SHA* (#60).
//
// The marker/comment builders here mirror the `*FailWatermark` family in
// orchestrator.ts (`build*`/`parse*`, read via `parseLatestMarker`).

import type { Sha } from "./branded.ts";

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

const QUARANTINE_BASELINE_RE = /<!--\s*phoebe-quarantine-baseline:\s*([^\s>]+)\s*-->/i;

export function buildQuarantineBaselineMarker(baseline: string): string {
  return `<!-- phoebe-quarantine-baseline: ${baseline} -->`;
}

export function parseQuarantineBaseline(text: string): string | null {
  const match = QUARANTINE_BASELINE_RE.exec(text);
  return match ? match[1]! : null;
}

/**
 * The one escalation comment posted at threshold: says the unit timed out K
 * times and needs a human, and records the baseline (PR head SHA for
 * conflicts/checks/reviews; issue `lastEditedAt` for issues/research) so the
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
