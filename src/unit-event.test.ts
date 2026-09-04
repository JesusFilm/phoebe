// Observability tests (#73): tagged line grammar, the fixed-size status
// snapshot fold, and the emit chokepoint (log + snapshot refresh).

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  applyUnitEvent,
  createEmitUnitEvent,
  emptyStatus,
  formatUnitEventLine,
  readStatus,
  statusPathFor,
  unitTag,
  writeStatus,
  type StatusSnapshot,
  type UnitEvent,
} from "./unit-event.ts";

const event = (over: Partial<UnitEvent> = {}): UnitEvent => ({
  ts: "2026-07-31T12:00:00.000Z",
  tenant: "acme/widget",
  pipeline: "work",
  unit: { kind: "issues", id: "42" },
  event: "started",
  ...over,
});

describe("tagging", () => {
  test("every line is [phoebe:<slug>:<pipeline>], never bare", () => {
    expect(unitTag("acme/widget", "work")).toBe("[phoebe:acme/widget:work]");
  });
  test("the implicit work row is tagged like any other (#418)", () => {
    expect(unitTag("acme/widget", "intake")).toBe("[phoebe:acme/widget:intake]");
  });
  test("formats an event line with optional detail", () => {
    expect(formatUnitEventLine(event())).toBe("[phoebe:acme/widget:work] started issues 42");
    expect(formatUnitEventLine(event({ event: "timed-out", detail: "exceeded 45m" }))).toBe(
      "[phoebe:acme/widget:work] timed-out issues 42 — exceeded 45m",
    );
  });
});

describe("statusPathFor", () => {
  test("each pipeline owns its own snapshot under state/ (#418)", () => {
    expect(statusPathFor("/data/repos/acme/widget/state", "work")).toBe(
      "/data/repos/acme/widget/state/work/status.json",
    );
    expect(statusPathFor("/data/repos/acme/widget/state", "intake")).toBe(
      "/data/repos/acme/widget/state/intake/status.json",
    );
  });
});

describe("applyUnitEvent", () => {
  const base = emptyStatus("acme/widget", "work");

  test("started sets the current unit", () => {
    const s = applyUnitEvent(base, event({ event: "started" }));
    expect(s.currentUnit).toEqual({ kind: "issues", id: "42" });
    expect(s.updatedAt).toBe("2026-07-31T12:00:00.000Z");
  });

  test("completed clears the current unit", () => {
    const started = applyUnitEvent(base, event({ event: "started" }));
    expect(applyUnitEvent(started, event({ event: "completed" })).currentUnit).toBeNull();
  });

  test("failed clears the unit and records the error as lastError", () => {
    const started = applyUnitEvent(base, event({ event: "started" }));
    const s = applyUnitEvent(started, event({ event: "failed", detail: "push rejected" }));
    expect(s.currentUnit).toBeNull();
    expect(s.lastError).toBe("push rejected");
  });

  test("timed-out clears the unit and stamps lastTimeoutAt", () => {
    const s = applyUnitEvent(base, event({ event: "timed-out", ts: "2026-07-31T13:00:00.000Z" }));
    expect(s.currentUnit).toBeNull();
    expect(s.lastTimeoutAt).toBe("2026-07-31T13:00:00.000Z");
  });

  test("quarantined records the reason as lastError", () => {
    const s = applyUnitEvent(base, event({ event: "quarantined", detail: "3 timeouts" }));
    expect(s.lastError).toBe("3 timeouts");
  });

  test("skipped clears the unit without blaming this pipeline for it", () => {
    const failed = applyUnitEvent(base, event({ event: "failed", detail: "push rejected" }));
    const s = applyUnitEvent(failed, event({ event: "skipped", detail: "leased by intake" }));
    expect(s.currentUnit).toBeNull();
    // The prior error stands; a deferred unit is not a new one.
    expect(s.lastError).toBe("push rejected");
  });
});

describe("writeStatus (atomic)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phoebe-status-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a snapshot and leaves no temp file behind", () => {
    const path = join(dir, "state", "status.json");
    const snapshot = applyUnitEvent(
      emptyStatus("acme/widget", "work"),
      event({ event: "failed", detail: "boom" }),
    );
    writeStatus(path, snapshot);

    expect(readStatus(path)).toEqual(snapshot);
    // The temp file was renamed over the target, not left as debris — a reader
    // never sees a half-written file (the whole point of the temp+rename).
    expect(readdirSync(join(dir, "state"))).toEqual(["status.json"]);
  });
});

describe("createEmitUnitEvent", () => {
  test("logs the tagged line and refreshes the snapshot", () => {
    const lines: string[] = [];
    let written: StatusSnapshot | null = null;
    const emit = createEmitUnitEvent({
      tenant: "acme/widget",
      pipeline: "work",
      statusPath: "/tmp/state/work/status.json",
      now: () => "2026-07-31T12:00:00.000Z",
      log: (line) => lines.push(line),
      read: () => written,
      write: (_path, snapshot) => {
        written = snapshot;
      },
    });

    emit({ unit: { kind: "issues", id: "42" }, event: "started" });
    expect(lines).toEqual(["[phoebe:acme/widget:work] started issues 42"]);
    expect(written).not.toBeNull();
    expect(written!.currentUnit).toEqual({ kind: "issues", id: "42" });

    emit({ unit: { kind: "issues", id: "42" }, event: "timed-out", detail: "45m" });
    expect(written!.currentUnit).toBeNull();
    expect(written!.lastTimeoutAt).toBe("2026-07-31T12:00:00.000Z");
  });

  test("a snapshot write failure is swallowed, not thrown", () => {
    const lines: string[] = [];
    const emit = createEmitUnitEvent({
      tenant: "acme/widget",
      pipeline: "work",
      statusPath: "/tmp/state/work/status.json",
      log: (line) => lines.push(line),
      read: () => null,
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(() => emit({ unit: { kind: "issues", id: "1" }, event: "started" })).not.toThrow();
    expect(lines.some((l) => l.includes("could not refresh status.json"))).toBe(true);
  });
});

// The acceptance case for the per-pipeline snapshot (#418): two engine
// processes on one tenant, each with its own current unit, and neither able to
// blank the other's. Against a real directory, because the collision the split
// prevents is a filesystem one.
describe("two pipelines on one tenant", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = join(mkdtempSync(join(tmpdir(), "phoebe-pipelines-")), "state");
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("each writes its own snapshot and neither overwrites the other", () => {
    const emitFor = (pipeline: string) =>
      createEmitUnitEvent({
        tenant: "acme/widget",
        pipeline,
        statusPath: statusPathFor(stateDir, pipeline),
        log: () => {},
      });

    const work = emitFor("work");
    const intake = emitFor("intake");

    work({ unit: { kind: "issues", id: "7" }, event: "started" });
    intake({ unit: { kind: "triage", id: "88" }, event: "started" });
    // The event that used to blank a shared file's `currentUnit`.
    intake({ unit: { kind: "triage", id: "88" }, event: "completed" });

    expect(readStatus(statusPathFor(stateDir, "work"))).toMatchObject({
      pipeline: "work",
      currentUnit: { kind: "issues", id: "7" },
    });
    expect(readStatus(statusPathFor(stateDir, "intake"))).toMatchObject({
      pipeline: "intake",
      currentUnit: null,
    });
  });
});
