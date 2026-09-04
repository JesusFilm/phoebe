// Sweep scoping (#418): which tracker objects a pipeline's sweeps may touch.

import { describe, expect, test } from "vite-plus/test";
import { sweepScope } from "./sweep-scope.ts";

const RESEARCH = "research";

describe("sweepScope", () => {
  test("a pipeline of issue producers sweeps issues and no PRs", () => {
    const scope = sweepScope(["issues", "research"], RESEARCH);
    expect(scope.issues).toBe(true);
    expect(scope.prs).toBe(false);
  });

  test("a pipeline of PR janitors sweeps PRs and no issues", () => {
    const scope = sweepScope(["conflicts", "checks", "reviews"], RESEARCH);
    expect(scope.issues).toBe(false);
    expect(scope.prs).toBe(true);
  });

  // The acceptance case: a pipeline that schedules no issue kind must not touch an
  // issue, whatever the sweep would otherwise have found.
  test("a pipeline that schedules no issue kind owns no issue", () => {
    const scope = sweepScope(["conflicts"], RESEARCH);
    expect(scope.ownsIssue([])).toBe(false);
    expect(scope.ownsIssue([RESEARCH])).toBe(false);
  });

  test("a pipeline of custom kinds alone sweeps nothing", () => {
    const scope = sweepScope(["nudge", "digest"], RESEARCH);
    expect(scope.issues).toBe(false);
    expect(scope.prs).toBe(false);
  });

  test("an empty pipeline sweeps nothing", () => {
    const scope = sweepScope([], RESEARCH);
    expect(scope.issues).toBe(false);
    expect(scope.prs).toBe(false);
  });

  // The partition that matters: two pipelines split the issue producers between
  // them, and each re-arms only what it works. Neither can re-arm a ticket the
  // other has an agent on.
  describe("the issue producers partition by the research label", () => {
    const work = sweepScope(["issues"], RESEARCH);
    const wayfinder = sweepScope(["research"], RESEARCH);

    test("a ready ticket belongs to the pipeline that schedules `issues`", () => {
      expect(work.ownsIssue(["ready-for-agent"])).toBe(true);
      expect(wayfinder.ownsIssue(["ready-for-agent"])).toBe(false);
    });

    test("a research ticket belongs to the pipeline that schedules `research`", () => {
      expect(work.ownsIssue(["ready-for-agent", RESEARCH])).toBe(false);
      expect(wayfinder.ownsIssue(["ready-for-agent", RESEARCH])).toBe(true);
    });
  });

  test("a pipeline scheduling both producers owns both shapes of ticket", () => {
    const scope = sweepScope(["issues", "research"], RESEARCH);
    expect(scope.ownsIssue([])).toBe(true);
    expect(scope.ownsIssue([RESEARCH])).toBe(true);
  });

  test("the research label is the tenant's, not a hardcoded word", () => {
    const scope = sweepScope(["research"], "wayfinder");
    expect(scope.ownsIssue(["wayfinder"])).toBe(true);
    expect(scope.ownsIssue(["research"])).toBe(false);
  });
});
