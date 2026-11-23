// Open routed issues the scan no longer plans (ADR 0005, #898, #899). Filing
// touches an open issue only through the bundle planned under its key. One
// whose key is no longer planned would keep the routing label and its slot in
// the cap, and hold its rows out of wherever they belong now. The scan
// retires it: rewrites the body to list no rows, comments with the reason,
// and closes it. A body with no rows vetoes only its own key and fingerprint,
// so whatever still needs a fix is filed again.
//
// An issue's key stops being planned when:
//
//   - every row the transitive bundle listed was dropped by its implementer
//     and moved to an issue of its own (moved.ts);
//   - the tenant set `transitive: "individual"`, which plans no bundle;
//   - nothing it listed is left to fix: the fix landed outside the issue's
//     own PR, the advisories are under `minSeverity` now, or what is left has
//     no fix and nobody to act on it.
//
// The first two are read from the tenant's config and from Phoebe's own
// records, and the issue is retired on the scan that sees them. The third is
// read from what the sources did not report, which is weaker evidence. It
// counts only on a scan where every source saw everything it reads, and only
// when the scan before agreed. A scan that could not see everything, or that
// never got this far, breaks that run of two.
//
// The reason for each package goes into the body as well as the comment. The
// body is saved first, so a comment or a close that fails leaves an issue the
// next scan can still close with its explanation intact.
//
// An issue with a run or a PR in flight is never retired, and its labels are
// read again just before the close in case a run claimed it mid-scan. Neither
// is a per-package issue that still holds a row the plan files under another
// key, which is a transitive package filed before the bundle existed. "Holds"
// is filing's own test (filing.ts): the same package, workspace and target,
// with every advisory the plan lists on it already on the issue.

import type { MentioningIssue, MentioningPr } from "../../src/github-client.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { byText } from "../dependencies/candidate.ts";
import { closedIssues } from "../dependencies/filing.ts";
import { bundleKey, parseMarker } from "../dependencies/fingerprint.ts";
import { code, readIssueRows, type FiledRow } from "../dependencies/issue-body.ts";
import { describeMinSeverity, type MinSeverity } from "../dependencies/policy.ts";
import { renderRetiredBody, RETIRED_FINGERPRINT } from "./body.ts";
import {
  isSecurityKey,
  isTransitiveBundleKey,
  movedKey,
  packageKey,
  type Moved,
  type SecurityPlan,
  type TransitiveMode,
} from "./plan.ts";

export type RetireInput = {
  plan: Pick<SecurityPlan, "planned" | "belowPackages" | "unfixablePackages">;
  moved: Moved;
  prs: readonly MentioningPr[];
  routingLabel: string;
  /** The label an issue wears while a run or its PR is in flight. */
  processingLabel: string;
  transitive: TransitiveMode;
  minSeverity: MinSeverity;
  /** Whether every source finished and saw everything it reads. */
  complete: boolean;
  /** The issues the scan before found with nothing left to fix. */
  uncovered: ReadonlySet<number>;
};

export type Retired = {
  /** The issue list as GitHub now holds it. */
  issues: MentioningIssue[];
  /** The issues this scan found with nothing left to fix, for the next scan. */
  uncovered: Set<number>;
};

/** The manager and group of a bundle key; no manager name holds a colon. */
function parts(key: string): { manager: string; group: string } {
  const at = key.indexOf(":");
  return { manager: key.slice(0, at), group: key.slice(at + 1) };
}

const names = (packages: Iterable<string>) => [...new Set(packages)].sort(byText).map(code);

/** Why an issue's key is no longer planned, and how sure the scan is. */
type Why =
  | { kind: "emptied" }
  | { kind: "moved" }
  | { kind: "individual" }
  | { kind: "nothing-left" };

type Wording = {
  /** Why it closed, package by package. The body and the comment both carry it. */
  explanation: string;
  reason: "completed" | "not planned";
  log: string;
};

