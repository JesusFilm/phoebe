// Feature membership (#378): the walk up the issue graph to the nearest
// opted-in ancestor, the `Part of #M` fallback, and the liveness question that
// retires a feature. The reader is a plain object here — the walk is pure over
// what GitHub said, and the engine's memoizing implementation is covered in
// src/cycle-work-source.test.ts.

import { describe, expect, test } from "vite-plus/test";
import { asPrNumber } from "./branded.ts";
import { resolveConfig } from "./config-schema.ts";
import {
  featureBranch,
  parsePartOf,
  resolveFeature,
  type FeatureGraphReader,
  type IntegrationPr,
  type IssueGraphNode,
} from "./feature-branch.ts";
import { config as sampleUserConfig } from "../phoebe.config.ts";
import { setResolvedConfig } from "./resolved-config.ts";

const FEATURE_LABEL = resolveConfig(sampleUserConfig).featureLabel;

type NodeSpec = Partial<IssueGraphNode> & { number: number };

function node(spec: NodeSpec): IssueGraphNode {
  return {
    labels: [],
    body: "",
    closed: false,
    parentNumber: null,
    ...spec,
  };
}

type ReaderOpts = {
  integrationPrs?: Record<number, IntegrationPr>;
  /** Issue numbers whose graph node cannot be read. */
  unreadableNodes?: readonly number[];
  /** Feature numbers whose integration PR cannot be read. */
  unreadablePrs?: readonly number[];
};

/** A reader over a fixed graph, recording every issue read so walk cost is observable. */
function readerOver(
  nodes: readonly NodeSpec[],
  opts: ReaderOpts = {},
): FeatureGraphReader & { reads: number[] } {
  const byNumber = new Map(nodes.map((spec) => [spec.number, node(spec)]));
  const reads: number[] = [];
  return {
    reads,
    issueGraphNode(issueNumber) {
      reads.push(issueNumber);
      if (opts.unreadableNodes?.includes(issueNumber)) return null;
      return byNumber.get(issueNumber) ?? null;
    },
    featureIntegrationPr(featureIssueNumber) {
      if (opts.unreadablePrs?.includes(featureIssueNumber)) return null;
      return { pr: opts.integrationPrs?.[featureIssueNumber] ?? null };
    },
  };
}

describe("featureBranch", () => {
  test("derives the branch from the feature issue number, inside branchPrefix", () => {
    expect(featureBranch(341)).toBe("phoebe/feature-341");
  });
});

describe("parsePartOf", () => {
  test("reads the first `Part of #M` in a body", () => {
    expect(parsePartOf("Part of #341.\n\n## Problem\n\nPart of #999 elsewhere.")).toBe(341);
  });

  test("is case-insensitive and tolerates extra whitespace", () => {
    expect(parsePartOf("part of   #7")).toBe(7);
  });

  test("is null when the body declares nothing", () => {
    expect(parsePartOf("Blocked by #12")).toBeNull();
  });

  test("honours a configured pattern", () => {
    const base = resolveConfig(sampleUserConfig);
    setResolvedConfig({ ...base, partOfPattern: String.raw`Belongs to\s+#(\d+)` });
    try {
      expect(parsePartOf("Belongs to #55")).toBe(55);
      expect(parsePartOf("Part of #55")).toBeNull();
    } finally {
      setResolvedConfig(base);
    }
  });
});

