// Observability tests (#73): tagged line grammar, the fixed-size status
// snapshot fold, and the emit chokepoint (log + snapshot refresh).

import { describe, expect, test } from "vite-plus/test";
import {
  applyUnitEvent,
  createEmitUnitEvent,
  emptyStatus,
  formatUnitEventLine,
  unitTag,
  type StatusSnapshot,
  type UnitEvent,
} from "./unit-event.ts";

const event = (over: Partial<UnitEvent> = {}): UnitEvent => ({
  ts: "2026-07-31T12:00:00.000Z",
  tenant: "acme/widget",
  unit: { kind: "issues", id: "42" },
  event: "started",
  ...over,
});

describe("tagging", () => {
  test("every line is [phoebe:<slug>], never bare", () => {
    expect(unitTag("acme/widget")).toBe("[phoebe:acme/widget]");
  });
  test("formats an event line with optional detail", () => {
    expect(formatUnitEventLine(event())).toBe("[phoebe:acme/widget] started issues #42");
    expect(formatUnitEventLine(event({ event: "timed-out", detail: "exceeded 45m" }))).toBe(
      "[phoebe:acme/widget] timed-out issues #42 — exceeded 45m",
    );
  });
});

describe("applyUnitEvent", () => {
  const base = emptyStatus("acme/widget");

  test("started sets the current unit", () => {
    const s = applyUnitEvent(base, event({ event: "started" }));
    expect(s.currentUnit).toEqual({ kind: "issues", id: "42" });
    expect(s.updatedAt).toBe("2026-07-31T12:00:00.000Z");
  });

  test("completed clears the current unit", () => {
    const started = applyUnitEvent(base, event({ event: "started" }));
    expect(applyUnitEvent(started, event({ event: "completed" })).currentUnit).toBeNull();
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
});

describe("createEmitUnitEvent", () => {
  test("logs the tagged line and refreshes the snapshot", () => {
    const lines: string[] = [];
    let written: StatusSnapshot | null = null;
    const emit = createEmitUnitEvent({
      tenant: "acme/widget",
      statusPath: "/tmp/state/status.json",
      now: () => "2026-07-31T12:00:00.000Z",
      log: (line) => lines.push(line),
      read: () => written,
      write: (_path, snapshot) => {
        written = snapshot;
      },
    });

    emit({ unit: { kind: "issues", id: "42" }, event: "started" });
    expect(lines).toEqual(["[phoebe:acme/widget] started issues #42"]);
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
      statusPath: "/tmp/state/status.json",
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
