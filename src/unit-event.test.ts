// Observability tests (#73): tagged line grammar, the fixed-size status
// snapshot fold, and the emit chokepoint (log + snapshot refresh).

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  applyUnitEvent,
  createEmitUnitEvent,
  createForgetInherited,
  deploymentNameFrom,
  emptyStatus,
  forgetInherited,
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
  test("every line is [<deployment>:<slug>:<pipeline>], never bare", () => {
    expect(unitTag("fleet", "acme/widget", "work")).toBe("[fleet:acme/widget:work]");
  });
  test("the implicit work pipeline is tagged like any other (#418)", () => {
    expect(unitTag("fleet", "acme/widget", "intake")).toBe("[fleet:acme/widget:intake]");
  });
  test("formats an event line with optional detail", () => {
    expect(formatUnitEventLine("fleet", event())).toBe(
      "[fleet:acme/widget:work] started issues 42",
    );
    expect(
      formatUnitEventLine("fleet", event({ event: "timed-out", detail: "exceeded 45m" })),
    ).toBe("[fleet:acme/widget:work] timed-out issues 42 — exceeded 45m");
  });
});

describe("deploymentNameFrom (#686)", () => {
  test("is the name the bootstrapper handed down", () => {
    expect(deploymentNameFrom({ PHOEBE_DEPLOYMENT_NAME: "fleet" }, "acme/widget")).toBe("fleet");
  });
  test("with no bootstrapper to say, is the engine's own repoSlug — never `phoebe`", () => {
    expect(deploymentNameFrom({}, "acme/widget")).toBe("acme/widget");
    expect(deploymentNameFrom({ PHOEBE_DEPLOYMENT_NAME: "" }, "acme/widget")).toBe("acme/widget");
    expect(unitTag(deploymentNameFrom({}, "acme/widget"), "acme/widget", "work")).toBe(
      "[acme/widget:acme/widget:work]",
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

  test("started adds the unit, with its start time and its budget", () => {
    const s = applyUnitEvent(base, event({ event: "started", runBudgetMs: 1_800_000 }));
    expect(s.currentUnits).toEqual([
      {
        unit: { kind: "issues", id: "42" },
        startedAt: "2026-07-31T12:00:00.000Z",
        runBudgetMs: 1_800_000,
      },
    ]);
    expect(s.updatedAt).toBe("2026-07-31T12:00:00.000Z");
  });

  test("completed drops the unit", () => {
    const started = applyUnitEvent(base, event({ event: "started" }));
    expect(applyUnitEvent(started, event({ event: "completed" })).currentUnits).toEqual([]);
  });

  // The whole difference concurrency makes to the fold: one unit settling must
  // not blank the siblings still running beside it (#422).
  test("one unit settling leaves its siblings in flight", () => {
    const first = applyUnitEvent(base, event({ event: "started" }));
    const second = applyUnitEvent(
      first,
      event({ event: "started", unit: { kind: "issues", id: "43" } }),
    );
    const s = applyUnitEvent(second, event({ event: "completed" }));
    expect(s.currentUnits.map((current) => current.unit.id)).toEqual(["43"]);
  });

  test("failed drops the unit and records the error as lastError", () => {
    const started = applyUnitEvent(base, event({ event: "started" }));
    const s = applyUnitEvent(started, event({ event: "failed", detail: "push rejected" }));
    expect(s.currentUnits).toEqual([]);
    expect(s.lastError).toBe("push rejected");
  });

  test("timed-out drops the unit and stamps lastTimeoutAt", () => {
    const s = applyUnitEvent(base, event({ event: "timed-out", ts: "2026-07-31T13:00:00.000Z" }));
    expect(s.currentUnits).toEqual([]);
    expect(s.lastTimeoutAt).toBe("2026-07-31T13:00:00.000Z");
  });

  test("quarantined records the reason as lastError", () => {
    const s = applyUnitEvent(base, event({ event: "quarantined", detail: "3 timeouts" }));
    expect(s.lastError).toBe("3 timeouts");
  });

  test("skipped drops the unit without blaming this pipeline for it", () => {
    const failed = applyUnitEvent(base, event({ event: "failed", detail: "push rejected" }));
    const s = applyUnitEvent(failed, event({ event: "skipped", detail: "leased by intake" }));
    expect(s.currentUnits).toEqual([]);
    // The prior error stands; a deferred unit is not a new one.
    expect(s.lastError).toBe("push rejected");
  });

  test("waiting-for-slot is set by the wait and cleared only by the start", () => {
    const waiting = applyUnitEvent(base, event({ event: "waiting-for-slot" }));
    expect(waiting.waitingForSlot).toBe(true);
    // A sibling finishing says nothing about whether this pass got its slot.
    const sibling = applyUnitEvent(
      waiting,
      event({ event: "completed", unit: { kind: "issues", id: "43" } }),
    );
    expect(sibling.waitingForSlot).toBe(true);
    expect(applyUnitEvent(sibling, event({ event: "started" })).waitingForSlot).toBe(false);
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
      deployment: "fleet",
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
    expect(lines).toEqual(["[fleet:acme/widget:work] started issues 42"]);
    expect(written).not.toBeNull();
    expect(written!.currentUnits.map((current) => current.unit)).toEqual([
      { kind: "issues", id: "42" },
    ]);

    emit({ unit: { kind: "issues", id: "42" }, event: "timed-out", detail: "45m" });
    expect(written!.currentUnits).toEqual([]);
    expect(written!.lastTimeoutAt).toBe("2026-07-31T12:00:00.000Z");
  });

  test("the folded snapshot is handed to the supervisor, once it is on disk", () => {
    const reported: StatusSnapshot[] = [];
    let written: StatusSnapshot | null = null;
    const emit = createEmitUnitEvent({
      deployment: "fleet",
      tenant: "acme/widget",
      pipeline: "work",
      statusPath: "/tmp/state/work/status.json",
      now: () => "2026-07-31T12:00:00.000Z",
      log: () => {},
      read: () => written,
      write: (_path, snapshot) => {
        written = snapshot;
      },
      onSnapshot: (snapshot) => reported.push(snapshot),
    });

    emit({ unit: { kind: "issues", id: "42" }, event: "started" });
    expect(reported).toEqual([written]);
  });

  test("a write that failed is not reported as a snapshot the supervisor can trust", () => {
    const reported: StatusSnapshot[] = [];
    const emit = createEmitUnitEvent({
      deployment: "fleet",
      tenant: "acme/widget",
      pipeline: "work",
      statusPath: "/tmp/state/work/status.json",
      log: () => {},
      read: () => null,
      write: () => {
        throw new Error("disk full");
      },
      onSnapshot: (snapshot) => reported.push(snapshot),
    });

    emit({ unit: { kind: "issues", id: "1" }, event: "started" });
    expect(reported).toEqual([]);
  });

  test("a snapshot write failure is swallowed, not thrown", () => {
    const lines: string[] = [];
    const emit = createEmitUnitEvent({
      deployment: "fleet",
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

// #670: the snapshot outlives the process that wrote it, and a unit only
// leaves it on its own settling event. A child killed mid-unit never emits one.
// On this repo's own deployment a `conflicts` unit sat in `currentUnits` for
// three weeks, across every relaunch, and the report called the pipeline wedged
// the whole time — including minutes after a fresh boot with nothing running.
describe("forgetInherited", () => {
  const stranded: StatusSnapshot = {
    tenant: "acme/widget",
    pipeline: "work",
    currentUnits: [
      {
        unit: { kind: "conflicts", id: "pr:565" },
        startedAt: "2026-09-18T18:01:06.007Z",
        runBudgetMs: 2_700_000,
      },
    ],
    waitingForSlot: false,
    lastError: "push rejected",
    lastTimeoutAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-09T03:12:17.540Z",
  };
  const BOOT = "2026-10-09T19:09:38.000Z";

  test("a unit a dead child never settled is dropped, and named", () => {
    const inherited = forgetInherited(stranded, BOOT);
    expect(inherited?.next.currentUnits).toEqual([]);
    expect(inherited?.stranded).toEqual(stranded.currentUnits);
    // The write is an event like any other: a reader sees the file moved.
    expect(inherited?.next.updatedAt).toBe(BOOT);
  });

  test("history is not a claim about now, so it survives", () => {
    const next = forgetInherited(stranded, BOOT)?.next;
    expect(next?.lastError).toBe("push rejected");
    expect(next?.lastTimeoutAt).toBe("2026-09-01T00:00:00.000Z");
    expect(next?.tenant).toBe("acme/widget");
    expect(next?.pipeline).toBe("work");
  });

  test("a slot wait a dead pass left behind is cleared too", () => {
    // Only `started` clears the flag, so a pass that drained while parked on
    // the broker leaves it set — and a set flag suppresses the `no pass` clause
    // that would notice the next child's loop stopping.
    const parked = { ...stranded, currentUnits: [], waitingForSlot: true };
    const inherited = forgetInherited(parked, BOOT);
    expect(inherited?.next.waitingForSlot).toBe(false);
    expect(inherited?.wasWaitingForSlot).toBe(true);
    expect(inherited?.stranded).toEqual([]);
  });

  test("a snapshot claiming nothing is left alone", () => {
    const clean = { ...stranded, currentUnits: [] };
    expect(forgetInherited(clean, BOOT)).toBeNull();
    expect(forgetInherited(emptyStatus("acme/widget", "work"), BOOT)).toBeNull();
  });
});

describe("createForgetInherited", () => {
  const snapshotWith = (over: Partial<StatusSnapshot>): StatusSnapshot => ({
    ...emptyStatus("acme/widget", "work"),
    updatedAt: "2026-10-09T03:12:17.540Z",
    ...over,
  });
  const harness = (found: StatusSnapshot | null, write?: () => void) => {
    const lines: string[] = [];
    const reported: StatusSnapshot[] = [];
    let onDisk = found;
    let writes = 0;
    const forget = createForgetInherited({
      deployment: "fleet",
      tenant: "acme/widget",
      pipeline: "work",
      statusPath: "/tmp/state/work/status.json",
      now: () => "2026-10-09T19:09:38.000Z",
      log: (line) => lines.push(line),
      read: () => onDisk,
      write: (_path, next) => {
        write?.();
        writes += 1;
        onDisk = next;
      },
      onSnapshot: (snapshot) => reported.push(snapshot),
    });
    return { forget, lines, reported, onDisk: () => onDisk, writes: () => writes };
  };

  test("each stranded unit is logged once, with when it had started", () => {
    const h = harness(
      snapshotWith({
        currentUnits: [
          {
            unit: { kind: "conflicts", id: "pr:565" },
            startedAt: "2026-09-18T18:01:06.007Z",
            runBudgetMs: 2_700_000,
          },
          {
            unit: { kind: "issues", id: "issue:9" },
            startedAt: "2026-09-18T18:02:00.000Z",
            runBudgetMs: null,
          },
        ],
      }),
    );
    h.forget();

    expect(h.onDisk()?.currentUnits).toEqual([]);
    expect(h.lines).toEqual([
      "[fleet:acme/widget:work] dropped conflicts pr:565 from status.json — started " +
        "2026-09-18T18:01:06.007Z by a process that is gone, and never settled.",
      "[fleet:acme/widget:work] dropped issues issue:9 from status.json — started " +
        "2026-09-18T18:02:00.000Z by a process that is gone, and never settled.",
    ]);
  });

  test("the supervisor hears the cleared snapshot, so the report stops saying wedged", () => {
    const h = harness(
      snapshotWith({
        currentUnits: [
          {
            unit: { kind: "conflicts", id: "pr:565" },
            startedAt: "2026-09-18T18:01:06.007Z",
            runBudgetMs: 1,
          },
        ],
      }),
    );
    h.forget();
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.currentUnits).toEqual([]);
  });

  test("a cleared slot wait is said in the log", () => {
    const h = harness(snapshotWith({ waitingForSlot: true }));
    h.forget();
    expect(h.onDisk()?.waitingForSlot).toBe(false);
    expect(h.lines).toEqual([
      "[fleet:acme/widget:work] cleared a slot wait in status.json — the pass that was parked is gone.",
    ]);
  });

  test("a clean snapshot, or none at all, is not written and not announced", () => {
    for (const found of [snapshotWith({}), null]) {
      const h = harness(found);
      h.forget();
      expect(h.writes()).toBe(0);
      expect(h.lines).toEqual([]);
      expect(h.reported).toEqual([]);
    }
  });

  test("a write that fails is one log line, never a boot that failed", () => {
    const h = harness(
      snapshotWith({
        currentUnits: [
          {
            unit: { kind: "conflicts", id: "pr:565" },
            startedAt: "2026-09-18T18:01:06.007Z",
            runBudgetMs: 1,
          },
        ],
      }),
      () => {
        throw new Error("EROFS");
      },
    );
    expect(() => h.forget()).not.toThrow();
    expect(h.lines).toEqual([
      "[fleet:acme/widget:work] could not clear inherited state from status.json — Error: EROFS",
    ]);
    // Nothing was written, so nothing is reported as if it had been.
    expect(h.reported).toEqual([]);
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
        deployment: "fleet",
        tenant: "acme/widget",
        pipeline,
        statusPath: statusPathFor(stateDir, pipeline),
        log: () => {},
      });

    const work = emitFor("work");
    const intake = emitFor("intake");

    work({ unit: { kind: "issues", id: "7" }, event: "started" });
    intake({ unit: { kind: "triage", id: "88" }, event: "started" });
    // The event that used to blank a shared file's current unit.
    intake({ unit: { kind: "triage", id: "88" }, event: "completed" });

    expect(readStatus(statusPathFor(stateDir, "work"))).toMatchObject({
      pipeline: "work",
      currentUnits: [
        { unit: { kind: "issues", id: "7" }, startedAt: expect.any(String), runBudgetMs: null },
      ],
    });
    expect(readStatus(statusPathFor(stateDir, "intake"))).toMatchObject({
      pipeline: "intake",
      currentUnits: [],
    });
  });
});
