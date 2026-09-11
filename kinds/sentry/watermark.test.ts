// The watermark and the regression rule: the marker round-trips, and the four
// rows of #471's decision table hold.

import { describe, expect, test } from "vite-plus/test";
import {
  compareByLoudness,
  decideGroup,
  parseMarker,
  renderMarker,
  SKIP_ALREADY_FILED,
  SKIP_AWAITING_RESOLUTION,
  SKIP_DUPLICATE,
  SKIP_NOT_PLANNED,
  type FiledIssue,
} from "./watermark.ts";

function issue(overrides: Partial<FiledIssue> = {}): FiledIssue {
  return {
    number: 7,
    state: "closed",
    stateReason: "completed",
    closedAt: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

describe("marker", () => {
  test("round-trips through an issue body", () => {
    const body = `Regression of #3\n\n## Symptom\n…\n\n${renderMarker("4507123")}\n`;
    expect(parseMarker(body)).toBe("4507123");
  });

  test("no marker, no group", () => {
    expect(parseMarker("just prose mentioning phoebe-sentry")).toBeNull();
  });
});

describe("decideGroup", () => {
  test("no linked issue → file", () => {
    expect(decideGroup([], "2026-09-11T00:00:00Z")).toEqual({ action: "file", regressionOf: null });
  });

  test("an open linked issue → already filed, whatever else is linked", () => {
    expect(
      decideGroup(
        [issue(), issue({ number: 9, state: "open", stateReason: null, closedAt: null })],
        "2026-09-11T00:00:00Z",
      ),
    ).toEqual({ action: "skip", reason: SKIP_ALREADY_FILED });
  });

  test("closed as not planned → skip forever, even beside a completed one", () => {
    expect(
      decideGroup(
        [issue(), issue({ number: 8, stateReason: "not_planned" })],
        "2026-09-12T00:00:00Z",
      ),
    ).toEqual({ action: "skip", reason: SKIP_NOT_PLANNED });
  });

  test("closed as duplicate → skip forever; the other issue is the record", () => {
    expect(decideGroup([issue({ stateReason: "duplicate" })], "2026-09-12T00:00:00Z")).toEqual({
      action: "skip",
      reason: SKIP_DUPLICATE,
    });
  });

  test("closed completed and seen since → a new issue, regression of the newest close", () => {
    expect(
      decideGroup(
        [issue({ number: 5, closedAt: "2026-09-01T00:00:00Z" }), issue({ number: 7 })],
        "2026-09-10T00:00:01Z",
      ),
    ).toEqual({ action: "file", regressionOf: 7 });
  });

  test("closed completed and not seen since → fixed, awaiting resolution", () => {
    expect(decideGroup([issue()], "2026-09-09T00:00:00Z")).toEqual({
      action: "skip",
      reason: SKIP_AWAITING_RESOLUTION,
    });
  });

  test("a missing close timestamp is treated as not yet resolved rather than a regression", () => {
    expect(decideGroup([issue({ closedAt: null })], "2026-09-11T00:00:00Z")).toEqual({
      action: "skip",
      reason: SKIP_AWAITING_RESOLUTION,
    });
  });
});

describe("compareByLoudness", () => {
  test("highest count first, ties by most recent lastSeen", () => {
    const sorted = [
      { id: "a", count: 3, lastSeen: "2026-09-11T00:00:00Z" },
      { id: "b", count: 9, lastSeen: "2026-09-01T00:00:00Z" },
      { id: "c", count: 3, lastSeen: "2026-09-11T01:00:00Z" },
    ].sort(compareByLoudness);
    expect(sorted.map((g) => g.id)).toEqual(["b", "c", "a"]);
  });
});
