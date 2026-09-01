// Feature membership (#341, ticket #378): which feature, if any, an issue
// belongs to — and whether that feature is still live.
//
// A *feature* is a parent issue wearing `featureLabel`. Its descendants land on
// one integration branch, `<branchPrefix>feature-<parent>`, instead of going to
// the default branch one ticket at a time. This module answers membership only;
// routing a unit onto the branch it names is #379.
//
// The walk climbs the issue graph rather than stopping at the immediate parent:
// a grandchild of an opted-in map whose own parent is an ordinary ticket is
// still a member, and stopping early would land it on the default branch while
// its siblings land on the feature branch — the silent split the whole arm
// exists to prevent.
//
// Reads go through `FeatureGraphReader` so the walk itself stays a pure
// function of what GitHub said. The engine's implementation
// (src/cycle-work-source.ts) memoizes per cycle and absorbs a per-issue read
// failure as `null` — an issue whose graph cannot be read is unaffiliated for
// this cycle, not a dead cycle.

import { asBranchRef, type BranchRef, type PrNumber } from "./branded.ts";
import { config } from "./resolved-config.ts";

/**
 * How many parent hops a membership walk makes before giving up. A map above a
 * sub-map above a ticket is three; the cap is what stops a pathological graph
 * (or one Phoebe misreads) from spending a cycle's API budget climbing.
 */
export const MAX_FEATURE_ANCESTOR_DEPTH = 5;

/** One issue as the membership walk needs to see it. */
export type IssueGraphNode = {
  number: number;
  title: string;
  labels: readonly string[];
  /** Body text, read for the `Part of #M` fallback when there is no native link. */
  body: string;
  /** Closed in either sense — a closed feature parent retires the feature. */
  closed: boolean;
  /**
   * The native GitHub sub-issue parent, or `null` when the issue has none. A
   * parent in another repository also reads as `null`: Phoebe works one repo,
   * and it could neither branch from nor open a PR against the other one.
   */
  parentNumber: number | null;
};

/** The PR Phoebe opens against a feature branch, in whatever state it is now. */
export type IntegrationPr = { number: PrNumber; state: "OPEN" | "MERGED" | "CLOSED" };

/**
 * The two GitHub reads a membership walk makes, both cycle-memoized by the
 * engine. In both, a bare `null` means the read failed — the walk stops and the
 * issue is unaffiliated for this cycle rather than routed on a guess. "There is
 * no integration PR yet" is a *successful* read, so it comes back wrapped.
 */
export type FeatureGraphReader = {
  /** One issue's graph node, or `null` when it could not be read. */
  issueGraphNode(issueNumber: number): IssueGraphNode | null;
  /** The integration PR on a feature's branch (`{ pr: null }` when it has none). */
  featureIntegrationPr(featureIssueNumber: number): { pr: IntegrationPr | null } | null;
};

/** A live feature an issue belongs to. */
export type Feature = {
  /** The opted-in parent issue — the feature's identity and branch name source. */
  issueNumber: number;
  title: string;
  branch: BranchRef;
  /** The integration PR, absent until the feature arm opens it on first use of the branch. */
  integrationPrNumber?: PrNumber;
};

/**
 * The integration branch for a feature, derived from the parent issue number —
 * the same shape as `issueBranch`, and inside `branchPrefix` so a
 * `prScope: "phoebe"` tenant admits its PRs.
 */
export function featureBranch(featureIssueNumber: number): BranchRef {
  return asBranchRef(`${config.branchPrefix}feature-${featureIssueNumber}`);
}

/**
 * The feature issue number a branch names, or `null` when the branch is not a
 * feature branch — the inverse of `featureBranch`, and how a sweep recognises
 * an integration PR from the head branch alone.
 */
export function parseFeatureIssueNumber(branch: BranchRef): number | null {
  const prefix = `${config.branchPrefix}feature-`;
  if (!branch.startsWith(prefix)) {
    return null;
  }
  const rest = branch.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/**
 * The membership declaration a human can hand-author in a browser: the first
 * `Part of #M` in an issue body, or `null` when there is none. Configurable via
 * `config.partOfPattern` in the same shape as `blockedByPattern` — capture
 * group 1 must yield the parent issue number.
 */
export function parsePartOf(body: string): number | null {
  const match = new RegExp(config.partOfPattern, "i").exec(body);
  return match ? Number(match[1]) : null;
}

/** The parent of one node: the native link first, the body declaration second. */
function parentOf(node: IssueGraphNode): number | null {
  return node.parentNumber ?? parsePartOf(node.body);
}

/**
 * A feature is live until its integration PR reaches a terminal state — merged
 * or closed. Closing that PR is the cancel lever; the parent issue closing is
 * the belt-and-braces fallback for a feature abandoned without touching it.
 * A branch with no PR yet is live: #379 has simply not opened it.
 */
function liveFeature(parent: IssueGraphNode, reader: FeatureGraphReader): Feature | null {
  if (parent.closed) {
    return null;
  }
  const read = reader.featureIntegrationPr(parent.number);
  if (!read) {
    return null;
  }
  const pr = read.pr;
  if (pr && pr.state !== "OPEN") {
    return null;
  }
  return {
    issueNumber: parent.number,
    title: parent.title,
    branch: featureBranch(parent.number),
    ...(pr ? { integrationPrNumber: pr.number } : {}),
  };
}

/**
 * The live feature an issue belongs to, or `null` when it belongs to none —
 * because no ancestor is opted in, because the feature has retired, or because
 * a read failed. All three mean the same thing to a caller: an ordinary ticket
 * bound for the default branch.
 */
export function resolveFeature(issueNumber: number, reader: FeatureGraphReader): Feature | null {
  let node = reader.issueGraphNode(issueNumber);
  if (!node) {
    return null;
  }
  // A cycle in the graph is only reachable through hand-authored `Part of`
  // lines, which nothing validates — the seen set keeps one from re-reading the
  // same ancestors until the depth cap happens to stop it.
  const seen = new Set<number>([issueNumber]);
  for (let depth = 0; depth < MAX_FEATURE_ANCESTOR_DEPTH; depth++) {
    const parentNumber = parentOf(node);
    if (parentNumber === null || seen.has(parentNumber)) {
      return null;
    }
    seen.add(parentNumber);
    const parent = reader.issueGraphNode(parentNumber);
    if (!parent) {
      return null;
    }
    if (parent.labels.includes(config.featureLabel)) {
      return liveFeature(parent, reader);
    }
    node = parent;
  }
  return null;
}
