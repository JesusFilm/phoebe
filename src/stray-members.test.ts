// Stray members (#487): the four shapes a retired feature leaves behind, the
// member of a live feature that is not one of them, and the replay that drives
// the synchronous membership walk from an async source.

import { describe, expect, test } from "vite-plus/test";
import { asPrNumber } from "./branded.ts";
import { resolveConfig } from "./config-schema.ts";
import {
  featureBranch,
  type FeatureMembership,
  type FeatureWalkConfig,
  type IntegrationPr,
  type IssueGraphNode,
} from "./feature-branch.ts";
import { readMemberships, scanStrayMembers, type FeatureGraphSource } from "./stray-members.ts";
import { config as sampleUserConfig } from "../phoebe.config.ts";

const resolved = resolveConfig(sampleUserConfig);
const WALK: FeatureWalkConfig = {
  featureLabel: resolved.featureLabel,
  branchPrefix: resolved.branchPrefix,
  partOfPattern: resolved.partOfPattern,
};
const WATCHED = [
  resolved.readyLabel,
  resolved.researchLabel,
  resolved.processingLabel,
  resolved.mergedLabel,
];

const feature = { issueNumber: 448, title: "Feature-member lifecycle", branch: featureBranch(448) };

const live: FeatureMembership = { state: "live", feature };
const merged: FeatureMembership = { state: "retired", feature, end: "merged" };
const cancelled: FeatureMembership = { state: "retired", feature, end: "cancelled" };

function scan(
  issues: ReadonlyArray<{ number: number; title: string; labels: string[] }>,
  membershipOf: Record<number, FeatureMembership>,
) {
  return scanStrayMembers({
    issues,
    watched: WATCHED,
    membership: (n) => membershipOf[n] ?? { state: "none" },
  });
}

describe("scanStrayMembers", () => {
  test("reports mergedLabel surviving a merged integration PR", () => {
    const [stray] = scan([{ number: 20, title: "Landed member", labels: [resolved.mergedLabel] }], {
      20: merged,
    });
    expect(stray?.issueNumber).toBe(20);
    expect(stray?.labels).toEqual([resolved.mergedLabel]);
    expect(stray?.end).toBe("merged");
    expect(stray?.hint).toBe("close #20");
  });

  test("reports a member left processing by a PR that merged after the integration PR", () => {
    const [stray] = scan(
      [{ number: 21, title: "Late member", labels: [resolved.processingLabel] }],
      { 21: merged },
    );
    expect(stray?.labels).toEqual([resolved.processingLabel]);
    expect(stray?.end).toBe("merged");
  });

  test("reports a member left processing by a PR that merged into a blocker's branch", () => {
    // Indistinguishable from outside — an open issue, the processing label, a
    // feature that has ended — which is why the check reports rather than repairs.
    const [stray] = scan(
      [{ number: 22, title: "Stacked member", labels: [resolved.processingLabel] }],
      { 22: merged },
    );
    expect(stray?.issueNumber).toBe(22);
    expect(stray?.hint).toBe("close #22");
  });

  test("reports any lifecycle or selection label on a member of a cancelled feature", () => {
    const strays = scan(
      [
        { number: 30, title: "Selected", labels: [resolved.readyLabel] },
        { number: 31, title: "Researching", labels: [resolved.researchLabel] },
        { number: 32, title: "Working", labels: [resolved.processingLabel] },
        { number: 33, title: "Landed", labels: [resolved.mergedLabel] },
      ],
      { 30: cancelled, 31: cancelled, 32: cancelled, 33: cancelled },
    );
    expect(strays.map((s) => s.issueNumber)).toEqual([30, 31, 32, 33]);
    expect(strays[0]?.hint).toBe(
      `close #30, or strip "${resolved.readyLabel}" to re-route it onto the default branch`,
    );
  });

  test("names the member and the feature on every finding", () => {
    const [stray] = scan([{ number: 20, title: "Landed member", labels: [resolved.mergedLabel] }], {
      20: merged,
    });
    expect(stray?.issueTitle).toBe("Landed member");
    expect(stray?.featureIssueNumber).toBe(448);
    expect(stray?.featureTitle).toBe("Feature-member lifecycle");
  });

  test("names every watched label a stray wears, once", () => {
    const [stray] = scan(
      [
        {
          number: 40,
          title: "Two hats",
          labels: [resolved.processingLabel, resolved.mergedLabel],
        },
      ],
      { 40: cancelled },
    );
    expect(stray?.labels).toEqual([resolved.processingLabel, resolved.mergedLabel]);
    expect(stray?.hint).toContain(
      `strip "${resolved.processingLabel}" and "${resolved.mergedLabel}"`,
    );
  });

  test("reports nothing for a member of a live feature, whatever it is wearing", () => {
    expect(
      scan(
        [
          { number: 50, title: "Selected", labels: [resolved.readyLabel] },
          { number: 51, title: "Working", labels: [resolved.processingLabel] },
          { number: 52, title: "Landed", labels: [resolved.mergedLabel] },
        ],
        { 50: live, 51: live, 52: live },
      ),
    ).toEqual([]);
  });

  test("reports nothing for an issue that belongs to no feature", () => {
    expect(scan([{ number: 60, title: "Ordinary", labels: [resolved.readyLabel] }], {})).toEqual(
      [],
    );
  });

  test("reports nothing for an issue wearing no label Phoebe reads", () => {
    expect(
      scan([{ number: 61, title: "Quiet", labels: ["bug", "wontfix"] }], { 61: merged }),
    ).toEqual([]);
  });

  test("says a label once when a tenant points two fields at the same name", () => {
    const [stray] = scanStrayMembers({
      issues: [{ number: 70, title: "One hat", labels: ["busy"] }],
      watched: ["busy", "busy"],
      membership: () => cancelled,
    });
    expect(stray?.labels).toEqual(["busy"]);
  });
});

