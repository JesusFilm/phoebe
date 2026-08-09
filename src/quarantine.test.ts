// One quarantine façade (#68): the trigger-scoped marker/comment builders,
// the escalation-comment text, the read-only backoff/auto-unstick helpers
// that stay importable without the façade, and `createQuarantine`'s
// `record`/`resolve` behavior against a fake `GitHub` — one tracking comment
// per unit, up to two trigger sections, the manual-clear reset, and the
// write-failure swallow. Threshold resolution (`maxUnitTimeouts`/
// `maxUnitAttempts` config defaults + their `PHOEBE_*` overlay) lives at the
// config layer (#56) — see src/load-config.test.ts.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "./branded.ts";
import type { ActivityComment, GitHub } from "./github.ts";
import {
  buildQuarantineComment,
  createQuarantine,
  filterBackoffEligible,
  findEscalatedSections,
  findLatestUnitAttemptComment,
  parseQuarantineBaseline,
  PHOEBE_QUARANTINE_LABEL,
  shouldAutoUnstick,
  slugifyFailureSignature,
  type UnitMarker,
} from "./quarantine.ts";
import { isPrInScope } from "./pr-scope.ts";
import { selectIssue } from "./kinds/producer.ts";
import type { UnitRef } from "./kinds/kind.ts";
import type { Issue } from "./stack.ts";

describe("buildQuarantineComment", () => {
  test("names the label and the reason with the actual count", () => {
    const comment = buildQuarantineComment({
      kind: "issues",
      id: 42,
      k: 3,
      baseline: "abc123",
      reason: "timed out",
    });
    expect(comment).toContain(PHOEBE_QUARANTINE_LABEL);
    expect(comment).toContain("timed out 3 times");
    expect(parseQuarantineBaseline(comment)).toBe("abc123");
  });

  test("carries the last failure signature for a no-commit trigger (#25)", () => {
    const comment = buildQuarantineComment({
      kind: "conflicts",
      id: 1043,
      k: 3,
      baseline: "deadbeef",
      reason: "produced no commit",
      signature: "mergeable-conflicting",
    });
    expect(comment).toContain("produced no commit 3 times");
    expect(comment).toContain("mergeable-conflicting");
  });

  test("names the blocked dependents for the issue-keyed no-PR trigger (#22)", () => {
    const comment = buildQuarantineComment({
      kind: "issues",
      id: 784,
      k: 3,
      baseline: "2026-08-01T00:00:00Z",
      reason: "was claimed and released with no PR",
      signature: "apply-patch-failed",
      dependents: [763, 700],
    });
    expect(comment).toContain("was claimed and released with no PR 3 times");
    expect(comment).toContain("apply-patch-failed");
    expect(comment).toContain("#763");
    expect(comment).toContain("#700");
  });

  test("omits the dependents line when there are none", () => {
    const comment = buildQuarantineComment({
      kind: "issues",
      id: 784,
      k: 3,
      baseline: "2026-08-01T00:00:00Z",
      reason: "was claimed and released with no PR",
      signature: "apply-patch-failed",
      dependents: [],
    });
    expect(comment).not.toContain("keeps");
  });
});

describe("shouldAutoUnstick", () => {
  test("PR unit clears when head SHA advanced past baseline", () => {
    expect(shouldAutoUnstick({ baseline: "aaa", currentHeadSha: asSha("bbb") })).toBe(true);
    expect(shouldAutoUnstick({ baseline: "aaa", currentHeadSha: asSha("aaa") })).toBe(false);
  });
  test("issue unit clears when lastEditedAt is newer than baseline", () => {
    const baseline = "2026-07-31T12:00:00Z";
    expect(shouldAutoUnstick({ baseline, currentIssueEditedAt: "2026-07-31T13:00:00Z" })).toBe(
      true,
    );
    expect(shouldAutoUnstick({ baseline, currentIssueEditedAt: "2026-07-31T11:00:00Z" })).toBe(
      false,
    );
  });
  test("no content signal → stays quarantined (a bare comment can't re-arm)", () => {
    expect(shouldAutoUnstick({ baseline: "aaa" })).toBe(false);
  });
});

