// The dedupe rules and the markers they read: one open proposal per key, 90
// quiet days after a person says no, and a regression after a fix.

import { describe, expect, test } from "vite-plus/test";
import {
  decideFinding,
  listedUnitKeys,
  parseFindingMarker,
  renderFindingMarker,
  renderUnitsMarker,
  type Proposal,
} from "./proposals.ts";

const DAY = 86_400_000;
const now = new Date("2026-11-25T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(now.getTime() - days * DAY).toISOString();

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    number: 38,
    pr: false,
    key: "factory:prompts/issues-prompt.md",
    body: "",
    state: "open",
    stateReason: null,
    closedAt: null,
    ...overrides,
  };
}

describe("markers", () => {
  test("the finding marker round-trips, and a body without one reads as none", () => {
    const marker = renderFindingMarker("convention:AGENTS.md");
    expect(marker).toBe("<!-- phoebe-observer finding=convention:AGENTS.md -->");
    expect(parseFindingMarker(`intro\n${marker}\nmore`)).toBe("convention:AGENTS.md");
    expect(parseFindingMarker("<!-- phoebe-observer units=abc -->")).toBeNull();
    expect(parseFindingMarker("no marker")).toBeNull();
  });

  test("the units a body and its comments list are read back together", () => {
    const keys = listedUnitKeys([
      `body\n${renderUnitsMarker(["aaa111", "bbb222"])}`,
      "a person's comment",
      renderUnitsMarker(["ccc333"]),
    ]);
    expect([...keys].sort()).toEqual(["aaa111", "bbb222", "ccc333"]);
  });
});

describe("decideFinding", () => {
  test("a key never filed is filed", () => {
    expect(decideFinding([], now)).toEqual({ action: "file", regressionOf: null });
  });

  test("an open proposal takes the new evidence", () => {
    const open = proposal({ number: 38 });
    expect(decideFinding([open], now)).toEqual({ action: "fold", into: open });
    // Even when an older one was closed.
    const closed = proposal({
      number: 12,
      state: "closed",
      stateReason: "completed",
      closedAt: daysAgo(40),
    });
    expect(decideFinding([closed, open], now)).toEqual({ action: "fold", into: open });
  });

  test("a proposal turned down within 90 days keeps the key quiet", () => {
    for (const stateReason of ["not_planned", "duplicate", null] as const) {
      const decision = decideFinding(
        [proposal({ state: "closed", stateReason, closedAt: daysAgo(89) })],
        now,
      );
      expect(decision).toEqual({ action: "skip", reason: "turned down within 90 days (#38)" });
    }
  });

  test("past 90 days the key is filed again, as a new finding", () => {
    expect(
      decideFinding(
        [proposal({ state: "closed", stateReason: "not_planned", closedAt: daysAgo(91) })],
        now,
      ),
    ).toEqual({ action: "file", regressionOf: null });
  });

  test("a close date that will not parse is read as recent", () => {
    expect(
      decideFinding(
        [proposal({ state: "closed", stateReason: "not_planned", closedAt: null })],
        now,
      ).action,
    ).toBe("skip");
  });

  test("a completed proposal is filed again as a regression of the newest one", () => {
    const decision = decideFinding(
      [
        proposal({
          number: 12,
          state: "closed",
          stateReason: "not_planned",
          closedAt: daysAgo(200),
        }),
        proposal({ number: 38, state: "closed", stateReason: "completed", closedAt: daysAgo(5) }),
      ],
      now,
    );
    expect(decision).toEqual({
      action: "file",
      regressionOf: { number: 38, closedAt: daysAgo(5) },
    });
  });
});
