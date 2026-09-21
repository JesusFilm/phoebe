// The local arm's readings and reducers — the half of the install page with no
// React in it.

import { describe, expect, test } from "vite-plus/test";
import { MAX_RUN_LINES } from "phoebe-agent/contracts";
import type { OutcomeOf, VerbRun } from "phoebe-agent/contracts";
import {
  applyRunExit,
  applyRunLine,
  dockerReading,
  installReading,
  offeredVerbs,
  outcomeReading,
} from "./local-install.ts";
import { environment, install } from "./test-fixture.ts";

function runOf(overrides: Partial<VerbRun> = {}): VerbRun {
  return {
    runId: "run-1",
    install: "/repos/youtube-studio",
    verb: "stop",
    startedAt: "2026-09-18T12:00:00.000Z",
    lines: [],
    ...overrides,
  };
}

describe("how the rail reads an install", () => {
  test("says the three words Compose can answer, and no fourth", () => {
    const words = (["running", "stopped", "not-initialised"] as const).map(
      (state) => installReading(install({ state })).text,
    );

    expect(words).toEqual(["running", "stopped", "not initialised"]);
  });

  test("carries no relay verdict, because there is no silence to read here", () => {
    for (const state of ["running", "stopped", "not-initialised"] as const) {
      const reading = installReading(install({ state }));
      for (const word of ["dark", "unseen", "disconnected"]) {
        expect(reading.text, word).not.toContain(word);
      }
    }
  });

  test("puts the reason beside the state when there is one", () => {
    const reading = installReading(
      install({ state: "stopped", detail: "`docker` is not on PATH, so nothing can be running" }),
    );

    expect(reading.text).toBe("stopped · `docker` is not on PATH, so nothing can be running");
  });
});

describe("which verbs an install offers", () => {
  test("a folder with no install in it offers init and nothing that needs one", () => {
    const offered = offeredVerbs(install({ state: "not-initialised" }));

    expect(offered).toEqual({
      init: true,
      start: false,
      stop: false,
      upgrade: false,
      doctor: false,
    });
  });

  test("an adopted folder is never offered init over the top of its config", () => {
    // A folder that already carries a config is adopted as it stands (#555).
    for (const state of ["running", "stopped"] as const) {
      expect(offeredVerbs(install({ state })).init, state).toBe(false);
    }
  });

  test("start and stop are offered by what the container is doing, never both", () => {
    expect(offeredVerbs(install({ state: "stopped" }))).toMatchObject({ start: true, stop: false });
    expect(offeredVerbs(install({ state: "running" }))).toMatchObject({ start: false, stop: true });
  });

  test("doctor needs the container it reads through", () => {
    expect(offeredVerbs(install({ state: "stopped" })).doctor).toBe(false);
    expect(offeredVerbs(install({ state: "running" })).doctor).toBe(true);
  });
});

describe("a run's events", () => {
  test("appends a line for the run it belongs to", () => {
    const run = applyRunLine(runOf(), { runId: "run-1", stream: "stdout", line: "up" });

    expect(run?.lines).toEqual([{ runId: "run-1", stream: "stdout", line: "up" }]);
  });

  test("ignores a line from another install's run, which arrives on the same channel", () => {
    // Runs are parallel across installs (#527 §2), so every page sees every
    // line. A page that applied all of them would show two runs interleaved.
    const run = applyRunLine(runOf(), { runId: "run-9", stream: "stdout", line: "elsewhere" });

    expect(run?.lines).toEqual([]);
  });

  test("keeps the same bound main keeps", () => {
    let run: VerbRun | null = runOf();
    for (let index = 0; index < MAX_RUN_LINES + 10; index += 1) {
      run = applyRunLine(run, { runId: "run-1", stream: "stdout", line: `line ${index}` });
    }

    expect(run?.lines).toHaveLength(MAX_RUN_LINES);
    expect(run?.lines.at(-1)?.line).toBe(`line ${MAX_RUN_LINES + 9}`);
  });

  test("an exit ends the run it names and nothing else", () => {
    expect(applyRunExit(runOf(), { runId: "run-1", code: 0 })?.exit).toEqual({
      runId: "run-1",
      code: 0,
    });
    expect(applyRunExit(runOf(), { runId: "run-9", code: 0 })?.exit).toBeUndefined();
  });
});

