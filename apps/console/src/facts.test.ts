// What the fleet row says, and the order the rows come in (#507 §9).

import { describe, expect, test } from "vite-plus/test";
import { age, connectionReading, rowFacts, sortFleet } from "./facts.ts";
import { ago, cell, child, NOW, report, row, stored, tenant } from "./test-fixture.ts";

describe("the row rolls up facts", () => {
  test("counts pipelines by the state the deployment derived", () => {
    const facts = rowFacts(
      row(),
      stored(
        report({
          fleet: {
            tenants: [tenant()],
            cells: [
              cell({ id: "a#work", pipeline: "work", state: "working" }),
              cell({ id: "a#research", pipeline: "research", state: "idle" }),
              cell({ id: "a#triage", pipeline: "triage", state: "waiting for slot" }),
            ],
            updatedAt: ago(12),
          },
        }),
      ),
    );

    expect(facts.pipelines).toHaveLength(3);
    expect(facts.counts).toEqual({ working: 1, idle: 1, "waiting for slot": 1 });
    expect(facts.attention).toBe(false);
  });

  test("a cell that was not enumerated is no segment of the bar", () => {
    const facts = rowFacts(
      row(),
      stored(
        report({
          fleet: {
            tenants: [tenant()],
            cells: [
              cell({ id: "a#work" }),
              cell({ id: "a#old-triage", pipeline: "old-triage", source: "stale" }),
            ],
            updatedAt: ago(12),
          },
        }),
      ),
    );

    expect(facts.pipelines.map((pipeline) => pipeline.pipeline)).toEqual(["work"]);
  });

  test("wedged and crash-looping are counted and turn the row's attention on", () => {
    const facts = rowFacts(
      row(),
      stored(
        report({
          bootstrapper: {
            ...report().bootstrapper,
            children: [child({ id: "a#research", crashLooping: true })],
          },
          fleet: {
            tenants: [tenant({ held: true, reason: "config unreadable" })],
            cells: [
              cell({ id: "a#work", wedged: { wedged: true, reason: "unit-overdue" } }),
              cell({ id: "a#research", pipeline: "research", state: "idle" }),
            ],
            updatedAt: ago(12),
          },
        }),
      ),
    );

    expect(facts.wedged).toBe(1);
    expect(facts.crashLooping).toBe(1);
    expect(facts.held).toBe(1);
    expect(facts.attention).toBe(true);
  });

  test("engine ref, running sha, quarantine and reconcile come off the bootstrapper", () => {
    const facts = rowFacts(
      row(),
      stored(
        report({
          bootstrapper: {
            ...report().bootstrapper,
            engineRef: "main",
            engineSha: "9994052",
            quarantinedSha: "c0ffee1",
            reconcile: { phase: "reconciling", reason: "config", since: ago(35) },
          },
        }),
      ),
    );

    expect(facts.engineRef).toBe("main");
    expect(facts.engineSha).toBe("9994052");
    expect(facts.quarantinedSha).toBe("c0ffee1");
    expect(facts.reconciling).toBe("config");
  });

  test("no report is no pipelines rather than an empty deployment", () => {
    const facts = rowFacts(row({ state: "unseen", lastSeen: null }), null);

    expect(facts.reading).toEqual({ kind: "none" });
    expect(facts.pipelines).toEqual([]);
    expect(facts.attention).toBe(false);
  });

  test("a report stamped with an unknown schema is not read at all", () => {
    const facts = rowFacts(row(), stored(report(), { schema: 99 }));

    expect(facts.reading).toEqual({ kind: "unreadable", schema: 99 });
    expect(facts.pipelines).toEqual([]);
  });

  test("a report body that is not an object is unreadable, not a crash", () => {
    expect(rowFacts(row(), stored("nonsense")).reading.kind).toBe("unreadable");
  });

  test("sections missing from a known-schema report read as absent", () => {
    // The relay never looks inside the body, so the console is the first reader
    // and the body is whatever some other process wrote.
    const facts = rowFacts(row(), stored({ schema: 1 }));

    expect(facts.reading.kind).toBe("read");
    expect(facts.pipelines).toEqual([]);
    expect(facts.engineRef).toBeNull();
    expect(facts.held).toBe(0);
  });
});