type NodeSpec = Partial<IssueGraphNode> & { number: number };

function sourceOver(
  nodes: readonly NodeSpec[],
  prs: Record<number, IntegrationPr> = {},
): FeatureGraphSource & { reads: string[] } {
  const byNumber = new Map(
    nodes.map((spec) => [
      spec.number,
      { title: "", labels: [], body: "", closed: false, parentNumber: null, ...spec },
    ]),
  );
  const reads: string[] = [];
  return {
    reads,
    async issueGraphNode(issueNumber) {
      reads.push(`issue:${issueNumber}`);
      return byNumber.get(issueNumber) ?? null;
    },
    async featureIntegrationPr(featureIssueNumber) {
      reads.push(`pr:${featureIssueNumber}`);
      return { pr: prs[featureIssueNumber] ?? null };
    },
  };
}

describe("readMemberships", () => {
  test("climbs to the feature parent, one read per node", async () => {
    const source = sourceOver(
      [
        { number: 20, parentNumber: 10 },
        { number: 10, parentNumber: 1 },
        { number: 1, title: "Map", labels: [WALK.featureLabel] },
      ],
      { 1: { number: asPrNumber(99), state: "MERGED" } },
    );
    const memberships = await readMemberships({ issueNumbers: [20], source, walk: WALK });
    expect(memberships.get(20)).toEqual({
      state: "retired",
      feature: {
        issueNumber: 1,
        title: "Map",
        branch: featureBranch(1, WALK.branchPrefix),
        integrationPrNumber: 99,
      },
      end: "merged",
    });
    expect(source.reads).toEqual(["issue:20", "issue:10", "issue:1", "pr:1"]);
  });

  test("siblings share the ancestors and the integration PR read", async () => {
    const source = sourceOver([
      { number: 20, parentNumber: 1 },
      { number: 21, parentNumber: 1 },
      { number: 1, labels: [WALK.featureLabel] },
    ]);
    await readMemberships({ issueNumbers: [20, 21], source, walk: WALK });
    expect(source.reads).toEqual(["issue:20", "issue:1", "pr:1", "issue:21"]);
  });

  test("follows a hand-authored `Part of` line when there is no native parent", async () => {
    const source = sourceOver([
      { number: 20, body: "Part of #1" },
      { number: 1, labels: [WALK.featureLabel] },
    ]);
    const memberships = await readMemberships({ issueNumbers: [20], source, walk: WALK });
    expect(memberships.get(20)?.state).toBe("live");
  });

  test("an unreadable node leaves the issue unaffiliated rather than a finding", async () => {
    const source = sourceOver([{ number: 20, parentNumber: 10 }]);
    const memberships = await readMemberships({ issueNumbers: [20], source, walk: WALK });
    expect(memberships.get(20)).toEqual({ state: "none" });
  });

  test("answers every issue it was given", async () => {
    const source = sourceOver([{ number: 20 }, { number: 21 }]);
    const memberships = await readMemberships({ issueNumbers: [20, 21], source, walk: WALK });
    expect([...memberships.keys()]).toEqual([20, 21]);
  });
});
