// Filing (ADR 0003): what a detector does with its bundles, given what GitHub
// already holds. Every issue a detector files, and every PR the implementer
// opens from one, carries the marker, so one search for issues and one for PRs
// is the whole record:
//
//   - an open issue with the bundle's key and fingerprint is left alone;
//   - an open issue with the key and another fingerprint gets the new body and
//     a one-line comment;
//   - a closed issue that no merged PR closed vetoes its fingerprint, so the
//     bundle is filed again only once a version or an advisory moves;
//   - anything else is a new issue, unless the open cap is reached.
//
// `decideFiling` is the pure half; `applyFiling` makes the GitHub calls.

import { PHOEBE_BLOCKED_LABEL } from "../../src/blocked.ts";
import type { MentioningIssue, MentioningPr } from "../../src/github-client.ts";
import { addLabelCreatingIfMissing, type PhoebeLabel } from "../../src/labels.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { bundleKey, fingerprint, MARKER_TEXT, parseMarker } from "./fingerprint.ts";
import type { Bundle } from "./grouping.ts";

/** The label every dependency issue wears, beside the routing label. */
export const DEPENDENCIES_LABEL: PhoebeLabel = {
  name: "dependencies",
  description: "Dependency updates Phoebe found",
};

/** The label a dependency-security issue wears, beside `dependencies`. */
export const SECURITY_LABEL: PhoebeLabel = {
  name: "security",
  description: "A security advisory against a dependency",
};

/** A bundle ready to file: its rendered title and body, the marker last. */
export type PlannedBundle = {
  bundle: Bundle;
  title: string;
  body: string;
  /** The labels a new issue gets, when they differ from the detector's own set. */
  labels?: readonly PhoebeLabel[];
};

export type FilingAction =
  | { action: "leave"; planned: PlannedBundle; issue: number }
  | { action: "update"; planned: PlannedBundle; issue: number; previous: string }
  | { action: "vetoed"; planned: PlannedBundle; issue: number }
  | { action: "create"; planned: PlannedBundle }
  | { action: "capped"; planned: PlannedBundle };

export type FilingOptions = {
  /** The routing label; an open issue counts toward the cap only when it wears it. */
  routingLabel: string;
  /** Open routed bundles allowed at once; null for no cap. */
  cap: number | null;
};

// GitHub's closing keywords, as a merged PR body names the issue it closes.
const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

function closedIssues(body: string): number[] {
  return [...body.matchAll(CLOSES_RE)].map((m) => Number(m[1]));
}

const pairKey = (key: string, print: string) => JSON.stringify([key, print]);

/**
 * One decision per bundle, in the order the bundles come. The cap counts
 * bundles in flight, not objects: an open routed issue and the open PR working
 * it share a key and count once. A closed issue is merged when a merged PR
 * names it in a closing keyword or carries its marker; the PR's own marker is
 * the issue's at the time the PR opened, so the closing keyword is what holds
 * when the issue was refreshed after.
 */
