// Poison-unit quarantine tests (#75): config resolution, the timeout-counter
// and baseline markers, the count/quarantine/auto-unstick decisions, and the
// selection exclusion that reuses the opt-out filter.

import { describe, expect, test } from "vite-plus/test";
import { asSha } from "./branded.ts";
import {
  buildQuarantineComment,
  buildUnitTimeoutMarker,
  decideTimeoutRecord,
  DEFAULT_MAX_UNIT_TIMEOUTS,
  latestTimeoutMarker,
  newestForeignCommentAt,
  nextTimeoutCount,
  parseQuarantineBaseline,
  parseUnitTimeoutMarker,
  PHOEBE_QUARANTINE_LABEL,
  resolveMaxUnitTimeouts,
  shouldAutoUnstick,
  shouldQuarantine,
} from "./quarantine.ts";
import { isPrInScope, selectIssue, type Issue } from "./orchestrator.ts";
import { asBranchRef } from "./branded.ts";

describe("resolveMaxUnitTimeouts", () => {
  test("defaults to 3", () => {
    expect(resolveMaxUnitTimeouts({})).toBe(DEFAULT_MAX_UNIT_TIMEOUTS);
    expect(DEFAULT_MAX_UNIT_TIMEOUTS).toBe(3);
  });
  test("env overrides config overrides default", () => {
    expect(resolveMaxUnitTimeouts({}, 5)).toBe(5);
    expect(resolveMaxUnitTimeouts({ PHOEBE_MAX_UNIT_TIMEOUTS: "2" }, 5)).toBe(2);
    expect(resolveMaxUnitTimeouts({ PHOEBE_MAX_UNIT_TIMEOUTS: "0" }, 5)).toBe(5);
  });
});

describe("markers", () => {
  test("timeout counter marker round-trips", () => {
    expect(parseUnitTimeoutMarker(buildUnitTimeoutMarker(2))).toEqual({ n: 2 });
    expect(parseUnitTimeoutMarker("no marker here")).toBeNull();
  });

  test("escalation comment embeds the baseline marker and names the label", () => {
    const comment = buildQuarantineComment({ kind: "issues", id: 42, k: 3, baseline: "abc123" });
    expect(comment).toContain(PHOEBE_QUARANTINE_LABEL);
    expect(comment).toContain("timed out 3 times");
    expect(parseQuarantineBaseline(comment)).toBe("abc123");
  });
});

describe("count + quarantine decisions", () => {
  test("first timeout with no prior marker records 1", () => {
    expect(nextTimeoutCount(null, false)).toBe(1);
  });
  test("carries the prior count when there is no newer activity", () => {
    expect(nextTimeoutCount(2, false)).toBe(3);
  });
  test("resets to 0 (then +1) when newer activity is present", () => {
    expect(nextTimeoutCount(2, true)).toBe(1);
  });
  test("quarantines at the threshold", () => {
    expect(shouldQuarantine(2, 3)).toBe(false);
    expect(shouldQuarantine(3, 3)).toBe(true);
  });
});

describe("latestTimeoutMarker", () => {
  test("null when the unit has never timed out", () => {
    expect(
      latestTimeoutMarker([{ body: "just a human comment", createdAt: "2026-01-01T00:00:00Z" }]),
    ).toBeNull();
    expect(latestTimeoutMarker([])).toBeNull();
  });

  test("returns the newest marker's n and its comment createdAt", () => {
    const comments = [
      { body: buildUnitTimeoutMarker(1), createdAt: "2026-01-01T00:00:00Z" },
      { body: "a human replied", createdAt: "2026-01-02T00:00:00Z" },
      { body: buildUnitTimeoutMarker(2), createdAt: "2026-01-03T00:00:00Z" },
    ];
    expect(latestTimeoutMarker(comments)).toEqual({ n: 2, createdAt: "2026-01-03T00:00:00Z" });
  });
});