describe("selection excludes quarantined units", () => {
  test("a quarantined PR is out of scope", () => {
    const pr = {
      headRefName: asBranchRef("phoebe/issue-1"),
      authorLogin: "phoebe-bot",
      isDraft: false,
      isCrossRepository: false,
      labels: [PHOEBE_QUARANTINE_LABEL],
    };
    expect(
      isPrInScope(pr, {
        branchPrefix: "phoebe/",
        prScope: "phoebe",
        prAuthors: [],
        draftPrs: "skip-non-phoebe",
        prOptOutLabel: "ready-for-human",
      }),
    ).toBe(false);
  });

  test("a quarantined issue is not selected", () => {
    const issue = (over: Partial<Issue>): Issue => ({
      number: 1,
      title: "t",
      body: "",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      ...over,
    });
    const issues = [
      issue({ number: 1, labels: [PHOEBE_QUARANTINE_LABEL] }),
      issue({ number: 2, labels: [] }),
    ];
    const picked = selectIssue(
      issues,
      new Map(),
      {
        blockedByPattern: "[Bb]locked by #(\\d+)",
        blockerSource: "body",
        branchPrefix: "phoebe/",
        stackMode: "banner",
      },
      "priority:",
    );
    expect(picked?.issue.number).toBe(2);
  });
});

describe("findLatestUnitAttemptComment (trigger-aware)", () => {
  test("finds the newest kind+trigger marker and its comment id", () => {
    const comments = [
      {
        id: "IC_1",
        body: "<!-- phoebe-unit:conflicts:no-commit n=1 sig=sig-a ref=sha1 at=2026-08-04T10:00:00.000Z -->",
      },
      { id: "IC_2", body: "unrelated human comment" },
    ];
    const found = findLatestUnitAttemptComment(comments, "conflicts", "no-commit");
    expect(found?.commentId).toBe("IC_1");
    expect(found?.marker).toEqual({
      trigger: "no-commit",
      n: 1,
      signature: "sig-a",
      ref: "sha1",
      at: "2026-08-04T10:00:00.000Z",
    });
  });

  test("ignores a marker for a different kind", () => {
    const comments = [
      {
        id: "IC_1",
        body: "<!-- phoebe-unit:checks:no-commit n=1 sig=sig-a ref=sha1 at=2026-08-04T10:00:00.000Z -->",
      },
    ];
    expect(findLatestUnitAttemptComment(comments, "conflicts", "no-commit")).toBeNull();
  });

  test("ignores a marker for a different trigger on the same kind", () => {
    const comments = [
      {
        id: "IC_1",
        body: "<!-- phoebe-unit:issues:timed-out n=1 sig=timeout ref=42 at=2026-08-04T10:00:00.000Z -->",
      },
    ];
    expect(findLatestUnitAttemptComment(comments, "issues", "no-pr")).toBeNull();
  });

  test("returns null with no comments", () => {
    expect(findLatestUnitAttemptComment([], "conflicts", "no-commit")).toBeNull();
  });
});

describe("slugifyFailureSignature", () => {
  test("lowercases and hyphenates", () => {
    expect(slugifyFailureSignature("Mergeable CONFLICTING")).toBe("mergeable-conflicting");
  });
  test("falls back to unknown for empty input", () => {
    expect(slugifyFailureSignature("")).toBe("unknown");
  });
  test("truncates to maxLen", () => {
    expect(slugifyFailureSignature("a".repeat(200), 10)).toBe("a".repeat(10));
  });
});

describe("filterBackoffEligible", () => {
  const now = "2026-08-04T12:00:00.000Z";
  const marker = (n: number, at: string): UnitMarker => ({
    trigger: "no-commit",
    n,
    signature: "s",
    ref: "sha1",
    at,
  });

  test("a candidate with no attempt marker is always eligible", () => {
    const candidates = [{ attemptMarker: null }];
    expect(filterBackoffEligible(candidates, now)).toEqual(candidates);
  });

  test("drops a candidate still inside its backoff window", () => {
    const candidates = [{ prNumber: 1, attemptMarker: marker(1, "2026-08-04T11:59:00.000Z") }];
    expect(filterBackoffEligible(candidates, now)).toEqual([]);
  });

  test("keeps a candidate once its backoff window has elapsed", () => {
    const candidates = [{ prNumber: 1, attemptMarker: marker(1, "2026-08-04T11:00:00.000Z") }];
    expect(filterBackoffEligible(candidates, now)).toEqual(candidates);
  });
});

// --- createQuarantine — the write façade -------------------------------------

type FakeComment = ActivityComment;

