// The live deployment report (#532): what the bootstrapper knows, folded into
// one read model.
//
// Every test here drives the model the way boot does — the supervisor's pipeline
// matrix, the spawn wrapper's three lifecycle moments, the children's IPC — and
// asserts on the reports that come out of the injected writer. Nothing touches a
// disk: the two fs readers the fleet needs (snapshots and state directories) are
// injected too.

import { describe, expect, test } from "vite-plus/test";
import type { DeploymentReport } from "../src/contracts/deployment.ts";
import type { StatusSnapshot } from "../src/contracts/status-snapshot.ts";
import type { SupervisedPipeline } from "./pipelines.ts";
import { createDeploymentState, type DeploymentStateDeps } from "./deployment-state.ts";

const POLL_MS = 300_000;

function pipelineOf(
  tenantId: string,
  name: string,
  overrides: { slug?: string | null; disabled?: boolean; concurrency?: number } = {},
): SupervisedPipeline {
  return {
    id: `${tenantId}#${name}`,
    tenant: {
      id: tenantId,
      slug: overrides.slug === undefined ? "acme/widget" : overrides.slug,
      dir: tenantId,
      configPath: `${tenantId}/phoebe.config.ts`,
      envPath: `${tenantId}/.env`,
      gitIdentity: null,
    },
    pipeline: {
      name,
      disabled: overrides.disabled ?? false,
      priority: 0,
      concurrency: overrides.concurrency ?? 1,
      needsClone: true,
      env: [],
      fingerprint: "fp",
    },
    enumerated: true,
    siblingEnv: [],
  };
}

function snapshotWith(units: StatusSnapshot["currentUnits"], waiting = false): StatusSnapshot {
  return {
    tenant: "acme/widget",
    pipeline: "work",
    currentUnits: units,
    waitingForSlot: waiting,
    lastError: null,
    lastTimeoutAt: null,
    updatedAt: "2026-05-05T00:00:00.000Z",
  };
}

/** A model wired to a fake clock, a fake disk and a recording writer. */
function harness(overrides: Partial<DeploymentStateDeps> = {}) {
  const written: DeploymentReport[] = [];
  let clock = Date.parse("2026-05-05T00:00:00.000Z");
  const snapshots = new Map<string, StatusSnapshot>();
  const dirs = new Map<string, string[]>();
  const state = createDeploymentState({
    identity: () => ({ name: "acme/widget", arm: "solo" }),
    dataBase: "/data/repos",
    crashLoop: () => ({ lastGoodSha: "good", failingSha: null, failureCount: 0 }),
    slots: () => ({ capacity: 2, inUse: 1, waiting: 0, overGranted: 0, floorBudget: 1 }),
    armOf: () => "pat",
    now: () => clock,
    write: (report) => written.push(report),
    readSnapshot: (path) => snapshots.get(path) ?? null,
    listStateDirs: (dir) => dirs.get(dir) ?? [],
    exists: () => true,
    ...overrides,
  });
  return {
    state,
    written,
    snapshots,
    dirs,
    advance: (ms: number) => {
      clock += ms;
    },
    latest: () => written[written.length - 1],
  };
}

describe("the report the model publishes", () => {
  test("carries identity, the running engine, the crash-loop record and the slots", () => {
    const h = harness();
    h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: "bad" });

    const report = h.latest()!;
    expect(report.identity).toEqual({ name: "acme/widget", arm: "solo" });
    expect(report.bootstrapper.engineRef).toBe("main");
    expect(report.bootstrapper.engineSha).toBe("abc");
    expect(report.bootstrapper.quarantinedSha).toBe("bad");
    expect(report.bootstrapper.crashLoop.lastGoodSha).toBe("good");
    expect(report.bootstrapper.slots).toEqual({
      capacity: 2,
      inUse: 1,
      waiting: 0,
      overGranted: 0,
      floorBudget: 1,
    });
  });

  test("a reconcile names its reason, and the next spawn ends it", () => {
    const h = harness();
    h.state.notePipelines([pipelineOf("/t/a", "work")]);
    h.state.noteReconcile("ref");
    expect(h.latest()!.bootstrapper.reconcile).toMatchObject({
      phase: "reconciling",
      reason: "ref",
    });

    h.state.noteSpawn(pipelineOf("/t/a", "work"));
    expect(h.latest()!.bootstrapper.reconcile.phase).toBe("idle");
  });

  test("a write failure is reported, never thrown", () => {
    const errors: unknown[] = [];
    const h = harness({
      write: () => {
        throw new Error("read-only volume");
      },
      onWriteError: (error) => errors.push(error),
    });
    expect(() =>
      h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: null }),
    ).not.toThrow();
    expect((errors[0] as Error).message).toContain("read-only volume");
  });
});