describe("resolveFeature", () => {
  test("resolves the immediate parent when it carries the feature label", () => {
    const reader = readerOver([
      { number: 10, parentNumber: 1 },
      { number: 1, labels: [FEATURE_LABEL] },
    ]);
    expect(resolveFeature(10, reader)).toEqual({
      issueNumber: 1,
      branch: "phoebe/feature-1",
    });
  });

  test("climbs past an unlabelled parent to the nearest opted-in ancestor", () => {
    // The silent split this arm exists to prevent: stopping at #10 would land
    // #20 on the default branch while its siblings land on the feature branch.
    const reader = readerOver([
      { number: 20, parentNumber: 10 },
      { number: 10, parentNumber: 1 },
      { number: 1, labels: [FEATURE_LABEL] },
    ]);
    expect(resolveFeature(20, reader)?.issueNumber).toBe(1);
  });

  test("stops at the *nearest* opted-in ancestor when two are labelled", () => {
    const reader = readerOver([
      { number: 20, parentNumber: 10 },
      { number: 10, labels: [FEATURE_LABEL], parentNumber: 1 },
      { number: 1, labels: [FEATURE_LABEL] },
    ]);
    expect(resolveFeature(20, reader)?.issueNumber).toBe(10);
  });

  test("is null under a map with no feature label", () => {
    const reader = readerOver([
      { number: 20, parentNumber: 10 },
      { number: 10, labels: ["wayfinder:map"] },
    ]);
    expect(resolveFeature(20, reader)).toBeNull();
  });

  test("is null for an issue with no parent at all", () => {
    expect(resolveFeature(20, readerOver([{ number: 20 }]))).toBeNull();
  });

  test("reads `Part of #M` when there is no native link", () => {
    const reader = readerOver([
      { number: 20, body: "Part of #1." },
      { number: 1, labels: [FEATURE_LABEL] },
    ]);
    expect(resolveFeature(20, reader)?.issueNumber).toBe(1);
  });

  test("the native link wins over a body declaration", () => {
    const reader = readerOver([
      { number: 20, parentNumber: 10, body: "Part of #1." },
      { number: 10, labels: [FEATURE_LABEL] },
      { number: 1, labels: [FEATURE_LABEL] },
    ]);
    expect(resolveFeature(20, reader)?.issueNumber).toBe(10);
  });

  test("carries the integration PR number when the feature has one open", () => {
    const reader = readerOver(
      [
        { number: 20, parentNumber: 1 },
        { number: 1, labels: [FEATURE_LABEL] },
      ],
      {
        integrationPrs: { 1: { number: asPrNumber(99), state: "OPEN" } },
      },
    );
    expect(resolveFeature(20, reader)?.integrationPrNumber).toBe(99);
  });

  test("is null once the integration PR has merged", () => {
    const reader = readerOver(
      [
        { number: 20, parentNumber: 1 },
        { number: 1, labels: [FEATURE_LABEL] },
      ],
      {
        integrationPrs: { 1: { number: asPrNumber(99), state: "MERGED" } },
      },
    );
    expect(resolveFeature(20, reader)).toBeNull();
  });

  test("is null once the integration PR has been closed — the cancel lever", () => {
    const reader = readerOver(
      [
        { number: 20, parentNumber: 1 },
        { number: 1, labels: [FEATURE_LABEL] },
      ],
      {
        integrationPrs: { 1: { number: asPrNumber(99), state: "CLOSED" } },
      },
    );
    expect(resolveFeature(20, reader)).toBeNull();
  });

  test("is null when the feature's parent issue is closed, PR or no PR", () => {
    const reader = readerOver([
      { number: 20, parentNumber: 1 },
      { number: 1, labels: [FEATURE_LABEL], closed: true },
    ]);
    expect(resolveFeature(20, reader)).toBeNull();
  });

  test("is live while the branch has no integration PR yet", () => {
    const reader = readerOver([
      { number: 20, parentNumber: 1 },
      { number: 1, labels: [FEATURE_LABEL] },
    ]);
    expect(resolveFeature(20, reader)?.branch).toBe("phoebe/feature-1");
  });

  test("treats an unreadable issue as unaffiliated rather than throwing", () => {
    const reader = readerOver(
      [
        { number: 20, parentNumber: 10 },
        { number: 10, parentNumber: 1 },
        { number: 1, labels: [FEATURE_LABEL] },
      ],
      { unreadableNodes: [10] },
    );
    expect(resolveFeature(20, reader)).toBeNull();
  });

  test("treats an unreadable integration PR as unaffiliated rather than assuming live", () => {
    // The read that answers "is this feature retired?" failed, so routing the
    // issue onto the branch would be a guess.
    const reader = readerOver(
      [
        { number: 20, parentNumber: 1 },
        { number: 1, labels: [FEATURE_LABEL] },
      ],
      { unreadablePrs: [1] },
    );
    expect(resolveFeature(20, reader)).toBeNull();
  });

  test("gives up rather than climbing forever when `Part of` lines form a cycle", () => {
    const reader = readerOver([
      { number: 20, body: "Part of #10" },
      { number: 10, body: "Part of #20" },
    ]);
    expect(resolveFeature(20, reader)).toBeNull();
    expect(reader.reads.length).toBeLessThan(5);
  });

  test("stops at the depth cap on a chain too deep to be a feature", () => {
    const chain: NodeSpec[] = [];
    for (let n = 1; n <= 12; n++) {
      chain.push({ number: n, parentNumber: n + 1 });
    }
    chain.push({ number: 13, labels: [FEATURE_LABEL] });
    expect(resolveFeature(1, readerOver(chain))).toBeNull();
  });
});