function createFakeGithub(
  opts: {
    login?: string;
    comments?: FakeComment[];
    labels?: string[];
    updatedAt?: string;
    headRefOid?: string;
    lastCommitAt?: string | null;
  } = {},
): { github: GitHub; state: { comments: FakeComment[]; labels: string[] } } {
  const state = {
    comments: opts.comments ? [...opts.comments] : [],
    labels: opts.labels ? [...opts.labels] : [],
  };
  const login = opts.login ?? "phoebe-bot";
  let nextId = 1000;
  const post = (body: string): void => {
    state.comments.push({
      id: `posted-${nextId++}`,
      body,
      createdAt: "2026-01-05T00:00:00Z",
      authorLogin: login,
    });
  };
  const github: GitHub = {
    issuesWithLabel: () => [],
    issueBody: () => "",
    issueActivity: () => ({
      updatedAt: opts.updatedAt ?? "2026-01-01T00:00:00Z",
      comments: state.comments,
      labels: state.labels,
    }),
    nativeBlockers: () => [],
    prNumberForHead: () => undefined,
    openPrs: () => [],
    prsWithLabel: () => [],
    prMergeInfo: () => {
      throw new Error("not implemented in fake");
    },
    prActivity: () => ({
      headRefOid: asSha(opts.headRefOid ?? "sha-1"),
      lastCommitAt: opts.lastCommitAt ?? null,
      comments: state.comments,
      labels: state.labels,
    }),
    reviewThreads: () => [],
    commitCheckRuns: () => [],
    commentIssue: (_n, body) => post(body),
    commentPr: (_n, body) => post(body),
    createPr: () => {},
    retargetPr: () => {},
    labelIssue: (_n, label) => {
      if (!state.labels.includes(label)) state.labels.push(label);
    },
    unlabelIssue: (_n, label) => {
      state.labels = state.labels.filter((l) => l !== label);
    },
    labelPr: (_n, label) => {
      if (!state.labels.includes(label)) state.labels.push(label);
    },
    unlabelPr: (_n, label) => {
      state.labels = state.labels.filter((l) => l !== label);
    },
    linkStack: () => {},
    installStackExtension: () => {},
    login: () => login,
    updateComment: (id, body) => {
      const comment = state.comments.find((c) => c.id === id);
      if (comment) comment.body = body;
    },
  };
  return { github, state };
}

const noteThreshold = (n: number, k: number): string => `attempt ${n}/${k}`;

