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
  landingTab,
  localConfig,
  localConnection,
  offeredVerbs,
  outcomeReading,
  renderableReport,
  versionReading,
} from "./local-install.ts";
import { directory, environment, install, localReport } from "./test-fixture.ts";

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

describe("the local read, as the page reads it", () => {
  test("the connection card names the arm, the path and the bridge (#556)", () => {
    const card = localConnection(install());

    expect(card.arm).toBe("Local install");
    expect(card.detail).toBe("/repos/youtube-studio");
    expect(card.note).toContain("desktop bridge");
    expect(card.note).toContain("No relay");
  });

  test("the card says what the container is doing, in the install's own three words", () => {
    expect(localConnection(install({ state: "running" })).note).toContain("its container is up");
    expect(localConnection(install({ state: "stopped" })).note).toContain(
      "its container is not up",
    );
    expect(localConnection(install({ state: "not-initialised" })).note).toContain(
      "no Phoebe install",
    );
  });

  test("a running install renders the report the loop read", () => {
    const event = localReport();

    expect(renderableReport(install(), event)?.report).toEqual(event.report?.report);
  });

  test("a stopped install renders no report, however fresh the last one was (#526)", () => {
    // The event still carries one: main read it while the container was up and
    // the window has held it since. Rendering it would put a description of a
    // running deployment beside a container that is down.
    const held = localReport({ facts: install({ state: "running" }) });

    expect(renderableReport(install({ state: "stopped" }), held)).toBeNull();
  });

  test("an event for another install is not this install's report", () => {
    const other = localReport({ facts: install({ dir: "/repos/elsewhere" }) });

    expect(renderableReport(install(), other)).toBeNull();
  });

  test("lands on install when there is nothing installed, on config when nothing runs", () => {
    expect(landingTab(install({ state: "not-initialised" }))).toBe("install");
    expect(landingTab(install({ state: "stopped" }))).toBe("config");
    expect(landingTab(install({ state: "running" }))).toBe("overview");
  });

  test("the config comes off the directory facts, which a stopped install still has", () => {
    const event = localReport({
      facts: install({ state: "stopped" }),
      directory: directory({ bootstrapperRunning: false }),
    });

    expect(localConfig(event)).toEqual({
      kind: "file",
      path: "/repos/youtube-studio/phoebe.config.ts",
      text: directory().configText,
      fingerprint: "0f1e2d3c4b5a6978",
    });
  });

  test("a folder with no config says which file is missing", () => {
    const event = localReport({
      directory: directory({ configText: null, configFingerprint: null }),
    });

    expect(localConfig(event)).toEqual({
      kind: "absent",
      path: "/repos/youtube-studio/phoebe.config.ts",
    });
  });

  test("before the first read there is no config to show, which is not the same as none", () => {
    expect(localConfig(null)).toBeNull();
  });
});

describe("the two versions the install tab states", () => {
  test("names the container's pin and the companion's own, side by side", () => {
    const reading = versionReading(
      install({ containerVersion: "0.12.1" }),
      environment({ companionVersion: "0.13.0" }),
    );

    expect(reading.text).toBe("container 0.12.1 · companion 0.13.0");
  });

  test("a difference is a sentence, never a refusal (#525 §6)", () => {
    const reading = versionReading(
      install({ containerVersion: "0.12.1" }),
      environment({ companionVersion: "0.13.0" }),
    );

    expect(reading.note).toContain("Nothing here refuses");
    expect(reading.note).toContain("Check for upgrades");
    // The remedy is a button in this same section, and it stays offered.
    expect(offeredVerbs(install({ containerVersion: "0.12.1" })).upgrade).toBe(true);
  });

  test("two halves that agree have nothing more to say", () => {
    const reading = versionReading(
      install({ containerVersion: "0.13.0" }),
      environment({ companionVersion: "0.13.0" }),
    );

    expect(reading.note).toBeNull();
  });

  test("an unpinned Dockerfile says which build it will get rather than a version", () => {
    const reading = versionReading(install({ containerVersion: null }), environment());

    expect(reading.text).toBe("container — · companion 0.13.0");
    expect(reading.note).toContain("pins no phoebe-agent version");
  });

  test("a folder with no container says that, not that its version is missing", () => {
    const reading = versionReading(
      install({ state: "not-initialised", containerVersion: null }),
      environment(),
    );

    expect(reading.note).toContain("no container yet");
  });

  test("a machine still being probed shows the half it has", () => {
    const reading = versionReading(install({ containerVersion: "0.13.0" }), null);

    expect(reading.text).toBe("container 0.13.0 · companion —");
    expect(reading.note).toBeNull();
  });
});
