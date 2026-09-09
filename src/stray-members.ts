// Stray members (#448, ticket #487) — the members a retired feature leaves
// wearing labels nothing will ever take off them.
//
// A feature ends in one of two ways: its integration PR merges, or the feature
// is cancelled (the PR closed, or the parent issue closed behind it). Either way
// the routing arm stops seeing the members underneath it, because
// `resolveFeature` folds a retired feature into "no feature". Whatever label a
// member was wearing at that moment — `readyLabel`, `researchLabel`,
// `processingLabel`, `mergedLabel` — it is still wearing now, and no sweep is
// coming for it. Four ways that happens:
//
//   • `mergedLabel` survives the integration PR it was waiting on.
//   • A member sits in `processingLabel` with a PR the feature-closes sweep
//     never saw, because it merged after the integration PR did.
//   • A member sits in `processingLabel` with a PR that merged into a blocker's
//     branch rather than the feature branch, so nothing closed it.
//   • A cancelled feature strands every member in whatever state it was in.
//
// Phoebe repairs none of it. Each of the four looks identical from outside — an
// open issue, a Phoebe label, a feature that has ended — and the repair differs
// by what the operator meant, so this module reports and stops. `phoebe doctor`
// runs it on demand; nothing runs it per cycle.

import {
  MAX_FEATURE_ANCESTOR_DEPTH,
  resolveFeatureMembership,
  type FeatureEnd,
  type FeatureGraphReader,
  type FeatureMembership,
  type FeatureWalkConfig,
  type IntegrationPr,
  type IssueGraphNode,
} from "./feature-branch.ts";

/** One open issue, as the stray scan needs to see it. */
export type LabelledIssue = {
  number: number;
  title: string;
  labels: readonly string[];
};

/** One open member of a feature that has ended, and the one thing to do about it. */
export type StrayMember = {
  issueNumber: number;
  issueTitle: string;
  /** The labels Phoebe reads that this member still wears, in config order. */
  labels: string[];
  featureIssueNumber: number;
  featureTitle: string;
  end: FeatureEnd;
  /** One line, in the operator's terms — the repair Phoebe deliberately did not make. */
  hint: string;
};

/**
 * What to do with a stray, which is the whole difference between the two ends.
 *
 * A merged feature's member is done: its work is on the default branch and the
 * issue is simply still open. A cancelled feature's member is not — closing it
 * writes it off, and stripping the label hands it back to the default branch as
 * an ordinary ticket. Only the operator knows which they meant, so both are
 * offered.
 */
export function strayHint(end: FeatureEnd, issueNumber: number, labels: readonly string[]): string {
  if (end === "merged") {
    return `close #${issueNumber}`;
  }
  const named = labels.map((name) => JSON.stringify(name)).join(" and ");
  return `close #${issueNumber}, or strip ${named} to re-route it onto the default branch`;
}

/**
 * Every issue in `issues` whose feature has ended while it still wears a label
 * Phoebe reads. Pure over the membership answer, so doctor tests it with a
 * stubbed reader and no network.
 *
 * A member of a *live* feature is never reported whatever it is wearing: a
 * label mid-feature is the arm working, not a leftover.
 */
export function scanStrayMembers(deps: {
  issues: readonly LabelledIssue[];
  /** `readyLabel`, `researchLabel`, `processingLabel` and `mergedLabel`, in that order. */
  watched: readonly string[];
  membership: (issueNumber: number) => FeatureMembership;
}): StrayMember[] {
  // A tenant is free to point two of the four label fields at one name; the
  // finding should say that name once.
  const watched = [...new Set(deps.watched)];
  const strays: StrayMember[] = [];
  for (const issue of deps.issues) {
    const worn = watched.filter((name) => issue.labels.includes(name));
    if (worn.length === 0) continue;
    const membership = deps.membership(issue.number);
    if (membership.state !== "retired") continue;
    strays.push({
      issueNumber: issue.number,
      issueTitle: issue.title,
      labels: worn,
      featureIssueNumber: membership.feature.issueNumber,
      featureTitle: membership.feature.title,
      end: membership.end,
      hint: strayHint(membership.end, issue.number, worn),
    });
  }
  return strays;
}

/**
 * The same two graph reads {@link FeatureGraphReader} makes, from a caller that
 * has to await them. The engine's reader is synchronous because the cycle has
 * already paid for its reads; doctor pays on demand, over the same REST API it
 * probes the repo with.
 */
export type FeatureGraphSource = {
  issueGraphNode(issueNumber: number): Promise<IssueGraphNode | null>;
  featureIntegrationPr(featureIssueNumber: number): Promise<{ pr: IntegrationPr | null } | null>;
};

/**
 * Membership for each issue, fetching as the walk asks.
 *
 * The walk is synchronous and the source is not, so each issue is walked
 * repeatedly against a growing cache: a read the cache cannot answer records
 * itself and comes back empty, the walk unwinds, that one read is awaited, and
 * the walk runs again. Every replay after the first therefore gets one step
 * further, and the walk's own depth cap bounds how many it takes.
 *
 * The cache spans the whole batch, so siblings under one feature pay for their
 * shared ancestors and that feature's integration PR exactly once.
 */
export async function readMemberships(deps: {
  issueNumbers: readonly number[];
  source: FeatureGraphSource;
  walk: FeatureWalkConfig;
}): Promise<Map<number, FeatureMembership>> {
  const nodes = new Map<number, IssueGraphNode | null>();
  const prs = new Map<number, { pr: IntegrationPr | null } | null>();
  let wanted: { kind: "node" | "pr"; number: number } | null = null;

  const reader: FeatureGraphReader = {
    issueGraphNode(issueNumber) {
      if (nodes.has(issueNumber)) return nodes.get(issueNumber) ?? null;
      wanted ??= { kind: "node", number: issueNumber };
      return null;
    },
    featureIntegrationPr(featureIssueNumber) {
      if (prs.has(featureIssueNumber)) return prs.get(featureIssueNumber) ?? null;
      wanted ??= { kind: "pr", number: featureIssueNumber };
      return null;
    },
  };

  const memberships = new Map<number, FeatureMembership>();
  for (const issueNumber of deps.issueNumbers) {
    // The floor: an issue whose walk somehow never settles is unaffiliated, not
    // a finding. Overwritten by the real answer on the replay that gets one.
    memberships.set(issueNumber, { state: "none" });
    // One node read per ancestor, plus the starting issue, plus the feature's
    // integration PR, plus the replay that finally answers.
    for (let replay = 0; replay <= MAX_FEATURE_ANCESTOR_DEPTH + 2; replay++) {
      wanted = null;
      const membership = resolveFeatureMembership(issueNumber, reader, deps.walk);
      if (wanted === null) {
        memberships.set(issueNumber, membership);
        break;
      }
      const want: { kind: "node" | "pr"; number: number } = wanted;
      if (want.kind === "node") {
        nodes.set(want.number, await deps.source.issueGraphNode(want.number));
      } else {
        prs.set(want.number, await deps.source.featureIntegrationPr(want.number));
      }
    }
  }
  return memberships;
}
