// The bootstrapper's doctor runs (#507 §4-§7, #534): when a run happens, what
// happens when two things ask at once, and what the deployment report's doctor
// section says at each step.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { DoctorReport, DoctorSection } from "../src/contracts/doctor.ts";
import {
  createDoctorRunner,
  parseDoctorStdout,
  spawnDoctor,
  DOCTOR_KILL_GRACE_MS,
  DOCTOR_SCHEDULE_MS,
  type DoctorRunResult,
  type DoctorRunner,
} from "./doctor-runner.ts";

const healthy: DoctorReport = {
  checks: [{ id: "cli", state: "ok", detail: "0.13.0" }],
  tenants: [],
  ok: true,
};

type Harness = {
  runner: DoctorRunner;
  sections: Array<Omit<DoctorSection, "updatedAt">>;
  /** The triggers `run` was actually called with, in order. */
  runs: string[];
  /** Answer the run that is in flight. */
  settle: (result: DoctorRunResult) => void;
  /** Fire the armed schedule timer. */
  fireSchedule: () => void;
  armedFor: () => number | null;
  advance: (ms: number) => void;
};

function harness(): Harness {
  const sections: Array<Omit<DoctorSection, "updatedAt">> = [];
  const runs: string[] = [];
  const pending: Array<(result: DoctorRunResult) => void> = [];
  let armed: { ms: number; fire: () => void } | null = null;
  let clock = Date.parse("2026-05-05T00:00:00.000Z");

  const runner = createDoctorRunner({
    run: (trigger) => {
      runs.push(trigger);
      return new Promise<DoctorRunResult>((resolve) => pending.push(resolve));
    },
    onSection: (section) => sections.push(structuredClone(section)),
    now: () => clock,
    scheduleMs: DOCTOR_SCHEDULE_MS,
    // A fixed place in the jitter window, so the arming assertions are exact.
    jitter: () => 0.5,
    setTimer: (ms, fire) => {
      armed = { ms, fire };
      return {
        clear: () => {
          armed = null;
        },
      };
    },
  });

  return {
    runner,
    sections,
    runs,
    settle: (result) => {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("no run in flight to settle");
      resolve(result);
    },
    fireSchedule: () => {
      const timer = armed;
      if (timer === null) throw new Error("no schedule armed");
      timer.fire();
    },
    armedFor: () => armed?.ms ?? null,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const last = <T>(items: T[]): T => {
  const item = items.at(-1);
  if (item === undefined) throw new Error("nothing published");
  return item;
};

/** Let the runner's promise chain settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the triggers", () => {
  test("the fleet's first child is the boot run", async () => {
    const h = harness();
    h.runner.start();
    expect(h.runs).toEqual([]);

    h.runner.noteFleetUp();
    await flush();
    expect(h.runs).toEqual(["boot"]);
    // A console can say "running since" the moment the child is spawned, not
    // five minutes later when it answers.
    expect(last(h.sections).running).toEqual({
      since: "2026-05-05T00:00:00.000Z",
      trigger: "boot",
    });
    expect(last(h.sections).report).toBeNull();
  });

  test("a later spawn is not another boot run", async () => {
    const h = harness();
    h.runner.start();
    h.runner.noteFleetUp();
    await flush();
    h.settle({ outcome: "ok", report: healthy });
    await flush();

    h.runner.noteFleetUp();
    await flush();
    expect(h.runs).toEqual(["boot"]);
  });

  test("a reconcile waits for the relaunch, then runs once", async () => {
    const h = harness();
    h.runner.start();
    h.runner.noteFleetUp();
    await flush();
    h.settle({ outcome: "ok", report: healthy });
    await flush();

    h.runner.noteReconcile();
    await flush();
    // Nothing runs against a fleet that is halfway between two engines.
    expect(h.runs).toEqual(["boot"]);

    h.runner.noteFleetUp();
    await flush();
    expect(h.runs).toEqual(["boot", "reconcile"]);
  });

  test("a request mid-reconcile joins the run the relaunch releases", async () => {
    const h = harness();
    h.runner.start();
    h.runner.noteFleetUp();
    await flush();
    h.settle({ outcome: "ok", report: healthy });
    await flush();

    h.runner.noteReconcile();
    const receipt = h.runner.request("request", "ops@example.com");
    await flush();
    expect(h.runs).toEqual(["boot"]);

    h.runner.noteFleetUp();
    await flush();
    expect(h.runs).toEqual(["boot", "reconcile"]);
    h.settle({ outcome: "ok", report: healthy });
    // The asker's receipt carries the result of the run their trigger joined.
    await expect(receipt).resolves.toEqual({ outcome: "ok", report: healthy });
  });

  test("the schedule is the six-hour clock, rearmed from the end of each run", async () => {
    const h = harness();
    h.runner.start();
    expect(h.armedFor()).toBe(DOCTOR_SCHEDULE_MS + 0.5 * 30 * 60 * 1000);

    h.fireSchedule();
    await flush();
    expect(h.runs).toEqual(["schedule"]);
    h.settle({ outcome: "ok", report: healthy });
    await flush();
    expect(h.armedFor()).toBe(DOCTOR_SCHEDULE_MS + 0.5 * 30 * 60 * 1000);
  });

  test("stop drops the schedule, and a request after it is refused rather than queued", async () => {
    const h = harness();
    h.runner.start();
    h.runner.stop();
    expect(h.armedFor()).toBeNull();

    await expect(h.runner.request("request")).resolves.toEqual({
      outcome: "crashed",
      detail: "the deployment is shutting down",
    });
    expect(h.runs).toEqual([]);
  });
});

describe("one run at a time", () => {
  test("a request during a run joins it and carries its result", async () => {
    const h = harness();
    h.runner.start();
    const first = h.runner.request("schedule");
    const joined = h.runner.request("request", "ops@example.com");
    await flush();

    expect(h.runs).toEqual(["schedule"]);
    h.settle({ outcome: "ok", report: healthy });
    const result = { outcome: "ok", report: healthy };
    await expect(first).resolves.toEqual(result);
    await expect(joined).resolves.toEqual(result);
  });

  test("the joined run keeps the trigger that started it", async () => {
    const h = harness();
    h.runner.start();
    void h.runner.request("schedule");
    void h.runner.request("request", "ops@example.com");
    await flush();
    h.settle({ outcome: "ok", report: healthy });
    await flush();

    expect(last(h.sections).trigger).toBe("schedule");
    expect(last(h.sections).by).toBeUndefined();
  });
});

describe("the doctor section", () => {
  test("a finished run carries its report, its trigger and who asked", async () => {
    const h = harness();
    h.runner.start();
    void h.runner.request("request", "ops@example.com");
    await flush();
    h.advance(90_000);
    h.settle({ outcome: "ok", report: healthy });
    await flush();

    const section = last(h.sections);
    expect(section.report).toEqual(healthy);
    expect(section.at).toBe("2026-05-05T00:01:30.000Z");
    expect(section.trigger).toBe("request");
    expect(section.by).toBe("ops@example.com");
    // The run is over: nothing is running, and nothing failed.
    expect(section.running).toBeUndefined();
    expect(section.lastAttempt).toBeUndefined();
  });

  test("a killed run records the attempt and leaves the last report standing", async () => {
    const h = harness();
    h.runner.start();
    void h.runner.request("boot");
    await flush();
    h.settle({ outcome: "ok", report: healthy });
    await flush();

    h.advance(6 * 60 * 60 * 1000);
    void h.runner.request("schedule");
    await flush();
    h.settle({ outcome: "timed-out", detail: "killed after 330s without a report" });
    await flush();

    const section = last(h.sections);
    expect(section.lastAttempt).toEqual({
      at: "2026-05-05T06:00:00.000Z",
      outcome: "timed-out",
    });
    // The age is the last *report's*, not the last attempt's: a doctor that
    // stopped answering must not look like one that just answered.
    expect(section.report).toEqual(healthy);
    expect(section.at).toBe("2026-05-05T00:00:00.000Z");
    expect(section.trigger).toBe("boot");
  });

  test("a run that throws is a crash, not an unhandled rejection", async () => {
    const failures: string[] = [];
    const runner = createDoctorRunner({
      run: () => Promise.reject(new Error("spawn ENOENT")),
      onSection: () => {},
      onFailure: ({ outcome, detail }) => failures.push(`${outcome}: ${detail}`),
      setTimer: () => ({ clear: () => {} }),
    });
    await expect(runner.request("request")).resolves.toEqual({
      outcome: "crashed",
      detail: "spawn ENOENT",
    });
    expect(failures).toEqual(["crashed: spawn ENOENT"]);
  });

  test("a later success clears the attempt it replaces", async () => {
    const h = harness();
    h.runner.start();
    void h.runner.request("boot");
    await flush();
    h.settle({ outcome: "crashed", detail: "no report on stdout" });
    await flush();
    expect(last(h.sections).lastAttempt?.outcome).toBe("crashed");

    void h.runner.request("schedule");
    await flush();
    h.settle({ outcome: "ok", report: healthy });
    await flush();
    expect(last(h.sections).lastAttempt).toBeUndefined();
  });
});

describe("parseDoctorStdout", () => {
  test("the report is read off stdout", () => {
    expect(parseDoctorStdout(`${JSON.stringify(healthy)}\n`)).toEqual(healthy);
  });

  test("a line a check printed on the way past does not cost the report", () => {
    const noisy = `loading kind module\n{"unrelated":true}\n${JSON.stringify(healthy)}\n`;
    expect(parseDoctorStdout(noisy)).toEqual(healthy);
  });

  test("no report is null, not a throw", () => {
    expect(parseDoctorStdout("")).toBeNull();
    expect(parseDoctorStdout("phoebe doctor: config unreadable\n")).toBeNull();
    expect(parseDoctorStdout("{ truncated mid-writ")).toBeNull();
  });
});

describe("the kill backstop", () => {
  test("it sits thirty seconds past doctor's own deadline", () => {
    expect(DOCTOR_KILL_GRACE_MS).toBe(30 * 1000);
  });
});

describe("spawnDoctor", () => {
  /** A stand-in for the bootstrapper's own entry: whatever `body` prints is doctor's. */
  function fakeDoctor(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-doctor-child-"));
    const entry = join(dir, "doctor.mjs");
    writeFileSync(entry, body);
    return entry;
  }

  test("the report comes back off the child's stdout", async () => {
    const entry = fakeDoctor(
      `process.stdout.write(JSON.stringify(${JSON.stringify(healthy)}) + "\\n")\n`,
    );
    const result = await spawnDoctor({ entry, cwd: tmpdir(), env: process.env, leases: {} });
    expect(result).toEqual({ outcome: "ok", report: healthy });
  });

  test("a failing report is still a successful run — exit 1 is a verdict", async () => {
    const failing = {
      checks: [{ id: "repo", state: "fail", detail: "404" }],
      tenants: [],
      ok: false,
    };
    const entry = fakeDoctor(
      `process.stdout.write(JSON.stringify(${JSON.stringify(failing)}) + "\\n")\nprocess.exitCode = 1\n`,
    );
    const result = await spawnDoctor({ entry, cwd: tmpdir(), env: process.env, leases: {} });
    expect(result).toEqual({ outcome: "ok", report: failing });
  });

  test("the leases reach the child, and only on its env", async () => {
    const entry = fakeDoctor(
      `const leases = process.env.PHOEBE_DOCTOR_LEASES ?? "none"\n` +
        `process.stdout.write(JSON.stringify({ checks: [{ id: "leases", state: "ok", detail: leases }], tenants: [], ok: true }) + "\\n")\n`,
    );
    const result = await spawnDoctor({
      entry,
      cwd: tmpdir(),
      env: process.env,
      leases: { "acme/widget": "ghs_leased" },
    });
    expect(result.outcome).toBe("ok");
    expect(result.outcome === "ok" && result.report.checks[0]!.detail).toBe(
      '{"acme/widget":"ghs_leased"}',
    );
    // The supervisor's own env is not a lease book.
    expect(process.env["PHOEBE_DOCTOR_LEASES"]).toBeUndefined();
  });

  test("a doctor that will not answer is killed, and the attempt says so", async () => {
    const entry = fakeDoctor("setInterval(() => {}, 1000)\n");
    const result = await spawnDoctor({
      entry,
      cwd: tmpdir(),
      env: process.env,
      leases: {},
      killAfterMs: 50,
    });
    expect(result.outcome).toBe("timed-out");
  });

  test("a doctor that dies without printing a report crashed", async () => {
    const entry = fakeDoctor("process.exit(3)\n");
    const result = await spawnDoctor({ entry, cwd: tmpdir(), env: process.env, leases: {} });
    expect(result).toEqual({
      outcome: "crashed",
      detail: "doctor exited 3 without a report on stdout",
    });
  });
});
