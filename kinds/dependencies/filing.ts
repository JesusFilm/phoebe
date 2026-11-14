// Filing (ADR 0003): what a detector does with its bundles, given what GitHub
// already holds. Every issue a detector files, and every PR the implementer
// opens from one, carries the marker, so one search for issues and one for PRs
// is the whole record:
//
//   - an open issue with the bundle's key and fingerprint is left alone;
//   - an open issue with the key and another fingerprint gets the new body and
//     a one-line comment;
//   - a closed issue that no merged PR closed vetoes the rows it listed, so a
//     row is filed again only once its own target or advisories move, and the
//     rest of its bundle files without it (#861). A body with no rows to read
//     vetoes its fingerprint instead;
//   - a row an open issue under another key already lists is held back from
//     a bundle whose own open issue does not list it, so one bump is never
//     proposed by two open issues (#860);
//   - anything else is a new issue, unless the open cap is reached.
//
// `decideFiling` is the pure half; `applyFiling` makes the GitHub calls.

import { PHOEBE_BLOCKED_LABEL } from "../../src/blocked.ts";
import type { MentioningIssue, MentioningPr } from "../../src/github-client.ts";
import { addLabelCreatingIfMissing, type PhoebeLabel } from "../../src/labels.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { bundleKey, fingerprint, MARKER_TEXT, parseMarker } from "./fingerprint.ts";
import type { Bundle } from "./grouping.ts";
import { readIssueRows } from "./issue-body.ts";

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

/** What a detector renders for one bundle: its title and body, the marker last. */
export type Rendered = {
  title: string;
  body: string;
  /** The labels a new issue gets, when they differ from the detector's own set. */
  labels?: readonly PhoebeLabel[];
};

/** A bundle ready to file, and how to render it again once a veto drops rows from it. */
export type PlannedBundle = Rendered & {
  bundle: Bundle;
  render: (bundle: Bundle) => Rendered;
};

/** A bundle rendered by `render`, which filing calls again on whatever rows a veto leaves. */
export function planBundle(bundle: Bundle, render: (bundle: Bundle) => Rendered): PlannedBundle {
  return { bundle, ...render(bundle), render };
}

/**
 * A row dropped from its bundle before filing: `vetoed` when a closed issue
 * listed it, `proposed` when an open issue under another key already does.
 */
export type HeldRow = {
  package: string;
  target: string;
  issue: number;
  by: "vetoed" | "proposed";
};

export type FilingAction = (
  | { action: "leave"; planned: PlannedBundle; issue: number }
  | { action: "update"; planned: PlannedBundle; issue: number; previous: string }
  | { action: "vetoed"; planned: PlannedBundle; issue: number }
  | { action: "proposed"; planned: PlannedBundle; issue: number }
  | { action: "create"; planned: PlannedBundle }
  | { action: "capped"; planned: PlannedBundle }
) & { held: readonly HeldRow[] };

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

/** A row's identity across bundles: one package in one workspace moving to one target. */
const rowKey = (manager: string, pkg: string, workspace: string, target: string) =>
  JSON.stringify([manager, pkg, workspace, target]);

/** The manager a bundle key opens with; no manager name holds a colon. */
const managerOf = (key: string) => key.slice(0, key.indexOf(":"));

type RowVeto = { issue: number; advisories: ReadonlySet<string> };