describe("per-child liveness", () => {
  test("spawn, drain and exit are the three states, each with its own since", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    expect(h.latest()!.bootstrapper.children[0]).toMatchObject({
      id: "/t/a#work",
      state: "running",
      restarts: 0,
      lastExit: null,
    });

    h.advance(1000);
    h.state.noteDraining("/t/a#work");
    expect(h.latest()!.bootstrapper.children[0]!.state).toBe("draining");

    h.advance(1000);
    h.state.noteExit("/t/a#work", { code: 0, signal: null });
    const child = h.latest()!.bootstrapper.children[0]!;
    expect(child.state).toBe("exited");
    expect(child.lastExit).toEqual({
      code: 0,
      signal: null,
      at: "2026-05-05T00:00:02.000Z",
    });
    // We stopped it, so it is not a restart and not evidence of a crash-loop.
    expect(child.restarts).toBe(0);
    expect(child.crashLooping).toBe(false);
  });

  test("a fast self-death counts as a restart and marks the child crash-looping", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    h.advance(900);
    h.state.noteExit("/t/a#work", { code: 1, signal: null });

    const child = h.latest()!.bootstrapper.children[0]!;
    expect(child.restarts).toBe(1);
    expect(child.crashLooping).toBe(true);

    // Sticky across the respawn, until the new child proves itself.
    h.state.noteSpawn(pipeline);
    expect(h.latest()!.bootstrapper.children[0]!.crashLooping).toBe(true);
    h.advance(120_000);
    h.state.publish();
    expect(h.latest()!.bootstrapper.children[0]!.crashLooping).toBe(false);
  });

  test("a pipeline the matrix no longer names loses its child record", () => {
    const h = harness();
    const work = pipelineOf("/t/a", "work");
    const intake = pipelineOf("/t/a", "intake");
    h.state.notePipelines([work, intake]);
    h.state.noteSpawn(work);
    h.state.noteSpawn(intake);
    expect(h.latest()!.bootstrapper.children).toHaveLength(2);

    h.state.notePipelines([work]);
    expect(h.latest()!.bootstrapper.children.map((child) => child.id)).toEqual(["/t/a#work"]);
  });
});

describe("the pass rail", () => {
  test("a pass moves the clock in memory and publishes nothing", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    const before = h.written.length;

    h.advance(1000);
    h.state.noteEngineReport("/t/a#work", { kind: "pass", pollIntervalMs: POLL_MS });
    expect(h.written).toHaveLength(before);

    // It rides along on the next report something else causes.
    h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: null });
    expect(h.latest()!.bootstrapper.children[0]!.lastPassAt).toBe("2026-05-05T00:00:01.000Z");
  });

  test("a snapshot arriving over IPC is news, and beats what is on disk", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.snapshots.set("/data/repos/acme/widget/state/work/status.json", snapshotWith([]));
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    expect(h.latest()!.fleet.cells[0]!.state).toBe("idle");

    h.state.noteEngineReport("/t/a#work", {
      kind: "status",
      snapshot: snapshotWith([
        {
          unit: { kind: "issue", id: "1" },
          startedAt: "2026-05-05T00:00:00.000Z",
          runBudgetMs: 60_000,
        },
      ]),
    });
    const cell = h.latest()!.fleet.cells[0]!;
    expect(cell.state).toBe("working");
    expect(cell.snapshot!.currentUnits).toHaveLength(1);
  });
});

