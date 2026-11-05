// The selection policy (ADR 0003): how long a release must age before it is
// proposed, and which advisories are severe enough to file on their own.

import { SEVERITIES, type Advisory, type Candidate, type Severity } from "./candidate.ts";

/** Days a release must age, per the size of the version move. */
export type MaturityDays = { patch: number; minor: number; major: number };

export type MaturityPolicy = MaturityDays & {
  /**
   * What happens to a candidate with no publish date. `propose` skips the
   * wait; `hold` never proposes it. Docker images on GHCR and MCR never carry
   * a date, so holding by default would drop them silently.
   */
  undated?: "propose" | "hold";
};

export const MATURITY_DEFAULTS: Required<MaturityPolicy> = {
  patch: 3,
  minor: 7,
  major: 14,
  undated: "propose",
};

/** The `minSeverity` an advisory must reach to file a routed issue of its own. */
export const MIN_SEVERITY_DEFAULT: Severity = "high";

const DAY_MS = 24 * 60 * 60 * 1000;

type Wait =
  | { kind: "none"; why: string }
  | { kind: "hold"; why: string }
  | { kind: "days"; days: number; publishedMs: number; move: string };

/** A version's leading numeric segments — `v1.2.3-rc.1` reads as [1, 2, 3] — or null. */
function numericSegments(version: string): number[] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  return match === null ? null : match.slice(1).map((part) => Number(part ?? 0));
}

/**
 * Which numeric segment differs first between two versions. A lockfile move
 * names no size of its own, so its wait follows the versions it moves
 * between; versions with no leading numbers wait as long as a major.
 */
function versionMove(current: string, target: string): keyof MaturityDays {
  const from = numericSegments(current);
  const to = numericSegments(target);
  if (from === null || to === null || from[0] !== to[0]) return "major";
  return from[1] !== to[1] ? "minor" : "patch";
}

/** Whether `target` reaches `fixedIn`, compared segment by segment. Unreadable versions do not. */
function reaches(target: string, fixedIn: string): boolean {
  const have = numericSegments(target);
  const need = numericSegments(fixedIn);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

function waitFor(candidate: Candidate, policy: MaturityPolicy): Wait {
  const fixed = candidate.advisories
    .filter((a) => a.fixedIn !== null && reaches(candidate.target, a.fixedIn))
    .map((a) => a.id);
  if (fixed.length > 0) {
    return { kind: "none", why: `fixes ${fixed.join(", ")}, so it skips the maturity wait` };
  }
  if (candidate.updateType === "pin" || candidate.updateType === "digest") {
    return {
      kind: "none",
      why: `${candidate.updateType} update; it names no new version, so it skips the maturity wait`,
    };
  }
  const publishedMs = Date.parse(candidate.publishedAt ?? "");
  if (Number.isNaN(publishedMs)) {
    return (policy.undated ?? MATURITY_DEFAULTS.undated) === "hold"
      ? { kind: "hold", why: "publish date unknown; held by `undated: hold`" }
      : { kind: "none", why: "publish date unknown, so it skips the maturity wait" };
  }
  if (candidate.updateType === "lockfile") {
    const size = versionMove(candidate.current, candidate.target);
    return { kind: "days", days: policy[size], publishedMs, move: `lockfile (${size})` };
  }
  return {
    kind: "days",
    days: policy[candidate.updateType],
    publishedMs,
    move: candidate.updateType,
  };
}

/**
 * Whether a candidate has aged enough to propose at `now`. A target that
 * fixes one of the candidate's advisories skips the wait, as do a pin and a
 * digest; so does a missing or unreadable publish date, unless the policy
 * holds undated candidates.
 */
export function isMature(
  candidate: Candidate,
  now: Date,
  policy: MaturityPolicy = MATURITY_DEFAULTS,
): boolean {
  const wait = waitFor(candidate, policy);
  if (wait.kind === "none") return true;
  if (wait.kind === "hold") return false;
  return now.getTime() - wait.publishedMs >= wait.days * DAY_MS;
}

/**
 * Why the policy selected a candidate, in words the issue body carries. It
 * reads no clock, so the body stays the same from one cycle to the next.
 */
export function selectionReason(
  candidate: Candidate,
  policy: MaturityPolicy = MATURITY_DEFAULTS,
): string {
  const wait = waitFor(candidate, policy);
  if (wait.kind !== "days") return wait.why;
  return `${wait.move} update past the ${wait.days}-day maturity wait`;
}

/** Whether an advisory reaches `minSeverity`, ordering low, moderate, high, critical. */
export function overThreshold(
  advisory: Advisory,
  minSeverity: Severity = MIN_SEVERITY_DEFAULT,
): boolean {
  return SEVERITIES.indexOf(advisory.severity) >= SEVERITIES.indexOf(minSeverity);
}
