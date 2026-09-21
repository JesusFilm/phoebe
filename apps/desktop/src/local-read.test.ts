// The local read loop, driven with no Docker and no clock.
//
// Every seam the loop has is injected, which is the point of it having them: the
// two clocks (Compose's event stream and the 15 s poll), the exec that reads a
// report, and the facts the directory answers with. What is asserted here is the
// behaviour the pages depend on — one event shape whatever happened, a stopped
// install that carries directory facts and no report, and a poll that runs while
// a container is up and not while it is down.

import { describe, expect, test } from "vite-plus/test";
import type { InstallDirectoryFacts, LocalInstall, LocalReportEvent } from "phoebe-agent/contracts";
import type { ContainerRead } from "./container-read.ts";
import { createLocalReads, LOCAL_READ_INTERVAL_MS, type LocalReadDeps } from "./local-read.ts";

const DIR = "/repos/youtube-studio";

function install(overrides: Partial<LocalInstall> = {}): LocalInstall {
  return {
    dir: DIR,
    name: "youtube-studio",
    addedAt: "2026-09-18T09:00:00.000Z",
    state: "running",
    deploymentName: "youtube-studio",
    relayUrl: null,
    ...overrides,
  };
}

const DIRECTORY: InstallDirectoryFacts = {
  configPath: `${DIR}/phoebe.config.ts`,
  configText: "export default defineConfig({})\n",
  configFingerprint: "abc123",
  envPresent: true,
  bootstrapperRunning: true,
};

/** A hand-wound clock: nothing fires until the test says how far time moved. */
function timers() {
  const pending = new Map<number, { fn: () => void; due: number }>();
  let next = 1;
  let clock = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const handle = next++;
      pending.set(handle, { fn, due: clock + ms });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    /** Run every timer due within `ms`, once. */
    advance(ms: number) {
      clock += ms;
      for (const [handle, timer] of Array.from(pending)) {
        if (timer.due > clock) continue;
        pending.delete(handle);
        timer.fn();
      }
    },
    get armed() {
      return pending.size;
    },
  };
}

/** A loop with stubs for every seam, and the handles a test needs to poke them. */
function harness(
  options: {
    facts?: LocalInstall | null;
    read?: ContainerRead;
  } = {},
) {
  const emitted: LocalReportEvent[] = [];
  const reads: string[] = [];
  const clock = timers();
  const watchers = new Map<string, () => void>();
  let opened = 0;
  let unwatched = 0;
  const current = options.facts === undefined ? install() : options.facts;

  const deps: LocalReadDeps = {
    facts: () => Promise.resolve(current),
    directory: () => DIRECTORY,
    read: (target) => {
      reads.push(target.dir);
      return Promise.resolve(options.read ?? { ok: true, schema: 1, report: { schema: 1 } });
    },
    watch: (target, onChange) => {
      opened += 1;
      watchers.set(target.dir, onChange);
      return () => {
        unwatched += 1;
        watchers.delete(target.dir);
      };
    },
    emit: (event) => emitted.push(event),
    now: () => new Date("2026-09-18T12:00:00.000Z"),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };

  return {
    loop: createLocalReads(deps),
    emitted,
    reads,
    clock,
    watchers,
    get opened() {
      return opened;
    },
    get unwatched() {
      return unwatched;
    },
  };
}

describe("the two clocks", () => {
  test("a Docker event is a read, without waiting for the poll", async () => {
    const it = harness();
    it.loop.sync([install()]);
    await it.loop.refresh(DIR);
    const before = it.reads.length;

    it.watchers.get(DIR)?.();
    await it.loop.refresh(DIR);

    expect(it.reads.length).toBeGreaterThan(before);
  });

  test("a running install is re-read every 15 s", async () => {
    const it = harness();
    it.loop.sync([install()]);
    await it.loop.refresh(DIR);
    const before = it.reads.length;

    it.clock.advance(LOCAL_READ_INTERVAL_MS);
    await it.loop.refresh(DIR);

    // The poll's read, plus the refresh the test used to wait for it.
    expect(it.reads.length).toBe(before + 2);
  });

  test("a stopped install is not polled — its event stream is what wakes it", async () => {
    const it = harness({ facts: install({ state: "stopped" }) });
    it.loop.sync([install({ state: "stopped" })]);
    await it.loop.refresh(DIR);

    expect(it.clock.armed).toBe(0);
    expect(it.reads).toEqual([]);
  });
});