describe("the wedged verdict the fleet publishes", () => {
  test("a unit past its budget plus a poll interval reads unit-overdue", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    h.state.noteEngineReport("/t/a#work", { kind: "pass", pollIntervalMs: POLL_MS });
    h.state.noteEngineReport("/t/a#work", {
      kind: "status",
      snapshot: snapshotWith([
        {
          unit: { kind: "issue", id: "1" },
          startedAt: "2026-05-05T00:00:00.000Z",
          runBudgetMs: 60_000,
        },
      ]),
    });

    h.advance(60_000 + POLL_MS + 1000);
    h.state.publish();
    expect(h.latest()!.fleet.cells[0]!.wedged).toEqual({ wedged: true, reason: "unit-overdue" });
  });

  test("no pass in three poll intervals reads no-pass, with the silence as a duration", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    h.state.noteEngineReport("/t/a#work", { kind: "pass", pollIntervalMs: POLL_MS });

    h.advance(POLL_MS * 3);
    h.state.publish();
    expect(h.latest()!.fleet.cells[0]!.wedged).toEqual({ wedged: false });

    h.advance(60_000);
    h.state.publish();
    expect(h.latest()!.fleet.cells[0]!.wedged).toEqual({
      wedged: true,
      reason: "no-pass",
      noPassForMs: POLL_MS * 3 + 60_000,
    });
  });

  test("a pipeline waiting for a slot is silent by design, not wedged", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    h.state.noteEngineReport("/t/a#work", { kind: "pass", pollIntervalMs: POLL_MS });
    h.state.noteEngineReport("/t/a#work", { kind: "status", snapshot: snapshotWith([], true) });

    h.advance(POLL_MS * 10);
    h.state.publish();
    expect(h.latest()!.fleet.cells[0]!.wedged).toEqual({ wedged: false });
  });

  test("a pass clears the flag, and that flip is what gets written", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    h.state.noteEngineReport("/t/a#work", { kind: "pass", pollIntervalMs: POLL_MS });
    h.advance(POLL_MS * 4);
    h.state.publish();
    expect(h.latest()!.fleet.cells[0]!.wedged.wedged).toBe(true);

    h.state.noteEngineReport("/t/a#work", { kind: "pass", pollIntervalMs: POLL_MS });
    h.state.publish();
    expect(h.latest()!.fleet.cells[0]!.wedged).toEqual({ wedged: false });
  });

  test("a child that is not running cannot be wedged on the pass clause", () => {
    const h = harness();
    const pipeline = pipelineOf("/t/a", "work");
    h.state.notePipelines([pipeline]);
    h.state.noteSpawn(pipeline);
    h.state.noteEngineReport("/t/a#work", { kind: "pass", pollIntervalMs: POLL_MS });
    h.state.noteExit("/t/a#work", { code: 1, signal: null });

    h.advance(POLL_MS * 10);
    h.state.publish();
    expect(h.latest()!.fleet.cells[0]!.wedged).toEqual({ wedged: false });
  });
});

describe("the fleet matrix", () => {
  test("one cell per live pipeline, carrying the tenant's facts", () => {
    const h = harness();
    h.state.notePipelines([pipelineOf("/t/a", "work", { concurrency: 3 })]);
    const cell = h.latest()!.fleet.cells[0]!;
    expect(cell).toMatchObject({
      id: "/t/a#work",
      pipeline: "work",
      source: "enumerated",
      disabled: false,
      concurrency: 3,
      state: "no status",
    });
    expect(cell.tenant).toEqual({
      id: "/t/a",
      slug: "acme/widget",
      path: "/t/a",
      held: false,
      reason: null,
      configValid: true,
      envPresent: true,
      retainedData: true,
      arm: "pat",
    });
  });

  test("a state directory no live pipeline accounts for is stale, snapshot and all", () => {
    const h = harness();
    h.dirs.set("/data/repos/acme/widget/state", ["work", "retired"]);
    h.snapshots.set("/data/repos/acme/widget/state/retired/status.json", snapshotWith([]));
    h.state.notePipelines([pipelineOf("/t/a", "work")]);

    const cells = h.latest()!.fleet.cells;
    expect(cells.map((cell) => [cell.pipeline, cell.source])).toEqual([
      ["retired", "stale"],
      ["work", "enumerated"],
    ]);
  });

  test("a held tenant running nothing reports what is on its disk, with the hold's reason", () => {
    const h = harness();
    h.dirs.set("/data/repos/acme/widget/state", ["work"]);
    h.snapshots.set("/data/repos/acme/widget/state/work/status.json", snapshotWith([]));
    h.state.notePipelines([]);
    h.state.noteHolds([
      {
        id: "/t/held",
        dir: "/t/held",
        envPath: "/t/held/.env",
        slug: "acme/widget",
        reason: "phoebe.config.ts is mid-rewrite",
      },
    ]);

    const cell = h.latest()!.fleet.cells[0]!;
    expect(cell.source).toBe("disk");
    expect(cell.tenant).toMatchObject({
      held: true,
      reason: "phoebe.config.ts is mid-rewrite",
      configValid: true,
    });
  });

  test("a tenant whose slug was never recovered has no disk to read — but is still a row", () => {
    const h = harness();
    h.state.noteHolds([
      {
        id: "/t/held",
        dir: "/t/held",
        envPath: "/t/held/.env",
        slug: null,
        reason: "config will not load",
      },
    ]);
    expect(h.latest()!.fleet.cells).toEqual([]);
    expect(h.latest()!.fleet.tenants).toEqual([
      {
        id: "/t/held",
        slug: null,
        path: "/t/held",
        held: true,
        reason: "config will not load",
        configValid: false,
        envPresent: true,
        retainedData: false,
        arm: "pat",
      },
    ]);
  });
});