describe("newestForeignCommentAt", () => {
  const phoebe = "phoebe-bot";
  test("null when there are no foreign comments", () => {
    expect(
      newestForeignCommentAt([{ createdAt: "2026-01-01T00:00:00Z", authorLogin: phoebe }], phoebe),
    ).toBeNull();
    expect(newestForeignCommentAt([], phoebe)).toBeNull();
  });
  test("a deleted author (empty login) still counts as foreign activity", () => {
    // main.ts coerces a null GitHub author to "" — never Phoebe (whose login is
    // always non-empty here), so such a comment must count toward the reset.
    expect(
      newestForeignCommentAt([{ createdAt: "2026-01-03T00:00:00Z", authorLogin: "" }], phoebe),
    ).toBe("2026-01-03T00:00:00Z");
  });
  test("ignores Phoebe's own comments and returns the newest foreign instant", () => {
    expect(
      newestForeignCommentAt(
        [
          { createdAt: "2026-01-05T00:00:00Z", authorLogin: phoebe },
          { createdAt: "2026-01-02T00:00:00Z", authorLogin: "human" },
          { createdAt: "2026-01-04T00:00:00Z", authorLogin: "other" },
        ],
        phoebe,
      ),
    ).toBe("2026-01-04T00:00:00Z");
  });
});

describe("decideTimeoutRecord (engine write-path core)", () => {
  const k = 3;
  const phoebe = "phoebe-bot";

  test("first timeout with no prior marker records 1 and does not quarantine", () => {
    expect(
      decideTimeoutRecord({
        comments: [{ body: "hello", createdAt: "2026-01-01T00:00:00Z", authorLogin: "human" }],
        phoebeLogin: phoebe,
        k,
      }),
    ).toEqual({ count: 1, quarantine: false });
  });

  test("carries the prior count when no foreign activity is newer than the marker", () => {
    expect(
      decideTimeoutRecord({
        comments: [
          { body: "human note", createdAt: "2026-01-02T00:00:00Z", authorLogin: "human" },
          {
            body: buildUnitTimeoutMarker(1),
            createdAt: "2026-01-03T00:00:00Z",
            authorLogin: phoebe,
          },
        ],
        phoebeLogin: phoebe,
        k,
      }),
    ).toEqual({ count: 2, quarantine: false });
  });

  test("Phoebe's own newer marker never resets the count (the #80 blocker)", () => {
    // A marker comment authored by Phoebe is newer than the prior marker, but
    // must NOT count as reset-triggering activity — else the count never climbs.
    expect(
      decideTimeoutRecord({
        comments: [
          {
            body: buildUnitTimeoutMarker(2),
            createdAt: "2026-01-03T00:00:00Z",
            authorLogin: phoebe,
          },
        ],
        phoebeLogin: phoebe,
        k,
      }),
    ).toEqual({ count: 3, quarantine: true });
  });

  test("resets to 1 when a foreign comment landed after the latest marker", () => {
    expect(
      decideTimeoutRecord({
        comments: [
          {
            body: buildUnitTimeoutMarker(2),
            createdAt: "2026-01-03T00:00:00Z",
            authorLogin: phoebe,
          },
          { body: "a human pushed a fix", createdAt: "2026-01-04T00:00:00Z", authorLogin: "human" },
        ],
        phoebeLogin: phoebe,
        k,
      }),
    ).toEqual({ count: 1, quarantine: false });
  });

  test("resets when the extra activity instant (a PR push) is newer than the marker", () => {
    expect(
      decideTimeoutRecord({
        comments: [
          {
            body: buildUnitTimeoutMarker(2),
            createdAt: "2026-01-03T00:00:00Z",
            authorLogin: phoebe,
          },
        ],
        phoebeLogin: phoebe,
        extraActivityAt: "2026-01-04T00:00:00Z",
        k,
      }),
    ).toEqual({ count: 1, quarantine: false });
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
      isDraft: false,
      isCrossRepository: false,
      labels: [PHOEBE_QUARANTINE_LABEL],
    };
    expect(isPrInScope(pr)).toBe(false);
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
    const picked = selectIssue(issues, new Map());
    expect(picked?.issue.number).toBe(2);
  });
});
