// Poison-unit quarantine tests (#75): config resolution, the timeout-counter
// and baseline markers, the count/quarantine/auto-unstick decisions, and the
// selection exclusion that reuses the opt-out filter.

import { describe, expect, test } from "vite-plus/test";
import { asSha } from "./branded.ts";
import {
  buildQuarantineComment,
  buildUnitTimeoutMarker,
  buildUnstickComment,
  decideAutoUnstick,
  decideTimeoutRecord,
  DEFAULT_MAX_UNPRODUCTIVE_RUNS,
  DEFAULT_MAX_UNIT_TIMEOUTS,
  issueContentBaseline,
  latestQuarantineBaseline,
  latestTimeoutMarker,
  loginMismatchWarning,
  newestForeignCommentAt,
  nextTimeoutCount,
  parseQuarantineBaseline,
  parseUnitTimeoutMarker,
  PHOEBE_QUARANTINE_LABEL,
  resolveMaxUnproductiveRuns,
  resolveMaxUnitTimeouts,
  shouldQuarantine,
} from "./quarantine.ts";
import { isPrInScope, selectIssue, type Issue } from "./orchestrator.ts";
import { asBranchRef } from "./branded.ts";

describe("resolveMaxUnproductiveRuns", () => {
  test("defaults to 3", () => {
    expect(resolveMaxUnproductiveRuns({})).toBe(DEFAULT_MAX_UNPRODUCTIVE_RUNS);
    expect(DEFAULT_MAX_UNPRODUCTIVE_RUNS).toBe(3);
  });
  test("env overrides config overrides default", () => {
    expect(resolveMaxUnproductiveRuns({}, 5)).toBe(5);
    expect(resolveMaxUnproductiveRuns({ PHOEBE_MAX_UNPRODUCTIVE_RUNS: "2" }, 5)).toBe(2);
    expect(resolveMaxUnproductiveRuns({ PHOEBE_MAX_UNPRODUCTIVE_RUNS: "0" }, 5)).toBe(5);
  });
  test("PHOEBE_MAX_UNIT_TIMEOUTS is a deprecated alias", () => {
    expect(resolveMaxUnproductiveRuns({ PHOEBE_MAX_UNIT_TIMEOUTS: "4" }, 5)).toBe(4);
    expect(resolveMaxUnproductiveRuns({ PHOEBE_MAX_UNIT_TIMEOUTS: "0" }, 5)).toBe(5);
  });
  test("PHOEBE_MAX_UNPRODUCTIVE_RUNS takes precedence over deprecated alias", () => {
    expect(
      resolveMaxUnproductiveRuns(
        { PHOEBE_MAX_UNPRODUCTIVE_RUNS: "7", PHOEBE_MAX_UNIT_TIMEOUTS: "4" },
        5,
      ),
    ).toBe(7);
  });
});

describe("resolveMaxUnitTimeouts (deprecated alias)", () => {
  test("delegates to resolveMaxUnproductiveRuns", () => {
    expect(resolveMaxUnitTimeouts({})).toBe(DEFAULT_MAX_UNIT_TIMEOUTS);
    expect(DEFAULT_MAX_UNIT_TIMEOUTS).toBe(3);
    expect(resolveMaxUnitTimeouts({}, 5)).toBe(5);
    expect(resolveMaxUnitTimeouts({ PHOEBE_MAX_UNIT_TIMEOUTS: "2" }, 5)).toBe(2);
  });
});