describe("createQuarantine — record()", () => {
  test("first failure posts one new tracking comment, below threshold", () => {
    const { github, state } = createFakeGithub();
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.record({ kind: "checks", target: { type: "pr", number: 10 } }, "no-commit", {
      signature: "checks-failed",
      reason: "produced no commit",
      belowThresholdNote: noteThreshold,
    });
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]!.body).toContain("attempt 1/3");
    expect(state.comments[0]!.body).toContain(
      "<!-- phoebe-unit:checks:no-commit n=1 sig=checks-failed ref=sha-1 at=",
    );
    expect(state.labels).toEqual([]);
  });

  test("a second failure with the same ref edits the same comment in place, incrementing n", () => {
    const { github, state } = createFakeGithub();
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    const unit: UnitRef = { kind: "checks", target: { type: "pr", number: 10 } };
    const detail = {
      signature: "checks-failed",
      reason: "produced no commit",
      belowThresholdNote: noteThreshold,
    };
    quarantine.record(unit, "no-commit", detail);
    quarantine.record(unit, "no-commit", detail);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]!.body).toContain("attempt 2/3");
    expect(state.comments[0]!.body).toContain("n=2");
  });

  test("crossing the threshold labels the unit and escalates with the baseline marker", () => {
    const { github, state } = createFakeGithub();
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    const unit: UnitRef = { kind: "checks", target: { type: "pr", number: 10 } };
    const detail = {
      signature: "checks-failed",
      reason: "produced no commit",
      belowThresholdNote: noteThreshold,
    };
    quarantine.record(unit, "no-commit", detail);
    quarantine.record(unit, "no-commit", detail);
    quarantine.record(unit, "no-commit", detail);
    expect(state.comments).toHaveLength(1);
    expect(state.labels).toEqual([PHOEBE_QUARANTINE_LABEL]);
    expect(state.comments[0]!.body).toContain("produced no commit 3 times");
    expect(parseQuarantineBaseline(state.comments[0]!.body)).toBe("sha-1");
  });

  test("two triggers on the same unit share one tracking comment, each section preserved", () => {
    const { github, state } = createFakeGithub();
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    const unit: UnitRef = { kind: "issues", target: { type: "issue", number: 42 } };
    quarantine.record(unit, "timed-out", {
      signature: "timeout",
      reason: "timed out",
      belowThresholdNote: () => "",
    });
    quarantine.record(unit, "no-pr", {
      signature: "apply-patch-failed",
      reason: "was claimed and released with no PR",
      belowThresholdNote: noteThreshold,
    });
    expect(state.comments).toHaveLength(1);
    const body = state.comments[0]!.body;
    expect(body).toContain("phoebe-unit:issues:timed-out n=1");
    expect(body).toContain("phoebe-unit:issues:no-pr n=1");
    expect(body).toContain("attempt 1/3");
  });

  test("timed-out resets when a foreign comment lands after the marker's own timestamp", () => {
    const { github, state } = createFakeGithub({
      comments: [
        {
          id: "human1",
          body: "please look at this",
          createdAt: "2026-01-02T00:00:00Z",
          authorLogin: "human",
        },
        {
          id: "track1",
          body: "<!-- phoebe-unit:issues:timed-out n=2 sig=timeout ref=42 at=2026-01-01T00:00:00Z -->",
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: "phoebe-bot",
        },
      ],
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.record({ kind: "issues", target: { type: "issue", number: 42 } }, "timed-out", {
      signature: "timeout",
      reason: "timed out",
      belowThresholdNote: () => "",
    });
    const track = state.comments.find((c) => c.id === "track1")!;
    expect(track.body).toContain("n=1");
  });

  test("timed-out carries the prior count when no foreign activity is newer than the marker", () => {
    const { github, state } = createFakeGithub({
      comments: [
        { id: "human1", body: "old note", createdAt: "2025-12-31T00:00:00Z", authorLogin: "human" },
        {
          id: "track1",
          body: "<!-- phoebe-unit:issues:timed-out n=2 sig=timeout ref=42 at=2026-01-01T00:00:00Z -->",
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: "phoebe-bot",
        },
      ],
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.record({ kind: "issues", target: { type: "issue", number: 42 } }, "timed-out", {
      signature: "timeout",
      reason: "timed out",
      belowThresholdNote: () => "",
    });
    expect(state.comments.find((c) => c.id === "track1")!.body).toContain("n=3");
  });

  test("no-commit resets when the PR head SHA has moved since the marker", () => {
    const { github, state } = createFakeGithub({
      headRefOid: "sha-2",
      comments: [
        {
          id: "track1",
          body: "<!-- phoebe-unit:checks:no-commit n=2 sig=checks-failed ref=sha-1 at=2026-01-01T00:00:00Z -->",
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: "phoebe-bot",
        },
      ],
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.record({ kind: "checks", target: { type: "pr", number: 7 } }, "no-commit", {
      signature: "checks-failed",
      reason: "produced no commit",
      belowThresholdNote: () => "",
    });
    const body = state.comments.find((c) => c.id === "track1")!.body;
    expect(body).toContain("n=1");
    expect(body).toContain("ref=sha-2");
  });

  test("no-pr's ref (the issue number) never moves on its own — carries the count until resolve() clears it", () => {
    const { github, state } = createFakeGithub({
      comments: [
        {
          id: "track1",
          body: "<!-- phoebe-unit:issues:no-pr n=2 sig=apply-patch-failed ref=99 at=2026-01-01T00:00:00Z -->",
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: "phoebe-bot",
        },
      ],
    });
    const reported: unknown[] = [];
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
      report: (event) => reported.push(event),
    });
    quarantine.record({ kind: "issues", target: { type: "issue", number: 99 } }, "no-pr", {
      signature: "apply-patch-failed",
      reason: "was claimed and released with no PR",
      belowThresholdNote: () => "",
    });
    const body = state.comments.find((c) => c.id === "track1")!.body;
    expect(body).toContain("n=3");
    expect(state.labels).toContain(PHOEBE_QUARANTINE_LABEL);
    // Threshold reached — the one status-rail report replaces the bare log call (#70).
    expect(reported).toEqual([
      {
        kind: "unit-quarantined",
        work: { kind: "issues", issueNumber: 99 },
        reason: "was claimed and released with no PR 3 time(s) — labelled phoebe:quarantined",
      },
    ]);
  });

  test("record() at threshold for no-pr includes the dependents list in the escalation prose (#22)", () => {
    const { github, state } = createFakeGithub({
      comments: [
        {
          id: "track1",
          body: "<!-- phoebe-unit:issues:no-pr n=2 sig=apply-patch-failed ref=784 at=2026-01-01T00:00:00Z -->",
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: "phoebe-bot",
        },
      ],
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.record({ kind: "issues", target: { type: "issue", number: 784 } }, "no-pr", {
      signature: "apply-patch-failed",
      reason: "was claimed and released with no PR",
      belowThresholdNote: () => "",
      dependents: [763, 700],
    });
    const body = state.comments.find((c) => c.id === "track1")!.body;
    expect(body).toContain("#763");
    expect(body).toContain("#700");
  });

  test("a human removing the quarantine label resets that trigger's counter before recording the new failure", () => {
    const escalation = buildQuarantineComment({
      kind: "checks",
      id: 5,
      k: 3,
      baseline: "sha-1",
      reason: "produced no commit",
      signature: "checks-failed",
    });
    const { github, state } = createFakeGithub({
      headRefOid: "sha-1",
      labels: [],
      comments: [
        {
          id: "track1",
          body: `${escalation}\n\n<!-- phoebe-unit:checks:no-commit n=3 sig=checks-failed ref=sha-1 at=2026-01-01T00:00:00Z -->`,
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: "phoebe-bot",
        },
      ],
    });
    const reported: unknown[] = [];
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
      report: (event) => reported.push(event),
    });
    quarantine.record({ kind: "checks", target: { type: "pr", number: 5 } }, "no-commit", {
      signature: "checks-failed",
      reason: "produced no commit",
      belowThresholdNote: () => "note",
    });
    const body = state.comments.find((c) => c.id === "track1")!.body;
    expect(body).toContain("n=1");
    expect(state.labels).toEqual([]);
    // The manual clear is its own event (#70) — distinct from whatever this new attempt does.
    expect(reported).toEqual([
      {
        kind: "unit-unquarantined",
        work: { kind: "checks", pullRequestNumber: 5 },
        reason:
          "the phoebe:quarantined label was removed by hand — the no-commit counter reset to 0",
      },
    ]);
  });

  test("a GitHub write failure while recording is swallowed and logged, never thrown", () => {
    const { github } = createFakeGithub();
    const failing: GitHub = {
      ...github,
      commentPr: () => {
        throw new Error("boom");
      },
    };
    const logs: string[] = [];
    const quarantine = createQuarantine({
      github: failing,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: (m) => logs.push(m),
    });
    expect(() =>
      quarantine.record({ kind: "checks", target: { type: "pr", number: 1 } }, "no-commit", {
        signature: "s",
        reason: "produced no commit",
        belowThresholdNote: () => "note",
      }),
    ).not.toThrow();
    expect(logs.some((l) => l.includes("Could not record"))).toBe(true);
  });
});

describe("createQuarantine — resolve()", () => {
  test("clears the trigger's section, preserving a co-existing trigger's section", () => {
    const { github, state } = createFakeGithub({
      comments: [
        {
          id: "track1",
          body: [
            "<!-- phoebe-unit:issues:timed-out n=1 sig=timeout ref=99 at=2026-01-01T00:00:00Z -->",
            "",
            "some no-pr prose",
            "",
            "<!-- phoebe-unit:issues:no-pr n=2 sig=apply-patch-failed ref=99 at=2026-01-01T00:00:00Z -->",
          ].join("\n"),
          createdAt: "2026-01-01T00:00:00Z",
          authorLogin: "phoebe-bot",
        },
      ],
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.resolve(
      { kind: "issues", target: { type: "issue", number: 99 } },
      "no-pr",
      "counter reset",
    );
    const body = state.comments[0]!.body;
    expect(body).toContain("counter reset");
    expect(body).toContain("phoebe-unit:issues:timed-out n=1");
    expect(body).not.toContain("no-pr");
  });

  test("a unit with no tracking comment is a no-op", () => {
    const { github, state } = createFakeGithub();
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.resolve(
      { kind: "issues", target: { type: "issue", number: 1 } },
      "no-pr",
      "counter reset",
    );
    expect(state.comments).toHaveLength(0);
  });
});

// --- findEscalatedSections ---------------------------------------------------

describe("findEscalatedSections", () => {
  test("finds a section whose prose carries the baseline marker, kind and trigger read off the marker itself", () => {
    const escalation = buildQuarantineComment({
      kind: "checks",
      id: 5,
      k: 3,
      baseline: "sha-1",
      reason: "produced no commit",
    });
    const body = `${escalation}\n\n<!-- phoebe-unit:checks:no-commit n=3 sig=s ref=sha-1 at=2026-01-01T00:00:00Z -->`;
    expect(findEscalatedSections([{ body }])).toEqual([
      { kind: "checks", trigger: "no-commit", baseline: "sha-1" },
    ]);
  });

  test("skips a below-threshold section — its prose never carries the baseline marker", () => {
    const body =
      "attempt 1/3\n\n<!-- phoebe-unit:checks:no-commit n=1 sig=s ref=sha-1 at=2026-01-01T00:00:00Z -->";
    expect(findEscalatedSections([{ body }])).toEqual([]);
  });

  test("finds escalated sections across two different kinds' tracking comments", () => {
    const escalation1 = buildQuarantineComment({
      kind: "checks",
      id: 5,
      k: 3,
      baseline: "sha-1",
      reason: "produced no commit",
    });
    const escalation2 = buildQuarantineComment({
      kind: "conflicts",
      id: 5,
      k: 3,
      baseline: "sha-2",
      reason: "timed out",
    });
    const comments = [
      {
        body: `${escalation1}\n\n<!-- phoebe-unit:checks:no-commit n=3 sig=s ref=sha-1 at=2026-01-01T00:00:00Z -->`,
      },
      {
        body: `${escalation2}\n\n<!-- phoebe-unit:conflicts:timed-out n=3 sig=timeout ref=sha-2 at=2026-01-01T00:00:00Z -->`,
      },
    ];
    expect(findEscalatedSections(comments)).toEqual([
      { kind: "checks", trigger: "no-commit", baseline: "sha-1" },
      { kind: "conflicts", trigger: "timed-out", baseline: "sha-2" },
    ]);
  });
});

// --- createQuarantine — sweepUnstuck() ---------------------------------------

type MultiUnitState = { comments: ActivityComment[]; labels: string[] };

function createMultiUnitFakeGithub(
  opts: {
    issues?: Record<number, Partial<MultiUnitState> & { updatedAt?: string }>;
    prs?: Record<number, Partial<MultiUnitState> & { headRefOid?: string }>;
  } = {},
): {
  github: GitHub;
  issues: Map<number, MultiUnitState & { updatedAt: string }>;
  prs: Map<number, MultiUnitState & { headRefOid: string }>;
} {
  const issues = new Map(
    Object.entries(opts.issues ?? {}).map(([n, v]) => [
      Number(n),
      {
        comments: v.comments ? [...v.comments] : [],
        labels: v.labels ? [...v.labels] : [],
        updatedAt: v.updatedAt ?? "2026-01-01T00:00:00Z",
      },
    ]),
  );
  const prs = new Map(
    Object.entries(opts.prs ?? {}).map(([n, v]) => [
      Number(n),
      {
        comments: v.comments ? [...v.comments] : [],
        labels: v.labels ? [...v.labels] : [],
        headRefOid: v.headRefOid ?? "sha-1",
      },
    ]),
  );

  function updateComment(id: string, body: string): void {
    for (const unit of [...issues.values(), ...prs.values()]) {
      const comment = unit.comments.find((c) => c.id === id);
      if (comment) {
        comment.body = body;
        return;
      }
    }
  }

  const github: GitHub = {
    issuesWithLabel: (label) =>
      [...issues.entries()]
        .filter(([, s]) => s.labels.includes(label))
        .map(([number]) => ({
          number,
          title: "",
          body: "",
          createdAt: "2026-01-01T00:00:00Z",
          labels: [],
          authorLogin: "",
        })),
    issueBody: () => "",
    issueActivity: (n) => {
      const s = issues.get(n)!;
      return { updatedAt: s.updatedAt, comments: s.comments, labels: s.labels };
    },
    nativeBlockers: () => [],
    prNumberForHead: () => undefined,
    openPrs: () => [],
    prsWithLabel: (label) =>
      [...prs.entries()]
        .filter(([, s]) => s.labels.includes(label))
        .map(([number]) => ({
          number: asPrNumber(number),
          headRefName: asBranchRef("phoebe/issue-x"),
          baseRefName: asBranchRef("main"),
          isDraft: false,
          isCrossRepository: false,
          labels: [],
          authorLogin: "",
        })),
    prMergeInfo: () => {
      throw new Error("not implemented in fake");
    },
    prActivity: (n) => {
      const s = prs.get(n)!;
      return {
        headRefOid: asSha(s.headRefOid),
        lastCommitAt: null,
        comments: s.comments,
        labels: s.labels,
      };
    },
    reviewThreads: () => [],
    commitCheckRuns: () => [],
    commentIssue: () => {},
    commentPr: () => {},
    createPr: () => {},
    retargetPr: () => {},
    labelIssue: (n, label) => {
      const s = issues.get(n)!;
      if (!s.labels.includes(label)) s.labels.push(label);
    },
    unlabelIssue: (n, label) => {
      const s = issues.get(n)!;
      s.labels = s.labels.filter((l) => l !== label);
    },
    labelPr: (n, label) => {
      const s = prs.get(n)!;
      if (!s.labels.includes(label)) s.labels.push(label);
    },
    unlabelPr: (n, label) => {
      const s = prs.get(n)!;
      s.labels = s.labels.filter((l) => l !== label);
    },
    linkStack: () => {},
    installStackExtension: () => {},
    login: () => "phoebe-bot",
    updateComment,
  };
  return { github, issues, prs };
}

function escalatedTrackingComment(opts: {
  id: string;
  kind: string;
  trigger: UnitMarker["trigger"];
  issueOrPrNumber: number;
  baseline: string;
  ref: string;
  n?: number;
}): ActivityComment {
  const prose = buildQuarantineComment({
    kind: opts.kind,
    id: opts.issueOrPrNumber,
    k: 3,
    baseline: opts.baseline,
    reason: "produced no commit",
    signature: "sig",
  });
  const marker = `<!-- phoebe-unit:${opts.kind}:${opts.trigger} n=${opts.n ?? 3} sig=sig ref=${opts.ref} at=2026-01-01T00:00:00Z -->`;
  return {
    id: opts.id,
    body: `${prose}\n\n${marker}`,
    createdAt: "2026-01-01T00:00:00Z",
    authorLogin: "phoebe-bot",
  };
}

describe("createQuarantine — sweepUnstuck()", () => {
  test("a PR unit whose head SHA advanced past baseline is unlabelled and its counter reset", () => {
    const { github, prs } = createMultiUnitFakeGithub({
      prs: {
        7: {
          headRefOid: "sha-2",
          labels: [PHOEBE_QUARANTINE_LABEL],
          comments: [
            escalatedTrackingComment({
              id: "track1",
              kind: "checks",
              trigger: "no-commit",
              issueOrPrNumber: 7,
              baseline: "sha-1",
              ref: "sha-1",
            }),
          ],
        },
      },
    });
    const reported: unknown[] = [];
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
      report: (event) => reported.push(event),
    });
    quarantine.sweepUnstuck();
    const pr = prs.get(7)!;
    expect(pr.labels).toEqual([]);
    expect(pr.comments[0]!.body).not.toContain("phoebe-unit:checks:no-commit");
    // The auto-un-stick sweep is what emits unit-unquarantined (#70).
    expect(reported).toEqual([
      {
        kind: "unit-unquarantined",
        work: { kind: "checks", pullRequestNumber: 7 },
        reason: "the content advanced past the recorded baseline — auto-cleared",
      },
    ]);
  });

  test("an issue unit whose updatedAt advanced past baseline is unlabelled and its counter reset", () => {
    const { github, issues } = createMultiUnitFakeGithub({
      issues: {
        42: {
          updatedAt: "2026-02-01T00:00:00Z",
          labels: [PHOEBE_QUARANTINE_LABEL],
          comments: [
            escalatedTrackingComment({
              id: "track1",
              kind: "issues",
              trigger: "no-pr",
              issueOrPrNumber: 42,
              baseline: "2026-01-01T00:00:00Z",
              ref: "42",
            }),
          ],
        },
      },
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.sweepUnstuck();
    const issue = issues.get(42)!;
    expect(issue.labels).toEqual([]);
    expect(issue.comments[0]!.body).not.toContain("phoebe-unit:issues:no-pr");
  });

  test("a PR unit whose head SHA has not moved stays quarantined", () => {
    const { github, prs } = createMultiUnitFakeGithub({
      prs: {
        7: {
          headRefOid: "sha-1",
          labels: [PHOEBE_QUARANTINE_LABEL],
          comments: [
            escalatedTrackingComment({
              id: "track1",
              kind: "checks",
              trigger: "no-commit",
              issueOrPrNumber: 7,
              baseline: "sha-1",
              ref: "sha-1",
            }),
          ],
        },
      },
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.sweepUnstuck();
    const pr = prs.get(7)!;
    expect(pr.labels).toEqual([PHOEBE_QUARANTINE_LABEL]);
    expect(pr.comments[0]!.body).toContain("phoebe-unit:checks:no-commit n=3");
  });

  test("a unit quarantined on two triggers stays labelled unless both clear", () => {
    const escalation1 = buildQuarantineComment({
      kind: "issues",
      id: 42,
      k: 3,
      baseline: "2026-01-01T00:00:00Z",
      reason: "timed out",
    });
    const marker1 = `<!-- phoebe-unit:issues:timed-out n=3 sig=timeout ref=42 at=2026-01-01T00:00:00Z -->`;
    const escalation2 = buildQuarantineComment({
      kind: "issues",
      id: 42,
      k: 3,
      baseline: "2026-03-01T00:00:00Z",
      reason: "was claimed and released with no PR",
    });
    const marker2 = `<!-- phoebe-unit:issues:no-pr n=3 sig=sig ref=42 at=2026-01-01T00:00:00Z -->`;
    const { github, issues } = createMultiUnitFakeGithub({
      issues: {
        42: {
          // Newer than escalation1's baseline (clears timed-out) but older than escalation2's (doesn't clear no-pr).
          updatedAt: "2026-02-01T00:00:00Z",
          labels: [PHOEBE_QUARANTINE_LABEL],
          comments: [
            {
              id: "track1",
              body: `${escalation1}\n\n${marker1}\n\n${escalation2}\n\n${marker2}`,
              createdAt: "2026-01-01T00:00:00Z",
              authorLogin: "phoebe-bot",
            },
          ],
        },
      },
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    quarantine.sweepUnstuck();
    const issue = issues.get(42)!;
    expect(issue.labels).toEqual([PHOEBE_QUARANTINE_LABEL]);
    expect(issue.comments[0]!.body).toContain("phoebe-unit:issues:timed-out");
    expect(issue.comments[0]!.body).toContain("phoebe-unit:issues:no-pr");
  });

  test("a labelled unit with no escalated section (stale/below-threshold) is left alone", () => {
    const { github, issues } = createMultiUnitFakeGithub({
      issues: {
        9: {
          labels: [PHOEBE_QUARANTINE_LABEL],
          comments: [
            {
              id: "track1",
              body: "attempt 1/3\n\n<!-- phoebe-unit:issues:no-pr n=1 sig=s ref=9 at=2026-01-01T00:00:00Z -->",
              createdAt: "2026-01-01T00:00:00Z",
              authorLogin: "phoebe-bot",
            },
          ],
        },
      },
    });
    const quarantine = createQuarantine({
      github,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: () => {},
    });
    expect(() => quarantine.sweepUnstuck()).not.toThrow();
    expect(issues.get(9)!.labels).toEqual([PHOEBE_QUARANTINE_LABEL]);
  });

  test("a listing failure is swallowed and logged, and does not stop the other list from being processed", () => {
    const { github, prs } = createMultiUnitFakeGithub({
      prs: {
        7: {
          headRefOid: "sha-2",
          labels: [PHOEBE_QUARANTINE_LABEL],
          comments: [
            escalatedTrackingComment({
              id: "track1",
              kind: "checks",
              trigger: "no-commit",
              issueOrPrNumber: 7,
              baseline: "sha-1",
              ref: "sha-1",
            }),
          ],
        },
      },
    });
    const failing: GitHub = {
      ...github,
      issuesWithLabel: () => {
        throw new Error("boom");
      },
    };
    const logs: string[] = [];
    const quarantine = createQuarantine({
      github: failing,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: (m) => logs.push(m),
    });
    expect(() => quarantine.sweepUnstuck()).not.toThrow();
    expect(logs.some((l) => l.includes("Could not list quarantined issues"))).toBe(true);
    expect(prs.get(7)!.labels).toEqual([]);
  });

  test("a per-unit activity fetch failure is swallowed and logged", () => {
    const { github } = createMultiUnitFakeGithub({
      issues: { 9: { labels: [PHOEBE_QUARANTINE_LABEL] } },
    });
    const failing: GitHub = {
      ...github,
      issueActivity: () => {
        throw new Error("boom");
      },
    };
    const logs: string[] = [];
    const quarantine = createQuarantine({
      github: failing,
      config: { maxUnitTimeouts: 3, maxUnitAttempts: 3 },
      log: (m) => logs.push(m),
    });
    expect(() => quarantine.sweepUnstuck()).not.toThrow();
    expect(logs.some((l) => l.includes("Could not evaluate auto-un-stick for issue #9"))).toBe(
      true,
    );
  });
});
