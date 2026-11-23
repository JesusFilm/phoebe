// The verdict on a security ticket that needs a manifest fix, and what the
// detector does with a "not affected" one (ADR 0005).
//
// The implementer never closes an issue or touches a label. When it finds
// the tenant is not exposed, it comments its evidence under `## Verdict` with
// the verdict marker on a line of its own, and the blocked marker last so the
// stranded sweep parks the ticket at once. The next scan reads the comment:
//
//   - no advisory on the ticket is critical: the scan closes the issue as not
//     planned and takes `phoebe:blocked` off. That is a dismissal. The closed
//     issue vetoes its rows like any other, so it stands until a new advisory
//     lands on the package or a person reopens it;
//   - one is critical: the scan takes the routing label off and leaves the
//     ticket parked. A maintainer decides. An advisory counts as critical when
//     the ticket's body says so or when this scan's sources do: one re-rated
//     from high since the ticket was filed keeps its id, so the body still
//     reads high and the closed issue would veto the row that is now critical.
//
// Either way the scan's own comment carries an acknowledgement marker, and a
// verdict older than the newest acknowledgement is spent. A person who reopens
// a dismissed issue has overruled it, and the scan must not close it again.
// The acknowledgement is written first: a close that fails after it leaves a
// parked ticket for a person, where a close that succeeded before a failed
// acknowledgement would be repeated on every reopen.
//
// Only Phoebe's own comments count, so a passer-by on a public repository
// cannot dismiss an advisory by pasting the marker.

import { PHOEBE_BLOCKED_LABEL } from "../../src/blocked.ts";
import type { MentioningIssue } from "../../src/github-client.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { parseMarker } from "../dependencies/fingerprint.ts";
import { hasCriticalAdvisory, readIssueRows } from "../dependencies/issue-body.ts";
import type { ParkedIssue } from "../dependency-updates/parked.ts";
import { isSecurityKey, isTransitiveBundleKey } from "./plan.ts";

/** The line the implementer writes under a not-affected verdict, on a line of its own. */
export const VERDICT_MARKER = "<!-- phoebe-verdict not-affected -->";

/** The line the scan writes once it has acted on a verdict. */
export const VERDICT_ACK_MARKER = "<!-- phoebe-verdict-ack -->";

// Anchored to the start of a line, as the blocked marker is, so a quoted copy
// of an old comment is not read as a fresh verdict.
const VERDICT_RE = /^<!--\s*phoebe-verdict\s+not-affected\s*-->/im;
const ACK_RE = /^<!--\s*phoebe-verdict-ack\s*-->/im;

/**
 * Whether the newest of Phoebe's comments that carries either marker is a
 * verdict, which is to say one the scan has not acted on. `comments` come
 * oldest first.
 */
export function hasLiveVerdict(comments: readonly string[]): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (ACK_RE.test(comments[i]!)) return false;
    if (VERDICT_RE.test(comments[i]!)) return true;
  }
  return false;
}

/**
 * The open, routed, per-package security issues: the only ones a verdict is
 * reached on. The transitive bundle takes lockfile fixes alone, and a tracking
 * issue is worked by nothing.
 */
export function verdictIssues(
  issues: readonly MentioningIssue[],
  routingLabel: string,
): MentioningIssue[] {
  return issues.filter((issue) => {
    if (issue.state !== "open" || !issue.labels.includes(routingLabel)) return false;
    const key = parseMarker(issue.body)?.key;
    return key !== undefined && isSecurityKey(key) && !isTransitiveBundleKey(key);
  });
}

const DISMISSED_COMMENT = [
  "Phoebe's last run found this repository is not affected, and its comment above says why. " +
    "No advisory here is critical, so Phoebe closed the issue as not planned.",
  "",
  "It stays closed until a new advisory lands on the package. Nothing re-checks the finding, so " +
    "if the code changes in a way that makes the vulnerable path reachable, reopen this issue " +
    "and Phoebe applies the fix.",
  "",
  VERDICT_ACK_MARKER,
].join("\n");

const criticalComment = (routingLabel: string) =>
  [
    "Phoebe's last run found this repository is not affected, and its comment above says why. " +
      "An advisory here is critical, so a maintainer decides, not Phoebe.",
    "",
    `If you agree, close the issue. If you want the fix, put the \`${routingLabel}\` label back ` +
      `and remove \`${PHOEBE_BLOCKED_LABEL}\`.`,
    "",
    VERDICT_ACK_MARKER,
  ].join("\n");

/**
 * Act on every live not-affected verdict among `read`, the issues of
 * {@link verdictIssues} with Phoebe's comments, and return the issue list as
 * GitHub now holds it. A step that fails is logged for a person to finish by
 * hand; the acknowledgement is already written by then, so no later scan
 * repeats the half that worked. `criticalNow` holds, by bundle key, the ids
 * of the advisories this scan's plan rates critical.
 */
export function actOnVerdicts(
  issues: readonly MentioningIssue[],
  read: readonly ParkedIssue[],
  routingLabel: string,
  ctx: Pick<WorkKindRunCtx, "github" | "log" | "clock">,
  criticalNow: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): MentioningIssue[] {
  const live = new Set(
    read.filter((issue) => hasLiveVerdict(issue.comments)).map((issue) => issue.number),
  );
  return issues.map((issue) => {
    if (!live.has(issue.number)) return issue;
    const target = { objectType: "issue" as const, id: issue.number };
    const failed = (step: string, error: unknown) =>
      ctx.log(
        `#${issue.number}: not-affected verdict, but could not ${step}; do it by hand. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );

    const nowCritical = criticalNow.get(parseMarker(issue.body)?.key ?? "");
    const rerated =
      nowCritical !== undefined &&
      readIssueRows(issue.body).some((row) => row.advisories.some((id) => nowCritical.has(id)));
    if (hasCriticalAdvisory(issue.body) || rerated) {
      try {
        ctx.github.postUnitComment(target, criticalComment(routingLabel));
      } catch (error) {
        failed("comment on it, so it is left for the next scan", error);
        return issue;
      }
      try {
        ctx.github.removeIssueLabel(issue.number, routingLabel);
      } catch (error) {
        failed(`remove label "${routingLabel}"`, error);
        return issue;
      }
      ctx.log(
        `#${issue.number}: not-affected verdict on a critical; took off "${routingLabel}" and ` +
          "left it parked for a maintainer.",
      );
      return { ...issue, labels: issue.labels.filter((label) => label !== routingLabel) };
    }

    try {
      ctx.github.postUnitComment(target, DISMISSED_COMMENT);
    } catch (error) {
      failed("comment on it, so it is left for the next scan", error);
      return issue;
    }
    try {
      ctx.github.closeIssue(issue.number, "not planned");
    } catch (error) {
      failed("close it", error);
      return issue;
    }
    let labels = issue.labels;
    if (labels.includes(PHOEBE_BLOCKED_LABEL)) {
      try {
        ctx.github.removeIssueLabel(issue.number, PHOEBE_BLOCKED_LABEL);
        labels = labels.filter((label) => label !== PHOEBE_BLOCKED_LABEL);
      } catch (error) {
        failed(`remove label "${PHOEBE_BLOCKED_LABEL}", which a reopen needs gone`, error);
      }
    }
    ctx.log(`#${issue.number}: not-affected verdict; dismissed it as not planned.`);
    return {
      ...issue,
      labels,
      state: "closed" as const,
      stateReason: "not_planned" as const,
      closedAt: ctx.clock.now().toISOString(),
    };
  });
}