/** An open issue listing a row, the bundle key it files under, and the advisories it lists. */
type RowListing = RowVeto & { key: string };

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/**
 * One decision per bundle, in the order the bundles come. The cap counts
 * bundles in flight, not objects: an open routed issue and the open PR working
 * it share a key and count once. A closed issue is merged when a merged PR
 * names it in a closing keyword or carries its marker; the PR's own marker is
 * the issue's at the time the PR opened, so the closing keyword is what holds
 * when the issue was refreshed after.
 *
 * A closed, unmerged issue vetoes each row it listed, by manager, package,
 * workspace and target, in whichever bundle the row turns up next. The row
 * comes back once its target moves or it carries an advisory the issue did
 * not list against its package.
 *
 * An open issue holds each row it lists, by the same four fields, out of
 * every bundle under another key, unless that bundle's own open issue lists
 * the row too. A row whose bundle moves to a new key between scans then stays
 * with the issue that already proposes it rather than being filed twice, and
 * an issue that already lists a row keeps it. As with a veto, a row carrying
 * an advisory the open issue does not list is not held.
 *
 * Held rows are dropped before a bundle is filed or refreshed and the bundle
 * is rendered again without them. A bundle left with none is vetoed whole when
 * a closed issue held any of its rows, and is left as proposed otherwise.
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
  const rowVetoes = new Map<string, RowVeto[]>();
  const rowListings = new Map<string, RowListing[]>();
  for (const issue of issues) {
    const marker = parseMarker(issue.body);
    if (marker === null) continue;
    const manager = managerOf(marker.key);
    const rows = readIssueRows(issue.body);
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
      for (const row of rows) {
        const key = rowKey(manager, row.package, row.workspace, row.target);
        const advisories = new Set(row.advisories);
        pushTo(rowListings, key, { issue: issue.number, key: marker.key, advisories });
      }
      continue;
    }
    const pair = pairKey(marker.key, marker.fingerprint);
    if (mergedIssues.has(issue.number) || mergedPairs.has(pair)) continue;
    if (rows.length === 0 && !vetoes.has(pair)) vetoes.set(pair, issue.number);
    for (const row of rows) {
      const key = rowKey(manager, row.package, row.workspace, row.target);
      pushTo(rowVetoes, key, { issue: issue.number, advisories: new Set(row.advisories) });
    }
  }

  return planned.map((given): FilingAction => {
    const own = bundleKey(given.bundle);
    const held: HeldRow[] = [];
    const kept = given.bundle.candidates.filter((c) => {
      const row = rowKey(given.bundle.manager, c.package, c.workspace, c.target);
      const covers = (v: RowVeto) => c.advisories.every((a) => v.advisories.has(a.id));
      const veto = rowVetoes.get(row)?.find(covers);
      if (veto !== undefined) {
        held.push({ package: c.package, target: c.target, issue: veto.issue, by: "vetoed" });
        return false;
      }
      const listings = rowListings.get(row) ?? [];
      const elsewhere = listings.find((l) => l.key !== own && covers(l));
      if (elsewhere === undefined || listings.some((l) => l.key === own)) return true;
      held.push({ package: c.package, target: c.target, issue: elsewhere.issue, by: "proposed" });
      return false;
    });
    if (kept.length === 0 && held.length > 0) {
      const veto = held.find((r) => r.by === "vetoed");
      return veto !== undefined
        ? { action: "vetoed", planned: given, issue: veto.issue, held }
        : { action: "proposed", planned: given, issue: held[0]!.issue, held };
    }
    const p =
      held.length === 0 ? given : planBundle({ ...given.bundle, candidates: kept }, given.render);

    const key = bundleKey(p.bundle);
    const print = fingerprint(p.bundle);
    const filed = open.get(key);
    if (filed !== undefined) {
      return filed.fingerprint === print
        ? { action: "leave", planned: p, issue: filed.number, held }
        : { action: "update", planned: p, issue: filed.number, previous: filed.fingerprint, held };
    }
    const vetoedBy = vetoes.get(pairKey(key, print));
    if (vetoedBy !== undefined) return { action: "vetoed", planned: p, issue: vetoedBy, held };
    if (options.cap !== null && inFlight.size >= options.cap) {
      return { action: "capped", planned: p, held };
    }
    inFlight.add(key);
    return { action: "create", planned: p, held };
  });
}

/** The log line naming each row held back from a bundle, once per package and target. */
export function renderHeldLine(key: string, held: readonly HeldRow[]): string {
  const why = (r: HeldRow) =>
    r.by === "vetoed" ? `vetoed by #${r.issue}` : `already proposed in #${r.issue}`;
  const named = new Set(held.map((r) => `${r.package}@${r.target} (${why(r)})`));
  return `${key}: held back ${[...named].join(", ")}.`;
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
  const counts: FilingCounts = {
    leave: 0,
    update: 0,
    vetoed: 0,
    proposed: 0,
    create: 0,
    capped: 0,
  };
  for (const a of actions) {
    counts[a.action] += 1;
    const key = bundleKey(a.planned.bundle);
    if (a.held.length > 0) ctx.log(renderHeldLine(key, a.held));
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
      `${counts.vetoed} vetoed by a closed issue, ${counts.proposed} already proposed by an open ` +
      `issue, ${counts.capped} held by the open cap.`,
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