function wording(
  why: Exclude<Why, { kind: "emptied" }>,
  rows: readonly FiledRow[],
  manager: string,
  input: RetireInput,
  plannedRows: ReadonlySet<string>,
): Wording {
  const packages = names(rows.map((row) => row.package));
  if (why.kind === "moved") {
    return {
      explanation:
        "Every row this issue listed needed more than a lockfile fix. Phoebe is filing each " +
        `package on its own: ${packages.join(", ")}. Nothing is left to do here, so Phoebe ` +
        "closed it.",
      reason: "completed",
      log: "every row has moved to an issue of its own",
    };
  }
  if (why.kind === "individual") {
    return {
      explanation:
        'This repository now files each transitive package on its own (`transitive: "individual"`), ' +
        "so Phoebe closed this bundle. Each row that still needs a fix gets an issue of its own: " +
        `${packages.join(", ")}.`,
      reason: "not planned",
      log: 'the tenant files transitive packages on their own (`transitive: "individual"`)',
    };
  }

  // One line per reason, each naming the packages it covers.
  const of = (test: (row: FiledRow) => boolean) => names(rows.filter(test).map((r) => r.package));
  const rowKey = (row: FiledRow) => movedKey(manager, row.package, row.target);
  const isMoved = (row: FiledRow) => input.moved.has(rowKey(row));
  // Planned under another key without a drop: a critical, which has an issue of its own.
  const isElsewhere = (row: FiledRow) => !isMoved(row) && plannedRows.has(rowKey(row));
  const isFiled = (row: FiledRow) => isMoved(row) || isElsewhere(row);
  const isUnfixable = (row: FiledRow) =>
    !isFiled(row) && input.plan.unfixablePackages.has(packageKey(manager, row.package));
  const isBelow = (row: FiledRow) =>
    !isFiled(row) &&
    !isUnfixable(row) &&
    input.plan.belowPackages.has(packageKey(manager, row.package));
  const isGone = (row: FiledRow) => !isFiled(row) && !isUnfixable(row) && !isBelow(row);
  const lines: string[] = [];
  const movedOut = of(isMoved);
  if (movedOut.length > 0) {
    lines.push(
      `- ${movedOut.join(", ")}: it needed more than a lockfile fix, so Phoebe files it on its own.`,
    );
  }
  const elsewhere = of(isElsewhere);
  if (elsewhere.length > 0) {
    lines.push(`- ${elsewhere.join(", ")}: Phoebe files it in another issue now.`);
  }
  const gone = of(isGone);
  if (gone.length > 0) {
    lines.push(
      `- ${gone.join(", ")}: the scan no longer reports it. The fix landed outside this issue, ` +
        "or the package is no longer installed.",
    );
  }
  const below = of(isBelow);
  if (below.length > 0) {
    lines.push(
      `- ${below.join(", ")}: its advisories are under \`minSeverity\` now ` +
        `(${describeMinSeverity(input.minSeverity)}), so Phoebe no longer files it.`,
    );
  }
  const unfixable = of(isUnfixable);
  if (unfixable.length > 0) {
    lines.push(
      `- ${unfixable.join(", ")}: what is left has no fix released and no manifest declares the ` +
        "package, so nobody can act on it yet. Phoebe files it again when a fix ships.",
    );
  }
  return {
    explanation: [
      "Nothing this issue listed is left for Phoebe to fix, so Phoebe closed it.",
      "",
      ...lines,
      "",
      "The closed issue holds none of these rows back. If one needs a fix again, Phoebe files " +
        "a new issue for it.",
    ].join("\n"),
    reason: below.length === 0 && unfixable.length === 0 ? "completed" : "not planned",
    log: "nothing it listed is left to fix",
  };
}

/** What a retired issue's body opens with: what the issue was. */
function lead(key: string, rows: readonly FiledRow[]): string {
  const { manager } = parts(key);
  return isTransitiveBundleKey(key)
    ? `Security fixes for transitive packages under ${code(manager)}.`
    : `Security advisories in ${names(rows.map((row) => row.package)).join(", ")} under ${code(manager)}.`;
}

/**
 * Retire each open routed issue this scan plans no bundle for, and return the
 * issue list as GitHub now holds it with the issues to check again next scan.
 * An issue that could not be rewritten and closed is logged and returned as it
 * was, so the next scan tries again. That includes one whose body was saved
 * before the comment or the close failed: it lists no rows by then, and the
 * next scan closes it.
 */