describe("the sort", () => {
  const dark = rowFacts(row({ fingerprint: "d", name: "zeta", state: "dark" }), null);
  const wedged = rowFacts(
    row({ fingerprint: "w", name: "yankee" }),
    stored(
      report({
        fleet: {
          tenants: [tenant()],
          cells: [cell({ wedged: { wedged: true, reason: "no-pass", noPassForMs: 1_020_000 } })],
          updatedAt: ago(12),
        },
      }),
    ),
  );
  const quiet = rowFacts(row({ fingerprint: "q", name: "alpha" }), stored());
  const alsoQuiet = rowFacts(row({ fingerprint: "b", name: "alpha" }), stored());

  test("dark first, then attention, then name", () => {
    const sorted = sortFleet([quiet, wedged, dark]);

    expect(sorted.map((facts) => facts.row.name)).toEqual(["zeta", "yankee", "alpha"]);
  });

  test("a dark deployment sorts first even with nothing else wrong", () => {
    expect(sortFleet([quiet, dark])[0]?.row.name).toBe("zeta");
  });

  test("two links sharing a name are ordered by fingerprint, so neither moves", () => {
    const sorted = sortFleet([quiet, alsoQuiet]);

    expect(sorted.map((facts) => facts.row.fingerprint)).toEqual(["b", "q"]);
  });

  test("sorting does not touch the array it was given", () => {
    const given = [quiet, dark];

    sortFleet(given);

    expect(given[0]).toBe(quiet);
  });
});

describe("the connection reads as four different things", () => {
  test("connected carries how long it has been up", () => {
    expect(connectionReading(row({ connectedSince: ago(3600) }), NOW)).toEqual({
      tone: "connected",
      text: "connected",
      detail: "since 1 h ago",
      maybeReplaced: false,
    });
  });

  test("disconnected is a duration the relay counted, not a state", () => {
    const reading = connectionReading(
      row({
        state: "disconnected",
        connectedSince: null,
        disconnectedForSeconds: 12,
        lastClose: { code: 1006, reason: "", at: ago(12) },
      }),
      NOW,
    );

    expect(reading.tone).toBe("disconnected");
    expect(reading.text).toBe("disconnected 12 s");
    expect(reading.detail).toBe("last close 1006");
  });

  test("dark reads its age off the last thing heard", () => {
    const reading = connectionReading(
      row({ state: "dark", connectedSince: null, lastSeen: ago(2 * 86_400) }),
      NOW,
    );

    expect(reading.tone).toBe("dark");
    expect(reading.text).toBe("dark 2 d");
  });

  test("unseen says when it was paired, because nothing was lost", () => {
    const reading = connectionReading(
      row({ state: "unseen", lastSeen: null, connectedSince: null, firstSeen: ago(3 * 86_400) }),
      NOW,
    );

    expect(reading.tone).toBe("unseen");
    expect(reading.text).toBe("unseen");
    expect(reading.detail).toBe("paired 3 d ago");
  });

  test("replaced rides alongside the word rather than replacing it", () => {
    const reading = connectionReading(
      row({ state: "dark", connectedSince: null, maybeReplaced: true }),
      NOW,
    );

    expect(reading.tone).toBe("dark");
    expect(reading.maybeReplaced).toBe(true);
  });

  test("a close reason is quoted when the far side gave one", () => {
    const reading = connectionReading(
      row({
        state: "dark",
        connectedSince: null,
        lastClose: { code: 4005, reason: "replaced", at: ago(60) },
      }),
      NOW,
    );

    expect(reading.detail).toBe("last close 4005: replaced");
  });
});

describe("ages", () => {
  test("coarsen as they grow", () => {
    expect(age(ago(0), NOW)).toBe("0 s");
    expect(age(ago(59), NOW)).toBe("59 s");
    expect(age(ago(23 * 60), NOW)).toBe("23 min");
    expect(age(ago(6 * 3600), NOW)).toBe("6 h");
    expect(age(ago(47 * 3600), NOW)).toBe("47 h");
    expect(age(ago(2 * 86_400), NOW)).toBe("2 d");
  });

  test("a clock behind the relay's does not read as the future", () => {
    expect(age(new Date(NOW.getTime() + 5000).toISOString(), NOW)).toBe("0 s");
  });

  test("something that is not an instant says so", () => {
    expect(age("not a date", NOW)).toBe("unknown");
  });
});
