import { describe, expect, test } from "vite-plus/test";
import type { HarnessReport } from "phoebe-agent/contracts";
import {
  createUpdateWatch,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type WatchedInstall,
} from "./update-watch.ts";

function install(dir: string, state: WatchedInstall["state"] = "running"): WatchedInstall {
  return { dir, state };
}

const REPORT: HarnessReport = {
  dockerfile: "/x/container/Dockerfile",
  harnesses: [],
  launcher: { pin: { kind: "absent" }, running: null, latest: null, behind: null },
  containerAsked: false,
  latestAt: null,
};

/** A watch over fake timers: `fire` runs the pending one and waits for its round. */
function setup(installs: WatchedInstall[], on = true) {
  let enabled = on;
  const checks: [string, boolean][] = [];
  const emitted: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const watch = createUpdateWatch({
    enabled: () => enabled,
    installs: () => Promise.resolve(installs),
    check: (target, lookUp) => {
      checks.push([target.dir, lookUp]);
      return target.dir === "/broken"
        ? Promise.reject(new Error("cannot read"))
        : Promise.resolve(REPORT);
    },
    emit: (dir) => emitted.push(dir),
    setTimer: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer),
  });
  const fire = async (): Promise<void> => {
    timers.shift()!.run();
    // The round is a chain of awaited checks; let it run out.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };
  return {
    watch,
    checks,
    emitted,
    timers,
    cleared,
    fire,
    turn: (wanted: boolean) => {
      enabled = wanted;
    },
  };
}

describe("the automatic check", () => {
  test("does nothing at all while the preference is off", async () => {
    const { watch, timers, checks } = setup([install("/a")], false);

    watch.refresh();
    await watch.runOnce();

    expect(timers).toEqual([]);
    expect(checks).toEqual([]);
  });

  test("turned on, waits a moment after launch and then reads every install", async () => {
    const { watch, timers, checks, emitted, fire } = setup([
      install("/a"),
      install("/b", "stopped"),
    ]);

    watch.refresh();
    expect(timers.map((timer) => timer.ms)).toEqual([UPDATE_CHECK_DELAY_MS]);
    await fire();

    // The newest versions are looked up once, with the first, and reused.
    expect(checks).toEqual([
      ["/a", true],
      ["/b", false],
    ]);
    expect(emitted).toEqual(["/a", "/b"]);
    // And the next round is a few hours out.
    expect(timers.map((timer) => timer.ms)).toEqual([UPDATE_CHECK_INTERVAL_MS]);
  });

  test("a folder with no install in it yet is not asked about", async () => {
    const { watch, checks } = setup([install("/new", "not-initialised"), install("/a")]);

    await watch.runOnce();

    expect(checks).toEqual([["/a", true]]);
  });

  test("an install that cannot be read does not cost the others their check", async () => {
    const { watch, emitted, checks } = setup([install("/broken"), install("/a")]);

    await watch.runOnce();

    expect(emitted).toEqual(["/a"]);
    // The look-up is still owed, since the first check never made it.
    expect(checks).toEqual([
      ["/broken", true],
      ["/a", true],
    ]);
  });

  test("refreshing twice is one timer, and turning it off clears it", () => {
    const { watch, timers, cleared, turn } = setup([install("/a")]);

    watch.refresh();
    watch.refresh();
    expect(timers).toHaveLength(1);

    turn(false);
    watch.refresh();
    expect(cleared).toHaveLength(1);
  });

  test("turned off while a timer was pending, the round it fires does nothing and schedules no more", async () => {
    const { watch, timers, checks, fire, turn } = setup([install("/a")]);

    watch.refresh();
    turn(false);
    watch.stop();
    await fire();

    expect(checks).toEqual([]);
    expect(timers).toEqual([]);
  });
});