describe("what one read emits", () => {
  test("a running install emits the report under the relay's own event word", async () => {
    const it = harness();
    it.loop.sync([install()]);

    const event = await it.loop.refresh(DIR);

    expect(event.type).toBe("report");
    expect(event.install).toBe(DIR);
    expect(event.report).toEqual({
      schema: 1,
      receivedAt: "2026-09-18T12:00:00.000Z",
      report: { schema: 1 },
    });
    expect(it.emitted).toContain(event);
  });

  test("a stopped install emits report: null with the directory's facts (#527 §6)", async () => {
    const it = harness({ facts: install({ state: "stopped" }) });
    it.loop.sync([install({ state: "stopped" })]);

    const event = await it.loop.refresh(DIR);

    expect(event.report).toBeNull();
    expect(event.directory).toEqual(DIRECTORY);
    expect(event.reason).toContain("not running");
  });

  test("a not-initialised folder says so rather than reading as a stopped container", async () => {
    const it = harness({ facts: install({ state: "not-initialised" }) });

    const event = await it.loop.refresh(DIR);

    expect(event.report).toBeNull();
    expect(event.reason).toContain("no Phoebe install");
  });

  test("an install's own detail is the reason, when Compose gave one", async () => {
    const it = harness({
      facts: install({ state: "stopped", detail: "`docker` is not on PATH" }),
    });

    const event = await it.loop.refresh(DIR);

    expect(event.reason).toBe("`docker` is not on PATH");
  });

  test("a container that refused the exec is still an event, with the reason on it", async () => {
    const it = harness({ read: { ok: false, reason: "no such service: phoebe" } });

    const event = await it.loop.refresh(DIR);

    // Never an exception and never a silence: the page has a tab to fill either
    // way, and a loop that threw here would stop reading.
    expect(event.report).toBeNull();
    expect(event.reason).toBe("no such service: phoebe");
  });

  test("the facts ride with the report, so a page never pairs one with the other's age", async () => {
    const it = harness();

    const event = await it.loop.refresh(DIR);

    expect(event.facts.state).toBe("running");
    expect(event.at).toBe(event.report?.receivedAt);
  });
});

describe("keeping up with the install list", () => {
  test("a new install is watched and read at once", async () => {
    const it = harness();

    it.loop.sync([install()]);
    await it.loop.refresh(DIR);

    expect(it.watchers.has(DIR)).toBe(true);
    expect(it.reads.length).toBeGreaterThan(0);
  });

  test("a forgotten install loses its watcher and its timer", async () => {
    const it = harness();
    it.loop.sync([install()]);
    await it.loop.refresh(DIR);

    it.loop.sync([]);

    expect(it.unwatched).toBe(1);
    expect(it.watchers.size).toBe(0);
    expect(it.clock.armed).toBe(0);
  });

  test("syncing the same list twice does not open a second watcher", async () => {
    const it = harness();

    it.loop.sync([install()]);
    it.loop.sync([install()]);
    await it.loop.refresh(DIR);

    expect(it.watchers.size).toBe(1);
    expect(it.unwatched).toBe(0);
  });

  test("a folder that has just been initialised gets the watcher it could not have", async () => {
    // A not-initialised folder has no compose project, so its watcher was a
    // no-op. `init` is the one transition with no Docker event behind it.
    const it = harness();
    it.loop.sync([install({ state: "not-initialised" })]);
    await it.loop.refresh(DIR);
    const opened = it.opened;

    it.loop.sync([install({ state: "stopped" })]);

    expect(it.opened).toBe(opened + 1);
  });

  test("an install that merely started is not re-subscribed", async () => {
    const it = harness();
    it.loop.sync([install({ state: "stopped" })]);
    await it.loop.refresh(DIR);
    const opened = it.opened;

    it.loop.sync([install({ state: "running" })]);

    expect(it.opened).toBe(opened);
  });

  test("stop drops everything, because the app is quitting", async () => {
    const it = harness();
    it.loop.sync([install()]);
    await it.loop.refresh(DIR);

    it.loop.stop();

    expect(it.unwatched).toBe(1);
    expect(it.clock.armed).toBe(0);
  });

  test("refreshing a folder the companion does not hold is refused, not answered", async () => {
    const it = harness({ facts: null });

    await expect(it.loop.refresh("/repos/somewhere-else")).rejects.toThrow(
      "is not a local install",
    );
  });
});