export function retireUncovered(
  issues: readonly MentioningIssue[],
  input: RetireInput,
  ctx: Pick<WorkKindRunCtx, "github" | "log" | "clock">,
): Retired {
  const plannedKeys = new Set(input.plan.planned.map((p) => bundleKey(p.bundle)));
  const planned = input.plan.planned.flatMap((p) => p.bundle.candidates);
  const plannedRows = new Set(planned.map((c) => movedKey(c.manager, c.package, c.target)));
  // The advisories the plan lists on each row, by filing's identity for a row.
  const heldKey = (manager: string, pkg: string, workspace: string, target: string) =>
    JSON.stringify([manager, pkg, workspace, target]);
  const plannedAdvisories = new Map<string, string[][]>();
  for (const c of planned) {
    const key = heldKey(c.manager, c.package, c.workspace, c.target);
    plannedAdvisories.set(key, [
      ...(plannedAdvisories.get(key) ?? []),
      c.advisories.map((a) => a.id),
    ]);
  }
  /** Whether the issue's row keeps a planned row out of the bundle that plans it. */
  const holds = (manager: string, row: FiledRow) =>
    (plannedAdvisories.get(heldKey(manager, row.package, row.workspace, row.target)) ?? []).some(
      (ids) => ids.every((id) => row.advisories.includes(id)),
    );
  const prKeys = new Set<string>();
  const prCloses = new Set<number>();
  for (const pr of input.prs) {
    if (pr.state !== "open") continue;
    const key = parseMarker(pr.body)?.key;
    if (key !== undefined) prKeys.add(key);
    for (const n of closedIssues(pr.body)) prCloses.add(n);
  }

  const uncovered = new Set<number>();
  let waiting = 0;
  const retired = issues.map((issue) => {
    const marker = parseMarker(issue.body);
    if (marker === null || !isSecurityKey(marker.key)) return issue;
    const { key } = marker;
    if (issue.state !== "open" || !issue.labels.includes(input.routingLabel)) return issue;
    if (plannedKeys.has(key)) return issue;
    if (issue.labels.includes(input.processingLabel)) return issue;
    if (prKeys.has(key) || prCloses.has(issue.number)) return issue;

    const { manager, group } = parts(key);
    const rows = readIssueRows(issue.body);
    let why: Why;
    if (rows.length === 0) {
      // An earlier scan saved the retired body and failed before the close.
      if (marker.fingerprint !== RETIRED_FINGERPRINT) return issue;
      why = { kind: "emptied" };
    } else if (isTransitiveBundleKey(key)) {
      if (input.transitive === "individual") why = { kind: "individual" };
      else if (rows.every((row) => input.moved.has(movedKey(manager, row.package, row.target)))) {
        why = { kind: "moved" };
      } else why = { kind: "nothing-left" };
    } else {
      // A row the plan files under another key, and this issue holds, is still its to fix.
      if (rows.some((row) => holds(manager, row))) return issue;
      why = { kind: "nothing-left" };
    }

    if (why.kind === "nothing-left") {
      // Not counted, and what the scan before found is not carried over.
      if (!input.complete) {
        waiting += 1;
        return issue;
      }
      uncovered.add(issue.number);
      if (!input.uncovered.has(issue.number)) {
        ctx.log(
          `${key}: nothing #${issue.number} lists is left to fix; Phoebe closes it if the next ` +
            "scan agrees.",
        );
        return issue;
      }
    }

    const words = why.kind === "emptied" ? null : wording(why, rows, manager, input, plannedRows);
    const body =
      words === null
        ? issue.body
        : renderRetiredBody({ manager, group }, `${lead(key, rows)}\n\n${words.explanation}`);
    const reason = words?.reason ?? "completed";
    try {
      // Read fresh: a run may have claimed the issue since the scan listed it.
      if (ctx.github.issueLabels(issue.number).includes(input.processingLabel)) {
        ctx.log(`${key}: #${issue.number} was claimed during the scan; left for its run.`);
        return issue;
      }
      if (words !== null) {
        ctx.github.updateIssueBody(issue.number, body);
        ctx.github.postUnitComment({ objectType: "issue", id: issue.number }, words.explanation);
      }
      ctx.github.closeIssue(issue.number, reason);
    } catch (error) {
      ctx.log(
        `${key}: #${issue.number} has nothing left to do but could not be closed; its rows stay ` +
          `held this scan. ${error instanceof Error ? error.message : String(error)}`,
      );
      return issue;
    }
    uncovered.delete(issue.number);
    ctx.log(
      `${key}: closed #${issue.number}; ` +
        (words === null ? "an earlier scan emptied it and could not close it" : words.log) +
        ".",
    );
    return {
      ...issue,
      body,
      state: "closed" as const,
      stateReason: reason === "completed" ? ("completed" as const) : ("not_planned" as const),
      closedAt: ctx.clock.now().toISOString(),
    };
  });
  if (waiting > 0) {
    ctx.log(
      `${waiting} open issue(s) may have nothing left to fix, but a source failed or answered ` +
        "in part this scan, so Phoebe leaves them as they are.",
    );
  }
  return { issues: retired, uncovered };
}
