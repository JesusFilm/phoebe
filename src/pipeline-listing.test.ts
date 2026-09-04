// Pipeline lines for `phoebe list` (#427): the state ladder, the `wedged?`
// question, and where each line comes from.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  formatAge,
  isWedged,
  listPipelines,
  pipelineState,
  type PipelineRowFacts,
} from "./pipeline-listing.ts";
import { emptyStatus, type StatusSnapshot } from "./unit-event.ts";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const MINUTE = 60_000;

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "phoebe-state-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function snapshot(fields: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return { ...emptyStatus("acme/widget", "work"), ...fields };
}

function writeSnapshot(pipeline: string, fields: Partial<StatusSnapshot> = {}): void {
  mkdirSync(join(stateDir, pipeline), { recursive: true });
  writeFileSync(
    join(stateDir, pipeline, "status.json"),
    JSON.stringify(snapshot({ pipeline, ...fields })),
  );
}

function inFlight(id: string, startedAt: string, runBudgetMs: number | null) {
  return { unit: { kind: "issues", id }, startedAt, runBudgetMs };
}

const WORK_ROW: PipelineRowFacts = {
  name: "work",
  disabled: false,
  concurrency: 2,
  pollIntervalMs: 5 * MINUTE,
};

describe("pipelineState", () => {
  test("no snapshot is `no status`, not idle", () => {
    expect(pipelineState(null)).toBe("no status");
  });

  test("an in-flight unit outranks a parked pass", () => {
    // Both flags set: a pass topping the row up can be waiting on a second slot
    // while the first unit runs. The unit in flight is the more useful fact.
    expect(
      pipelineState(
        snapshot({
          currentUnits: [inFlight("1", "2026-09-04T11:59:00.000Z", MINUTE)],
          waitingForSlot: true,
        }),
      ),
    ).toBe("working");
  });

  test("parked on the broker, then idle", () => {
    expect(pipelineState(snapshot({ waitingForSlot: true }))).toBe("waiting for slot");
    expect(pipelineState(snapshot())).toBe("idle");
  });
});

describe("isWedged", () => {
  const budget = 10 * MINUTE;
  const poll = 5 * MINUTE;
  const startedAgo = (ms: number): StatusSnapshot =>
    snapshot({ currentUnits: [inFlight("1", new Date(NOW - ms).toISOString(), budget)] });

  test("past the run budget plus one poll interval", () => {
    expect(isWedged(startedAgo(budget + poll + 1), poll, NOW)).toBe(true);
  });

  test("inside the budget, and inside the poll-interval grace", () => {
    expect(isWedged(startedAgo(budget - MINUTE), poll, NOW)).toBe(false);
    // A unit whose budget has expired but which the next pass has not reaped yet
    // is late, not wedged — that grace is exactly what the poll interval buys.
    expect(isWedged(startedAgo(budget + MINUTE), poll, NOW)).toBe(false);
  });

  test("a snapshot that names no budget yields no verdict", () => {
    const ancient = snapshot({ currentUnits: [inFlight("1", "2020-01-01T00:00:00.000Z", null)] });
    expect(isWedged(ancient, poll, NOW)).toBe(false);
  });

  test("an idle row is never wedged, however old", () => {
    expect(isWedged(snapshot({ updatedAt: "2020-01-01T00:00:00.000Z" }), poll, NOW)).toBe(false);
    expect(isWedged(null, poll, NOW)).toBe(false);
  });
});

describe("formatAge", () => {
  test("one unit, rounded down", () => {
    expect(formatAge(45_000)).toBe("45s");
    expect(formatAge(12 * MINUTE + 30_000)).toBe("12m");
    expect(formatAge(3 * 60 * MINUTE)).toBe("3h");
    expect(formatAge(50 * 60 * MINUTE)).toBe("2d");
    expect(formatAge(-1)).toBe("0s");
  });
});

describe("listPipelines", () => {
  const rows = (facts: PipelineRowFacts[]) => () => facts;

  test("enumerated rows keep declaration order; unknown state dirs follow as stale", async () => {
    writeSnapshot("work", {
      currentUnits: [inFlight("12", new Date(NOW - MINUTE).toISOString(), 45 * MINUTE)],
    });
    writeSnapshot("old");
    mkdirSync(join(stateDir, "clone.lock"), { recursive: true });

    const listings = await listPipelines({
      configPath: "/tenant/phoebe.config.ts",
      stateDir,
      dataBase: "/data/repos",
      now: NOW,
      loadRows: rows([
        WORK_ROW,
        { name: "intake", disabled: true, concurrency: 1, pollIntervalMs: 15_000 },
      ]),
    });

    expect(listings).toMatchObject([
      { name: "work", source: "enumerated", state: "working", concurrency: 2, wedged: false },
      { name: "intake", source: "enumerated", state: "no status", disabled: true },
      // `clone.lock` is not a legal pipeline name, so the tenant's own state
      // never reads as an abandoned row.
      { name: "old", source: "stale", state: "idle", concurrency: null },
    ]);
  });

  test("an idle snapshot a week old is idle, not wedged", async () => {
    writeSnapshot("work", { updatedAt: new Date(NOW - 7 * 24 * 60 * MINUTE).toISOString() });

    const listings = await listPipelines({
      configPath: "/tenant/phoebe.config.ts",
      stateDir,
      dataBase: "/data/repos",
      now: NOW,
      loadRows: rows([WORK_ROW]),
    });
    expect(listings[0]).toMatchObject({ state: "idle", wedged: false });
  });

  test("a unit past its budget plus the row's poll interval is wedged", async () => {
    writeSnapshot("work", {
      currentUnits: [inFlight("12", new Date(NOW - 60 * MINUTE).toISOString(), 45 * MINUTE)],
    });

    const listings = await listPipelines({
      configPath: "/tenant/phoebe.config.ts",
      stateDir,
      dataBase: "/data/repos",
      now: NOW,
      loadRows: rows([WORK_ROW]),
    });
    expect(listings[0]).toMatchObject({ state: "working", wedged: true });
  });

  test("no config path: one line per snapshot on disk, marked as such", async () => {
    writeSnapshot("work");
    writeSnapshot("intake", { waitingForSlot: true });
    mkdirSync(join(stateDir, "empty"), { recursive: true });

    const listings = await listPipelines({
      configPath: null,
      stateDir,
      dataBase: "/data/repos",
      now: NOW,
    });

    expect(listings).toMatchObject([
      { name: "intake", source: "disk", state: "waiting for slot" },
      { name: "work", source: "disk", state: "idle" },
    ]);
  });

  test("an enumeration that throws falls back to disk rather than inventing rows", async () => {
    writeSnapshot("work");
    const listings = await listPipelines({
      configPath: "/tenant/phoebe.config.ts",
      stateDir,
      dataBase: "/data/repos",
      now: NOW,
      loadRows: () => {
        throw new Error("custom kind failed to load");
      },
    });
    expect(listings).toMatchObject([{ name: "work", source: "disk" }]);
  });

  test("no state dir at all: the enumerated rows still list", async () => {
    const listings = await listPipelines({
      configPath: "/tenant/phoebe.config.ts",
      stateDir: join(stateDir, "missing"),
      dataBase: "/data/repos",
      now: NOW,
      loadRows: rows([WORK_ROW]),
    });
    expect(listings).toMatchObject([{ name: "work", state: "no status", updatedAt: null }]);
  });
});
