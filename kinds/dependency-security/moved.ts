// The way out of the transitive bundle (ADR 0005). Its implementer makes
// lockfile fixes only and drops every row that needs more, under `## Dropped`
// in the PR body or, when every row dropped and there is no PR, in a comment
// on the issue. The detector reads those back for the rows to plan per
// package from now on, where a manifest fix is allowed. Any drop counts but
// one that was only too new.
//
// A bundle issue whose rows have all moved is parked under `phoebe:blocked`
// with nobody to act on it, and while it stays open it holds those rows out
// of the issues they moved to. The scan retires it (retire.ts).

import { PHOEBE_BLOCKED_LABEL } from "../../src/blocked.ts";
import type { MentioningIssue, MentioningPr } from "../../src/github-client.ts";
import { parseDropped } from "../dependencies-work/dropped.ts";
import { parseMarker } from "../dependencies/fingerprint.ts";
import type { ParkedIssue } from "../dependency-updates/parked.ts";
import { isTransitiveBundleKey, movedKey, type Moved } from "./plan.ts";

/** The manager a bundle key opens with; no manager name holds a colon. */
const managerOf = (key: string) => key.slice(0, key.indexOf(":"));

/** The transitive bundle key a body's marker carries, or null. */
function transitiveKey(body: string): string | null {
  const key = parseMarker(body)?.key;
  return key !== undefined && isTransitiveBundleKey(key) ? key : null;
}

/** The issues a transitive bundle filed, open or closed. */
export function transitiveBundleIssues(issues: readonly MentioningIssue[]): MentioningIssue[] {
  return issues.filter((issue) => transitiveKey(issue.body) !== null);
}

/**
 * The bundle issues whose comments can hold a `## Dropped` section: the open
 * ones, and the closed ones that were parked. An implementer comments one only
 * when every row dropped, which parks the ticket, and the label stays on
 * through the close. A bundle a merged PR closed has its drops in the PR
 * body, so the hourly scan spends no call on it.
 */
export function commentedBundleIssues(issues: readonly MentioningIssue[]): MentioningIssue[] {
  return issues.filter(
    (issue) => issue.state === "open" || issue.labels.includes(PHOEBE_BLOCKED_LABEL),
  );
}

/**
 * Every row a transitive bundle's implementer dropped, under the newest PR or
 * issue that dropped it. A PR counts whatever its state: a row the lockfile
 * could not fix needs a manifest fix whether or not the rest merged. Of an
 * issue's comments only Phoebe's own are in `parked`, so nobody else can move
 * a row by pasting a section.
 */
export function readMoved(
  prs: readonly MentioningPr[],
  bundleIssues: readonly MentioningIssue[],
  parked: readonly ParkedIssue[],
): Moved {
  const records: { manager: string; number: number; body: string }[] = [];
  for (const pr of prs) {
    const key = transitiveKey(pr.body);
    if (key !== null) records.push({ manager: managerOf(key), number: pr.number, body: pr.body });
  }
  const managers = new Map(
    bundleIssues.map((issue) => [issue.number, managerOf(transitiveKey(issue.body)!)]),
  );
  for (const issue of parked) {
    const manager = managers.get(issue.number);
    if (manager === undefined) continue;
    for (const body of issue.comments) records.push({ manager, number: issue.number, body });
  }

  const moved = new Map<string, number>();
  for (const record of records.sort((a, b) => a.number - b.number)) {
    for (const bump of parseDropped(record.body)) {
      if (!bump.tooNew)
        moved.set(movedKey(record.manager, bump.package, bump.version), record.number);
    }
  }
  return moved;
}