export function decideFiling(
  planned: readonly PlannedBundle[],
  issues: readonly MentioningIssue[],
  prs: readonly MentioningPr[],
  options: FilingOptions,
): FilingAction[] {
  const mergedPairs = new Set<string>();
  const mergedIssues = new Set<number>();
  const inFlight = new Set<string>();
  for (const pr of prs) {
    const marker = parseMarker(pr.body);
    if (pr.merged) {
      if (marker !== null) mergedPairs.add(pairKey(marker.key, marker.fingerprint));
      for (const n of closedIssues(pr.body)) mergedIssues.add(n);
    } else if (pr.state === "open" && marker !== null) {
      inFlight.add(marker.key);
    }
  }

  // Newest first, so the first open issue per key is the one to keep current.
  const open = new Map<string, { number: number; fingerprint: string }>();
  const vetoes = new Map<string, number>();
  for (const issue of issues) {
    const marker = parseMarker(issue.body);
    if (marker === null) continue;
    if (issue.state === "open") {
      if (!open.has(marker.key)) {
        open.set(marker.key, { number: issue.number, fingerprint: marker.fingerprint });
      }
      // A parked ticket is passed over by the implementer, so it holds no slot.
      if (
        issue.labels.includes(options.routingLabel) &&
        !issue.labels.includes(PHOEBE_BLOCKED_LABEL)
      ) {
        inFlight.add(marker.key);
      }
      continue;
    }
    const pair = pairKey(marker.key, marker.fingerprint);
    if (!mergedIssues.has(issue.number) && !mergedPairs.has(pair) && !vetoes.has(pair)) {
      vetoes.set(pair, issue.number);
    }
  }

  return planned.map((p): FilingAction => {
    const key = bundleKey(p.bundle);
    const print = fingerprint(p.bundle);
    const filed = open.get(key);
    if (filed !== undefined) {
      return filed.fingerprint === print
        ? { action: "leave", planned: p, issue: filed.number }
        : { action: "update", planned: p, issue: filed.number, previous: filed.fingerprint };
    }
    const vetoedBy = vetoes.get(pairKey(key, print));
    if (vetoedBy !== undefined) return { action: "vetoed", planned: p, issue: vetoedBy };
    if (options.cap !== null && inFlight.size >= options.cap) {
      return { action: "capped", planned: p };
    }
    inFlight.add(key);
    return { action: "create", planned: p };
  });
}

/** The one line posted on an issue whose bundle moved. */
export function renderRefreshComment(planned: PlannedBundle, previous: string): string {
  const count = planned.bundle.candidates.length;
  return (
    `Phoebe refreshed this issue: the bundle now proposes ${count} update(s) ` +
    `(fingerprint ${previous} → ${fingerprint(planned.bundle)}).`
  );
}

export type FilingCounts = Record<FilingAction["action"], number>;

/**
 * Carry out the decisions and log one line per write and one summary. A new
 * issue gets the bundle's own labels when it names them, else `labels`. A
 * label that cannot be added is logged for a person to add by hand rather than
 * thrown: the issue exists and carries the marker, so a throw would leave the
 * bundle filed without its labels and a retry would file it twice.
 */
export function applyFiling(
  actions: readonly FilingAction[],
  ctx: Pick<WorkKindRunCtx, "github" | "log">,
  labels: readonly PhoebeLabel[],
): FilingCounts {
  const counts: FilingCounts = { leave: 0, update: 0, vetoed: 0, create: 0, capped: 0 };
  for (const a of actions) {
    counts[a.action] += 1;
    const key = bundleKey(a.planned.bundle);
    if (a.action === "update") {
      ctx.github.updateIssueBody(a.issue, a.planned.body);
      ctx.github.postUnitComment(
        { objectType: "issue", id: a.issue },
        renderRefreshComment(a.planned, a.previous),
      );
      ctx.log(`${key}: refreshed #${a.issue}.`);
    } else if (a.action === "create") {
      const issue = ctx.github.createIssue({ title: a.planned.title, body: a.planned.body });
      for (const label of a.planned.labels ?? labels) {
        try {
          addLabelCreatingIfMissing(ctx.github, issue, label, (line) => ctx.log(line));
        } catch (error) {
          ctx.log(
            `${key}: filed #${issue} but could not add label "${label.name}"; add it by hand. ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      ctx.log(`${key}: filed #${issue}.`);
    }
  }
  ctx.log(
    `filing: ${counts.create} filed, ${counts.update} refreshed, ${counts.leave} unchanged, ` +
      `${counts.vetoed} vetoed by a closed issue, ${counts.capped} held by the open cap.`,
  );
  return counts;
}

/** Every issue and PR carrying the marker: the two searches a filing pass reads. */
export function readFiled(ctx: Pick<WorkKindRunCtx, "github">): {
  issues: MentioningIssue[];
  prs: MentioningPr[];
} {
  return {
    issues: ctx.github.listIssuesMentioning(MARKER_TEXT),
    prs: ctx.github.listPrsMentioning(MARKER_TEXT),
  };
}