describe("the relay section (#540)", () => {
  test("a deployment that dials nothing says so rather than staying silent", () => {
    const h = harness();
    h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: null });
    expect(h.latest()!.relay).toMatchObject({
      configured: false,
      state: "unpaired",
      nextRetryAt: null,
      lastClose: null,
    });
  });

  test("the link's word goes straight into the report", () => {
    const h = harness();
    h.state.noteRelay({
      configured: true,
      state: "connected",
      nextRetryAt: null,
      lastClose: null,
    });
    expect(h.latest()!.relay).toMatchObject({ configured: true, state: "connected" });
  });

  test("a link that went down and is retrying is one publish, not a stream of them", () => {
    const h = harness();
    const reconnecting = {
      configured: true,
      state: "reconnecting" as const,
      nextRetryAt: "2026-05-05T00:00:05.000Z",
      lastClose: { code: 1006, reason: "", at: "2026-05-05T00:00:00.000Z" },
    };
    h.state.noteRelay(reconnecting);
    const after = h.written.length;
    h.state.noteRelay({ ...reconnecting });
    expect(h.written.length).toBe(after);
  });

  test("the identity the model publishes is re-read, so a pairing mid-run shows up", () => {
    let fingerprint: string | undefined;
    const h = harness({
      identity: () => ({
        name: "acme/widget",
        arm: "solo",
        ...(fingerprint !== undefined ? { keyFingerprint: fingerprint } : {}),
        relayUrl: "wss://relay.example.com/deployments",
      }),
    });
    h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: null });
    expect(h.latest()!.identity.keyFingerprint).toBeUndefined();

    fingerprint = "a-fresh-fingerprint";
    h.state.noteRelay({
      configured: true,
      state: "connected",
      nextRetryAt: null,
      lastClose: null,
    });
    expect(h.latest()!.identity).toMatchObject({
      keyFingerprint: "a-fresh-fingerprint",
      relayUrl: "wss://relay.example.com/deployments",
    });
  });
});

describe("the report the relay link reads", () => {
  test("`latest` is the report as last written, and null before the first", () => {
    const h = harness();
    expect(h.state.latest()).toBeNull();

    h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: null });

    expect(h.state.latest()).toEqual(h.latest());
  });

  test("a written report signals once; a publish that wrote nothing signals not at all", () => {
    let signals = 0;
    const h = harness({
      onReport: () => {
        signals += 1;
      },
    });

    h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: null });
    expect(signals).toBe(1);

    // Nothing moved between these: the model writes nothing, so there is
    // nothing for the link to push.
    h.state.publish();
    h.state.publish();

    expect(signals).toBe(1);
    expect(h.written).toHaveLength(1);
  });

  test("a report that could not be written is not a report to push", () => {
    let signals = 0;
    const h = harness({
      write: () => {
        throw new Error("read-only volume");
      },
      onReport: () => {
        signals += 1;
      },
      onWriteError: () => {},
    });

    h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: null });

    expect(signals).toBe(0);
  });

  test("each written report is its own object, which is what `changed` means to the link", () => {
    const h = harness();
    h.state.noteEngine({ ref: "main", sha: "abc", quarantinedSha: null });
    const first = h.state.latest();

    h.state.noteReconcile("ref");

    expect(h.state.latest()).not.toBe(first);
  });
});