describe("what an outcome reads as", () => {
  test("names what start actually did, from the typed outcome and not from stdout", () => {
    expect(outcomeReading({ verb: "start", outcome: { kind: "started" } })).toBe("started");
    expect(outcomeReading({ verb: "start", outcome: { kind: "already-running" } })).toBe(
      "already running",
    );
    expect(
      outcomeReading({ verb: "start", outcome: { kind: "exited-immediately", exitCode: 1 } }),
    ).toContain("exited immediately");
  });

  test("tells a drained stop from a killed one, which is the distinction stop exists to make", () => {
    expect(outcomeReading({ verb: "stop", outcome: { kind: "stopped" } })).toBe("stopped");
    expect(outcomeReading({ verb: "stop", outcome: { kind: "killed-mid-run" } })).toContain(
      "killed",
    );
  });

  test("an upgrade check says where things stand rather than what it changed", () => {
    const report = {
      engine: {
        source: "github" as const,
        ref: "v1",
        latest: "v1",
        tracking: false,
        behind: false,
      },
      cli: { installed: "1.0.0", latest: "1.0.0", behind: false },
      ok: true,
    };

    expect(
      outcomeReading({ verb: "upgrade", outcome: { kind: "checked", report, ok: true } }),
    ).toBe("both halves are current");
    expect(
      outcomeReading({
        verb: "upgrade",
        outcome: { kind: "checked", report: { ...report, ok: false }, ok: false },
      }),
    ).toContain("behind");
  });

  test("init counts the files it wrote, because that is all init did", () => {
    expect(
      outcomeReading({
        verb: "init",
        outcome: {
          profile: "solo",
          targetDir: "/repos/one",
          created: ["phoebe.config.ts"],
          updated: [],
          skipped: [".gitignore"],
        },
      }),
    ).toBe("1 file created, 0 updated, 1 left alone");
  });

  test("doctor counts the checks that were not ok, since that is the whole report", () => {
    const report = (states: ("ok" | "warn" | "fail")[]): OutcomeOf<"doctor"> => ({
      checks: states.map((state, index) => ({ id: `c${index}`, state, detail: "" })),
      tenants: [],
      ok: states.every((state) => state !== "fail"),
    });

    expect(outcomeReading({ verb: "doctor", outcome: report(["ok", "ok"]) })).toBe(
      "every check passed",
    );
    expect(outcomeReading({ verb: "doctor", outcome: report(["ok", "warn"]) })).toContain("warned");
    expect(outcomeReading({ verb: "doctor", outcome: report(["fail", "warn"]) })).toContain(
      "failed",
    );
  });
});

describe("the Docker check", () => {
  test("waits before saying anything, rather than saying Docker is missing", () => {
    expect(dockerReading(null)).toEqual({ kind: "probing" });
  });

  test("tells a missing binary from a daemon that is not up", () => {
    // Two different things for the operator to do, so they are two readings and
    // not one "Docker is not available".
    expect(
      dockerReading(
        environment({ docker: { present: false, composeVersion: null, daemonRunning: false } }),
      ).kind,
    ).toBe("missing");
    expect(
      dockerReading(
        environment({ docker: { present: true, composeVersion: "v2", daemonRunning: false } }),
      ).kind,
    ).toBe("daemon-down");
  });

  test("names both versions on a machine that is ready, which is the install tab's version line", () => {
    const reading = dockerReading(environment());

    expect(reading).toEqual({
      kind: "ready",
      text: "Docker is running · Compose v2.29.7 · companion 0.13.0 on linux",
    });
  });

  test("a Docker with no Compose plugin still reads as ready, without inventing a version", () => {
    const reading = dockerReading(
      environment({ docker: { present: true, composeVersion: null, daemonRunning: true } }),
    );

    expect(reading).toEqual({
      kind: "ready",
      text: "Docker is running · companion 0.13.0 on linux",
    });
  });
});