describe("markers", () => {
  test("timeout counter marker round-trips", () => {
    expect(parseUnitTimeoutMarker(buildUnitTimeoutMarker(2))).toEqual({ n: 2 });
    expect(parseUnitTimeoutMarker("no marker here")).toBeNull();
  });

  test("timeout escalation comment embeds the baseline marker and names the label", () => {
    const comment = buildQuarantineComment({ kind: "conflicts", id: 42, k: 3, baseline: "abc123" });
    expect(comment).toContain(PHOEBE_QUARANTINE_LABEL);
    expect(comment).toContain("timed out 3 times");
    expect(parseQuarantineBaseline(comment)).toBe("abc123");
  });

  test("unproductive escalation comment says N runs produced no PR", () => {
    const comment = buildQuarantineComment({
      kind: "issues",
      id: 42,
      k: 3,
      baseline: "body:aabbcc",
      cause: "unproductive",
    });
    expect(comment).toContain(PHOEBE_QUARANTINE_LABEL);
    expect(comment).toContain("3 consecutive runs");
    expect(comment).toContain("produced no PR");
    expect(comment).not.toContain("timed out");
    expect(parseQuarantineBaseline(comment)).toBe("body:aabbcc");
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
  test("a comment with no author still counts as foreign activity", () => {
    // A deleted account has no login at all, which reads as `null` — the one
    // value that is nobody's login, so it can never be read as Phoebe's own and
    // must count toward the reset.
    expect(
      newestForeignCommentAt([{ createdAt: "2026-01-03T00:00:00Z", authorLogin: null }], phoebe),
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

  test("a manually cleared label buys a fresh K, not one retry (#153)", () => {
    // The marker already stands at K, so this unit was quarantined — and
    // selection skips quarantined units, so being picked again at all means a
    // human removed the label. That is a deliberate retry: start from zero
    // instead of re-quarantining on the very next timeout.
    expect(
      decideTimeoutRecord({
        comments: [
          {
            body: buildUnitTimeoutMarker(3),
            createdAt: "2026-01-03T00:00:00Z",
            authorLogin: phoebe,
          },
        ],
        phoebeLogin: phoebe,
        k,
      }),
    ).toEqual({ count: 1, quarantine: false });
  });

  test("a marker past K (after K was lowered) also counts as a manual clear", () => {
    expect(
      decideTimeoutRecord({
        comments: [
          {
            body: buildUnitTimeoutMarker(5),
            createdAt: "2026-01-03T00:00:00Z",
            authorLogin: phoebe,
          },
        ],
        phoebeLogin: phoebe,
        k,
      }),
    ).toEqual({ count: 1, quarantine: false });
  });

  test("an auto-unstick reset marker (n=0) starts the count over", () => {
    expect(
      decideTimeoutRecord({
        comments: [
          {
            body: buildUnstickComment(),
            createdAt: "2026-01-03T00:00:00Z",
            authorLogin: phoebe,
          },
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

describe("issueContentBaseline", () => {
  test("is stable for the same body and differs after an edit", () => {
    expect(issueContentBaseline("hello")).toBe(issueContentBaseline("hello"));
    expect(issueContentBaseline("hello")).not.toBe(issueContentBaseline("hello!"));
  });
  test("is namespaced so it can never collide with a PR head SHA baseline", () => {
    expect(issueContentBaseline("hello")).toMatch(/^body:[0-9a-f]{12}$/);
  });
});

describe("latestQuarantineBaseline", () => {
  const escalation = (baseline: string) => ({
    body: buildQuarantineComment({ kind: "issues", id: 1, k: 3, baseline }),
  });

  test("null when no escalation comment carries a baseline", () => {
    expect(latestQuarantineBaseline([{ body: "a human comment" }])).toBeNull();
    expect(latestQuarantineBaseline([])).toBeNull();
  });

  test("the newest baseline wins when a unit has been quarantined twice", () => {
    const comments = [escalation("old"), { body: "human note" }, escalation("new")];
    expect(latestQuarantineBaseline(comments)).toBe("new");
  });

  test("a baseline behind the un-stick comment is spent and does not count", () => {
    // Otherwise a label a human re-applies by hand would be stripped on the next
    // sweep by the stale baseline of the quarantine Phoebe already lifted.
    const comments = [escalation("aaa"), { body: buildUnstickComment() }];
    expect(latestQuarantineBaseline(comments)).toBeNull();
  });

  test("a re-quarantine after an un-stick is in force again", () => {
    const comments = [escalation("aaa"), { body: buildUnstickComment() }, escalation("bbb")];
    expect(latestQuarantineBaseline(comments)).toBe("bbb");
  });

  test("a quoted escalation comment does not resurrect its baseline", () => {
    // GitHub's "Quote reply" reproduces the comment verbatim behind `> `.
    const quoted = escalation("aaa")
      .body.split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    expect(latestQuarantineBaseline([{ body: `${quoted}\n\nagreed` }])).toBeNull();
  });
});

describe("decideAutoUnstick (the sweep's core)", () => {
  const escalation = (baseline: string) => ({
    body: buildQuarantineComment({ kind: "conflicts", id: 7, k: 3, baseline }),
  });

  test("a PR clears once its head SHA advanced past the recorded baseline", () => {
    expect(
      decideAutoUnstick({ comments: [escalation("aaa")], currentBaseline: asSha("bbb") }),
    ).toBe(true);
    expect(
      decideAutoUnstick({ comments: [escalation("aaa")], currentBaseline: asSha("aaa") }),
    ).toBe(false);
  });

  test("an issue clears once its body fingerprint changed", () => {
    const comments = [escalation(issueContentBaseline("original"))];
    expect(decideAutoUnstick({ comments, currentBaseline: issueContentBaseline("edited") })).toBe(
      true,
    );
    expect(decideAutoUnstick({ comments, currentBaseline: issueContentBaseline("original") })).toBe(
      false,
    );
  });

  test("holds when no Phoebe escalation comment exists — a human's label is theirs to remove", () => {
    expect(
      decideAutoUnstick({ comments: [{ body: "labelled this by hand" }], currentBaseline: "bbb" }),
    ).toBe(false);
  });

  test("Phoebe's own later writes do not move the baseline", () => {
    // The escalation comment and the label both land *after* the baseline is
    // snapshotted; only the unit's own content can clear the quarantine (#153).
    const comments = [escalation("aaa"), { body: buildUnitTimeoutMarker(3) }];
    expect(decideAutoUnstick({ comments, currentBaseline: "aaa" })).toBe(false);
  });

  test("a bare comment cannot re-arm a unit: only the fingerprint counts", () => {
    // The #153 baseline trap: `updatedAt` moves on any comment, label, or
    // reaction, so it can never stand in for the unit's content.
    const body = "unchanged body";
    const comments = [escalation(issueContentBaseline(body)), { body: "any news?" }];
    expect(decideAutoUnstick({ comments, currentBaseline: issueContentBaseline(body) })).toBe(
      false,
    );
  });

  test("holds after an un-stick when a human re-applies the label by hand", () => {
    const comments = [escalation("aaa"), { body: buildUnstickComment() }];
    expect(decideAutoUnstick({ comments, currentBaseline: "bbb" })).toBe(false);
  });
});

describe("buildUnstickComment", () => {
  test("names the label it removed and resets the quarantine counter to zero", () => {
    const comment = buildUnstickComment();
    expect(comment).toContain(PHOEBE_QUARANTINE_LABEL);
    expect(comment).toContain("quarantine count");
    expect(parseUnitTimeoutMarker(comment)).toEqual({ n: 0 });
  });
});

describe("loginMismatchWarning", () => {
  test("null when no marker history exists (historical is null)", () => {
    expect(loginMismatchWarning("bot-login", null)).toBeNull();
  });

  test("null when resolved and historical match", () => {
    expect(loginMismatchWarning("bot-login", "bot-login")).toBeNull();
  });

  test("a warning string naming both logins when they differ", () => {
    const warning = loginMismatchWarning("new-bot", "old-bot");
    expect(warning).not.toBeNull();
    expect(warning).toContain("new-bot");
    expect(warning).toContain("old-bot");
  });

  test("null for a deleted/null historical author — treated as no history", () => {
    // A deleted account has no login on GitHub; newestUnitMarkerAuthor()
    // collapses it to null. No comparison is possible, so no warning fires.
    expect(loginMismatchWarning("bot-login", null)).toBeNull();
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
