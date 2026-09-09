// Tests for the on-demand label path in ./labels.ts: the write that creates a
// Phoebe-owned label the first time a repo needs it, and never again.

import { describe, expect, test } from "vite-plus/test";
import {
  addLabelCreatingIfMissing,
  mergedLabelOf,
  processingLabelOf,
  type LabelWriter,
} from "./labels.ts";
import { isLabelNotFoundError } from "./gh-error.ts";

/** What `gh issue edit --add-label` throws for a label the repo does not have. */
function labelNotFoundError(): Error {
  const err = new Error("gh failed") as Error & { stderr: string };
  err.stderr = "GraphQL: Label not found: bogus (addLabelsToLabelable)";
  return err;
}

/**
 * A writer over a repo that holds `existing` labels: an add for a label the
 * repo does not have fails the way GitHub fails it, and `createLabel` makes it
 * exist. Close enough to the real thing to tell a second call from a first.
 */
function repoWithLabels(existing: string[]): LabelWriter & { writes: string[] } {
  const labels = new Set(existing);
  const writes: string[] = [];
  return {
    writes,
    addIssueLabel(issueNumber, label) {
      if (!labels.has(label)) throw labelNotFoundError();
      writes.push(`add:${issueNumber}:${label}`);
    },
    createLabel(name, description) {
      labels.add(name);
      writes.push(`create:${name}:${description}`);
    },
  };
}

describe("addLabelCreatingIfMissing", () => {
  test("a label the repo already has is added with no create", () => {
    const repo = repoWithLabels(["processing"]);
    addLabelCreatingIfMissing(
      repo,
      42,
      processingLabelOf({ processingLabel: "processing" }),
      () => {},
    );
    expect(repo.writes).toEqual(["add:42:processing"]);
  });

  test("mergedLabel is created on demand, and a second call creates nothing (#484)", () => {
    const repo = repoWithLabels([]);
    const label = mergedLabelOf({ mergedLabel: "merged-to-feature" });
    const logs: string[] = [];

    addLabelCreatingIfMissing(repo, 7, label, (line) => logs.push(line));
    addLabelCreatingIfMissing(repo, 8, label, (line) => logs.push(line));

    expect(repo.writes).toEqual([
      `create:merged-to-feature:${label.description}`,
      "add:7:merged-to-feature",
      "add:8:merged-to-feature",
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/merged-to-feature/);
  });

  test("the created label's description names its own role, not the other's", () => {
    const merged = mergedLabelOf({ mergedLabel: "merged-to-feature" });
    const processing = processingLabelOf({ processingLabel: "processing" });
    expect(merged.description).not.toBe(processing.description);
    expect(merged.description).toMatch(/feature branch/);
    expect(processing.description).toMatch(/working/);
  });

  test("a tenant's own label names are what gets created", () => {
    const repo = repoWithLabels([]);
    addLabelCreatingIfMissing(repo, 3, mergedLabelOf({ mergedLabel: "landed" }), () => {});
    expect(repo.writes[0]).toMatch(/^create:landed:/);
  });

  test("a failure that is not a missing label propagates, uncreated", () => {
    let creates = 0;
    const repo: LabelWriter = {
      addIssueLabel: () => {
        throw new Error("GitHub 403: permission not granted");
      },
      createLabel: () => {
        creates++;
      },
    };
    expect(() =>
      addLabelCreatingIfMissing(repo, 9, mergedLabelOf({ mergedLabel: "landed" }), () => {}),
    ).toThrow(/403/);
    expect(creates).toBe(0);
  });

  test("a concurrent create by another process still lets the add through", () => {
    const repo = repoWithLabels([]);
    const realCreate = repo.createLabel.bind(repo);
    let calls = 0;
    repo.createLabel = (name, description) => {
      calls++;
      // Another process creates the label first, so ours races and loses.
      realCreate(name, description);
      const err = new Error("gh failed") as Error & { stderr: string };
      err.stderr = `GraphQL: Label already exists (createLabel): ${name}`;
      throw err;
    };
    const logs: string[] = [];

    addLabelCreatingIfMissing(repo, 11, mergedLabelOf({ mergedLabel: "landed" }), (line) =>
      logs.push(line),
    );

    expect(calls).toBe(1);
    expect(repo.writes).toContain("add:11:landed");
    expect(logs.some((line) => /already exists/.test(line))).toBe(true);
  });

  test("a retry that still fails propagates the label-not-found error", () => {
    const repo: LabelWriter = {
      addIssueLabel: () => {
        throw labelNotFoundError();
      },
      createLabel: () => {},
    };
    let thrown: unknown;
    try {
      addLabelCreatingIfMissing(repo, 9, mergedLabelOf({ mergedLabel: "landed" }), () => {});
    } catch (err) {
      thrown = err;
    }
    expect(isLabelNotFoundError(thrown)).toBe(true);
  });
});
