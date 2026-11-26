// The observer's reading of unit history: flags from a record, coverage when
// history is shorter than the lookback, and the `every` gate over its own runs.

import { describe, expect, test } from "vite-plus/test";
import type { UnitRecord } from "../../src/contracts/unit-record.ts";
import {
  coverageOf,
  flagsOf,
  flagUnits,
  issuesByPr,
  observerGate,
  refsOf,
  renderCoverage,
  RETRY_AFTER_FAILURE_MS,
  unitKeyOf,
  unitsSince,
} from "./evidence.ts";
import type { PrSignals } from "./pr-outcomes.ts";

function unitRecord(overrides: Partial<UnitRecord> = {}): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issues", id: "issue:1" },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: "2026-11-20T10:00:00.000Z",
    settledAt: "2026-11-20T10:30:00.000Z",
    durationMs: 1_800_000,
    runBudgetMs: 3_600_000,
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: null,
    branch: null,
    headSha: null,
    prNumber: null,
    engineCommit: null,
    agentRuns: [],
    ...overrides,
  };
}

const DAY = 86_400_000;
const now = new Date("2026-11-25T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(now.getTime() - days * DAY).toISOString();

describe("flags", () => {
  test("come from the outcome and the quarantine, and a completed unit earns none", () => {
    expect(flagsOf(unitRecord())).toEqual([]);
    expect(flagsOf(unitRecord({ outcome: "failed" }))).toEqual(["failed"]);
    expect(flagsOf(unitRecord({ outcome: "abandoned", settledAt: null }))).toEqual(["abandoned"]);
    expect(flagsOf(unitRecord({ outcome: "timed-out", quarantined: true }))).toEqual([
      "timed-out",
      "quarantined",
    ]);
  });

  // #985: a run that returned with its issue still claimed and no PR used to
  // read `completed`, so a unit that re-ran into quarantine never reached here.
  test("an unproductive unit is flagged, and so is the run that quarantined it", () => {
    expect(flagsOf(unitRecord({ outcome: "unproductive" }))).toEqual(["unproductive"]);
    expect(flagsOf(unitRecord({ outcome: "unproductive", quarantined: true }))).toEqual([
      "unproductive",
      "quarantined",
    ]);
    expect(flagsOf(unitRecord({ outcome: "failed", quarantined: true }))).toEqual([
      "failed",
      "quarantined",
    ]);

    const flagged = flagUnits(
      unitsSince(
        [
          {
            pipeline: "work",
            records: [
              unitRecord({ outcome: "unproductive", startedAt: daysAgo(3) }),
              unitRecord({ outcome: "unproductive", quarantined: true, startedAt: daysAgo(1) }),
              unitRecord({ startedAt: daysAgo(2), unit: { kind: "issues", id: "issue:2" } }),
            ],
          },
        ],
        new Date(now.getTime() - 14 * DAY),
      ),
    );
    expect(flagged.map((unit) => unit.flags)).toEqual([
      ["unproductive", "quarantined"],
      ["unproductive"],
    ]);
  });

  test("only units inside the lookback count, newest first", () => {
    const flagged = flagUnits(
      unitsSince(
        [
          {
            pipeline: "work",
            records: [
              unitRecord({ outcome: "failed", startedAt: daysAgo(20) }),
              unitRecord({
                outcome: "failed",
                startedAt: daysAgo(3),
                unit: { kind: "issues", id: "a" },
              }),
              unitRecord({ startedAt: daysAgo(2) }),
            ],
          },
          {
            pipeline: "intake",
            records: [
              unitRecord({
                outcome: "timed-out",
                startedAt: daysAgo(1),
                unit: { kind: "sentry", id: "b" },
              }),
            ],
          },
        ],
        new Date(now.getTime() - 14 * DAY),
      ),
    );
    expect(flagged.map((unit) => [unit.pipeline, unit.record.unit.id, unit.flags])).toEqual([
      ["intake", "b", ["timed-out"]],
      ["work", "a", ["failed"]],
    ]);
  });

  test("a settled PR's flags join the record's, and carry its signals", () => {
    const signals: PrSignals = {
      number: 7,
      state: "closed",
      changesRequested: 0,
      reviewThreads: 0,
      outsideCommits: 0,
      failedRuns: 0,
      hoursToMerge: null,
      revertedBy: null,
    };
    const units = unitsSince(
      [
        {
          pipeline: "work",
          records: [
            unitRecord({
              outcome: "failed",
              startedAt: daysAgo(3),
              unit: { kind: "checks", id: "pr:7" },
            }),
            unitRecord({ startedAt: daysAgo(2), unit: { kind: "issues", id: "issue:6" } }),
            unitRecord({ startedAt: daysAgo(1), unit: { kind: "issues", id: "issue:9" } }),
          ],
        },
      ],
      new Date(now.getTime() - 14 * DAY),
    );
    const flagged = flagUnits(units, {
      onProposal: () => false,
      prOutcome: (unit) =>
        unit.record.unit.id === "issue:9"
          ? undefined
          : { proposal: false, signals, flags: ["closed-unmerged"] },
    });
    expect(flagged.map((unit) => [unit.record.unit.id, unit.flags, unit.pr?.number])).toEqual([
      ["issue:6", ["closed-unmerged"], 7],
      ["pr:7", ["failed", "closed-unmerged"], 7],
    ]);
  });

  test("a unit on an observer proposal is never flagged, whatever its record or PR says", () => {
    const units = unitsSince(
      [
        {
          pipeline: "work",
          records: [
            unitRecord({
              outcome: "failed",
              startedAt: daysAgo(3),
              unit: { kind: "issues", id: "issue:41" },
            }),
            unitRecord({
              outcome: "timed-out",
              startedAt: daysAgo(2),
              unit: { kind: "reviews", id: "pr:42" },
            }),
            unitRecord({
              outcome: "failed",
              startedAt: daysAgo(1),
              unit: { kind: "issues", id: "issue:5" },
            }),
          ],
        },
      ],
      new Date(now.getTime() - 14 * DAY),
    );
    const flagged = flagUnits(units, {
      onProposal: (unit) => unit.record.unit.id === "issue:41",
      prOutcome: (unit) =>
        unit.record.unit.id === "pr:42" ? { proposal: true, signals: null, flags: [] } : undefined,
    });
    expect(flagged.map((unit) => unit.record.unit.id)).toEqual(["issue:5"]);
  });

  test("a unit's key is stable, and differs for another run of the same ref", () => {
    const first = unitRecord({ startedAt: daysAgo(3) });
    expect(unitKeyOf("work", first)).toBe(unitKeyOf("work", { ...first }));
    expect(unitKeyOf("work", first)).toMatch(/^[0-9a-f]{12}$/);
    expect(unitKeyOf("work", first)).not.toBe(
      unitKeyOf("work", unitRecord({ startedAt: daysAgo(2) })),
    );
    expect(unitKeyOf("work", first)).not.toBe(unitKeyOf("intake", first));
  });
});

describe("refs", () => {
  const flagged = (id: string, overrides: Partial<UnitRecord> = {}, pr: number | null = null) => ({
    key: id,
    pipeline: "work",
    record: unitRecord({ unit: { kind: "issues", id }, outcome: "failed", ...overrides }),
    flags: ["failed" as const],
    pr: pr === null ? null : ({ number: pr } as PrSignals),
  });

  test("a PR's units count as the issue it was opened for", () => {
    const opener = flagged("issue:6", {}, 70);
    const recorded = flagged("issue:8", { prNumber: 80 });
    const byPr = issuesByPr([opener, recorded, flagged("t:1", { prNumber: 90 })]);
    expect([...byPr]).toEqual([
      [70, "issue:6"],
      [80, "issue:8"],
    ]);
    const review = flagged("pr:70", { unit: { kind: "reviews", id: "pr:70" } });
    const stray = flagged("pr:99", { unit: { kind: "checks", id: "pr:99" } });
    expect([...refsOf([opener, review], byPr)]).toEqual(["issue:6"]);
    expect([...refsOf([opener, review, stray, flagged("t:1")], byPr)]).toEqual([
      "issue:6",
      "pr:99",
      "t:1",
    ]);
  });
});

describe("coverage", () => {
  const lookbackMs = 14 * DAY;

  test("is the whole lookback when history reaches past it, and the actual reach when not", () => {
    const work = coverageOf(
      { pipeline: "work", records: [unitRecord({ startedAt: daysAgo(30) })] },
      now,
      lookbackMs,
    );
    const intake = coverageOf(
      { pipeline: "intake", records: [unitRecord({ startedAt: daysAgo(9.5) })] },
      now,
      lookbackMs,
    );
    const fresh = coverageOf(
      { pipeline: "fresh", records: [unitRecord({ startedAt: daysAgo(0.25) })] },
      now,
      lookbackMs,
    );
    const empty = coverageOf({ pipeline: "empty", records: [] }, now, lookbackMs);
    expect(work).toEqual({ pipeline: "work", coveredMs: lookbackMs, full: true });
    expect(intake.full).toBe(false);
    expect(renderCoverage([work, intake, fresh, empty], "14d")).toBe(
      "coverage work 14d, intake 9d, fresh 6h, empty none",
    );
  });

  test("says so when there is no other pipeline to read", () => {
    expect(renderCoverage([], "14d")).toBe("coverage none (no other pipeline)");
  });
});

describe("the every gate", () => {
  const every = 7 * DAY;
  const observer = (overrides: Partial<UnitRecord>) =>
    unitRecord({ pipeline: "observe", unit: { kind: "observer", id: "observer" }, ...overrides });

  test("a never-run observer is due at once", () => {
    expect(observerGate([], "observer", every, now)).toEqual({ due: true, lastCompletedAt: null });
  });

  test("waits out the window after the last completed run, then is due", () => {
    const records = [
      observer({ settledAt: daysAgo(10) }),
      observer({ settledAt: daysAgo(2) }),
      // Another kind's record in the same file is not the observer's.
      unitRecord({ settledAt: daysAgo(30) }),
    ];
    expect(observerGate(records, "observer", every, now)).toEqual({
      due: false,
      nextAt: new Date(now.getTime() + 5 * DAY),
    });
    expect(observerGate(records, "observer", every, new Date(now.getTime() + 5 * DAY))).toEqual({
      due: true,
      lastCompletedAt: daysAgo(2),
    });
  });

  test("a failed run holds off the retry for an hour at most, an abandoned one not at all", () => {
    const failedAt = new Date(now.getTime() - 10 * 60_000).toISOString();
    const records = [
      observer({ settledAt: daysAgo(8) }),
      observer({ outcome: "failed", settledAt: failedAt }),
    ];
    expect(observerGate(records, "observer", every, now)).toEqual({
      due: false,
      nextAt: new Date(Date.parse(failedAt) + RETRY_AFTER_FAILURE_MS),
    });
    expect(
      observerGate(
        [
          observer({ settledAt: daysAgo(8) }),
          observer({ outcome: "abandoned", settledAt: null, startedAt: failedAt }),
        ],
        "observer",
        every,
        now,
      ).due,
    ).toBe(true);
  });

  test("a failure older than the last completed run holds nothing", () => {
    const records = [
      observer({ outcome: "timed-out", settledAt: daysAgo(9) }),
      observer({ settledAt: daysAgo(8) }),
    ];
    expect(observerGate(records, "observer", every, now).due).toBe(true);
  });
});
