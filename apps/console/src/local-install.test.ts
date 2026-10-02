// The local arm's readings and reducers — the half of the install page with no
// React in it.

import { describe, expect, test } from "vite-plus/test";
import { MAX_RUN_LINES } from "phoebe-agent/contracts";
import type { OutcomeOf, VerbRun } from "phoebe-agent/contracts";
import {
  applyRunExit,
  applyRunLine,
  configSetRequest,
  dockerReading,
  installActions,
  installReading,
  landingTab,
  versionReading,
  workspaceChildren,
  localConfig,
  tenantConfigs,
  localConnection,
  offeredVerbs,
  outcomeReading,
  readLiteral,
  receiptReading,
  renderableReport,
  secretSetReading,
  secretSetRequest,
  secretWriterReading,
  pairedInstalls,
  pairReading,
  sameRelay,
} from "./local-install.ts";
import {
  ago,
  cell,
  directory,
  environment,
  install,
  localReport,
  report,
  row,
  tenant,
} from "./test-fixture.ts";

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

describe("which shortcuts a rail entry carries", () => {
  test("start on a stopped install; pause, stop and restart on a running one; none otherwise", () => {
    expect(installActions(install({ state: "stopped" }))).toEqual(["start"]);
    expect(installActions(install({ state: "running" }))).toEqual(["pause", "stop", "restart"]);
    expect(installActions(install({ state: "not-initialised" }))).toEqual([]);
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
      fingerprint: "sha256:0f1e2d3c4b5a6978",
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

describe("what the two write verbs read as (#557)", () => {
  test("a written receipt names the field and the literal that landed", () => {
    expect(
      receiptReading({
        id: "e1",
        state: "written",
        file: "/repos/widget/phoebe.config.ts",
        path: "checkCommand",
        value: "pnpm run check",
        fingerprint: "sha256:after",
        at: ago(1),
      }),
    ).toBe(`wrote checkCommand = "pnpm run check"`);
  });

  test("a refusal names the reason and the why — the two halves an operator acts on", () => {
    expect(
      receiptReading({
        id: "e1",
        state: "refused",
        file: "/repos/widget/phoebe.config.ts",
        path: "engine.ref",
        reason: "not-editable",
        why: "the engine pin moves with `phoebe upgrade`",
        instruction: "write it by hand",
        at: ago(1),
      }),
    ).toBe("refused (not-editable): the engine pin moves with `phoebe upgrade`");
  });

  test("the same outcome shape reads through one reader, whatever the verb", () => {
    expect(
      outcomeReading({
        verb: "secret set",
        outcome: {
          key: "GH_TOKEN",
          tenant: "acme/widget",
          writer: "container",
          target: "the tenant secret store on this install's data volume",
          at: ago(1),
        },
      }),
    ).toContain("through the container");
  });

  test("a host-env write says which file on this machine took it", () => {
    expect(
      secretSetReading({
        key: "GH_TOKEN",
        tenant: null,
        writer: "host-env",
        target: "/repos/widget/.env",
        at: ago(1),
      }),
    ).toBe("set GH_TOKEN into /repos/widget/.env on this machine");
  });

  test("which writer is said before the value is pasted, and it follows the state", () => {
    expect(secretWriterReading(install({ state: "running" }))).toContain("secret store");
    expect(secretWriterReading(install({ state: "stopped" }))).toContain(".env");
    expect(secretWriterReading(install({ state: "not-initialised" }))).toContain(".env");
  });
});

describe("the requests a write form submits (#557)", () => {
  const config = {
    kind: "file" as const,
    path: "/repos/youtube-studio/phoebe.config.ts",
    text: "x",
    fingerprint: "sha256:abc",
  };

  test("`config set` carries the fingerprint the tab was showing, not one that was typed", () => {
    expect(
      configSetRequest({
        install: install(),
        config,
        path: "checkCommand",
        literal: '"pnpm check"',
      }),
    ).toEqual({
      install: "/repos/youtube-studio",
      verb: "config set",
      path: "checkCommand",
      value: "pnpm check",
      fingerprint: "sha256:abc",
    });
  });

  test('a JSON literal keeps its type — 300000 is a number, "300000" a string', () => {
    expect(readLiteral("300000")).toBe(300000);
    expect(readLiteral('"300000"')).toBe("300000");
    expect(readLiteral("true")).toBe(true);
    expect(readLiteral("null")).toBeNull();
  });

  test("a bare word is refused with the quotes it needed", () => {
    expect(() => readLiteral("main")).toThrow(/needs its quotes/);
  });

  test("a block is refused — one leaf moves at a time", () => {
    expect(() => readLiteral('{ "a": 1 }')).toThrow(/scalar or null/);
    expect(() => readLiteral("[1]")).toThrow(/scalar or null/);
  });

  test("no field named is no edit, rather than an edit at the root", () => {
    expect(() =>
      configSetRequest({ install: install(), config, path: "  ", literal: "1" }),
    ).toThrow(/dotted path/);
  });

  test("a folder with no config has nothing to change", () => {
    expect(() =>
      configSetRequest({
        install: install(),
        config: { kind: "absent", path: "/repos/youtube-studio/phoebe.config.ts" },
        path: "checkCommand",
        literal: '"x"',
      }),
    ).toThrow(/no \/repos\/youtube-studio\/phoebe.config.ts/);
  });

  test("`secret set` carries the value as a run argument and no envelope of any kind", () => {
    const request = secretSetRequest({ install: install(), key: "GH_TOKEN", value: "ghp_x" });

    expect(request).toEqual({
      install: "/repos/youtube-studio",
      verb: "secret set",
      key: "GH_TOKEN",
      value: "ghp_x",
    });
    expect(Object.keys(request)).not.toContain("envelope");
  });

  test("an empty tenant box is left off, so the install decides for itself", () => {
    expect(
      secretSetRequest({ install: install(), key: "GH_TOKEN", value: "ghp_x", tenant: "   " }),
    ).not.toHaveProperty("tenant");
    expect(
      secretSetRequest({
        install: install(),
        key: "GH_TOKEN",
        value: "ghp_x",
        tenant: "acme/widget",
      }),
    ).toMatchObject({ tenant: "acme/widget" });
  });

  test("a blank is not a secret — clearing one is a different verb", () => {
    expect(() => secretSetRequest({ install: install(), key: "GH_TOKEN", value: "" })).toThrow(
      /blank is not a secret/,
    );
  });
});

// ── pairing ───────────────────────────────────────────────────────────────

const RELAY = "https://relay.example.test";
const DIALLED = "wss://relay.example.test/deployments";

/** A fleet row, in the shape the join reads. */
function fact(name: string, fingerprint: string) {
  return { row: row({ name, fingerprint }) };
}

describe("which installs are also rows on the relay", () => {
  test("an install dialling this relay under a row's name is that row", () => {
    const one = install({ dir: "/repos/one", deploymentName: "the-fleet", relayUrl: DIALLED });

    const paired = pairedInstalls([one], [fact("the-fleet", "FP1")], RELAY);

    expect(paired.get("/repos/one")).toBe("FP1");
  });

  test("an install that dials nothing is nobody's row", () => {
    const one = install({ dir: "/repos/one", deploymentName: "the-fleet", relayUrl: null });

    expect(pairedInstalls([one], [fact("the-fleet", "FP1")], RELAY).size).toBe(0);
  });

  test("an install dialling a different relay is not this relay's row, name or no name", () => {
    const one = install({
      dir: "/repos/one",
      deploymentName: "the-fleet",
      relayUrl: "wss://other.test/deployments",
    });

    expect(pairedInstalls([one], [fact("the-fleet", "FP1")], RELAY).size).toBe(0);
  });

  test("an install the relay has never seen is configured, not paired", () => {
    const one = install({ dir: "/repos/one", deploymentName: "the-fleet", relayUrl: DIALLED });

    expect(pairedInstalls([one], [fact("something-else", "FP1")], RELAY).size).toBe(0);
  });

  test("a console with no relay session joins nothing", () => {
    const one = install({ dir: "/repos/one", deploymentName: "the-fleet", relayUrl: DIALLED });

    expect(pairedInstalls([one], [fact("the-fleet", "FP1")], null).size).toBe(0);
  });

  test("two installs, two rows, each to its own", () => {
    const one = install({ dir: "/repos/one", deploymentName: "one", relayUrl: DIALLED });
    const two = install({ dir: "/repos/two", deploymentName: "two", relayUrl: DIALLED });

    const paired = pairedInstalls([one, two], [fact("two", "FP2"), fact("one", "FP1")], RELAY);

    expect([...paired]).toEqual([
      ["/repos/one", "FP1"],
      ["/repos/two", "FP2"],
    ]);
  });
});

describe("sameRelay", () => {
  test("the wss address a deployment dials and the https one a person signs in at", () => {
    expect(sameRelay(DIALLED, RELAY)).toBe(true);
  });

  test("a different host is a different relay", () => {
    expect(sameRelay("wss://other.test/deployments", RELAY)).toBe(false);
  });

  test("a port is part of the host, because it is part of the relay", () => {
    expect(sameRelay("wss://relay.example.test:8443/deployments", RELAY)).toBe(false);
  });

  test("something that is not a URL is not a match, and not a crash", () => {
    expect(sameRelay("not a url", RELAY)).toBe(false);
  });
});

describe("whether this install can be paired", () => {
  test("a running install on a signed-in companion is ready", () => {
    const reading = pairReading(install({ state: "running" }), { signedIn: true, paired: false });

    expect(reading.kind).toBe("ready");
  });

  test("signed out, the reason names the sign-in rather than the install", () => {
    const reading = pairReading(install({ state: "running" }), { signedIn: false, paired: false });

    expect(reading).toEqual({ kind: "blocked", reason: expect.stringContaining("Sign in") });
  });

  test("a stopped install is blocked, because a stopped container spends nothing", () => {
    const reading = pairReading(install({ state: "stopped" }), { signedIn: true, paired: false });

    expect(reading).toEqual({ kind: "blocked", reason: expect.stringContaining("Start") });
  });

  test("a not-initialised folder is blocked by the same rule", () => {
    const reading = pairReading(install({ state: "not-initialised" }), {
      signedIn: true,
      paired: false,
    });

    expect(reading.kind).toBe("blocked");
  });

  test("an install that is already a row is paired, and is offered nothing to press", () => {
    const reading = pairReading(install({ state: "running" }), { signedIn: true, paired: true });

    expect(reading.kind).toBe("paired");
  });

  test("signed out wins over stopped: there is nothing to pair with either way", () => {
    const reading = pairReading(install({ state: "stopped" }), { signedIn: false, paired: false });

    expect(reading).toEqual({ kind: "blocked", reason: expect.stringContaining("Sign in") });
  });
});

describe("what a finished pairing reads as", () => {
  test("names the deployment, the relay and when the token dies", () => {
    const reading = outcomeReading({
      verb: "pair",
      outcome: {
        relayUrl: DIALLED,
        deploymentName: "the-fleet",
        expiresAt: "2026-09-18T12:15:00.000Z",
        movedRelay: false,
      },
    });

    expect(reading).toContain("the-fleet");
    expect(reading).toContain(DIALLED);
    expect(reading).toContain("2026-09-18T12:15:00.000Z");
    expect(reading).not.toContain("moved");
  });

  test("says when the pairing moved the install off another relay", () => {
    const reading = outcomeReading({
      verb: "pair",
      outcome: {
        relayUrl: DIALLED,
        deploymentName: "the-fleet",
        expiresAt: "2026-09-18T12:15:00.000Z",
        movedRelay: true,
      },
    });

    expect(reading).toContain("moved off the relay it named before");
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

describe("what a workspace's children are doing, for the rail", () => {
  const workspace = install({
    dir: "/repos/ws",
    name: "ws",
    workspace: {
      children: [
        { dir: "/repos/ws/a", name: "a", slug: "acme/a" },
        { dir: "/repos/ws/b", name: "b", slug: null },
        { dir: "/repos/ws/c", name: "c", slug: "acme/c" },
        { dir: "/repos/ws/d", name: "d", slug: "acme/d" },
        { dir: "/repos/ws/e", name: "e", slug: "acme/e" },
      ],
    },
  });
  const fleet = {
    tenants: [
      tenant({ id: "/w/a", path: "/w/a", slug: "acme/a", held: true }),
      // Matched by folder when the config has no slug.
      tenant({ id: "/w/b", path: "/w/b/", slug: "acme/other", held: false }),
      tenant({ id: "/w/c", path: "/w/c", slug: "acme/c" }),
      tenant({ id: "/w/d", path: "/w/d", slug: "acme/d" }),
    ],
    cells: [
      cell({ id: "/w/b#work", tenant: tenant({ id: "/w/b" }), state: "working" }),
      cell({
        id: "/w/c#work",
        tenant: tenant({ id: "/w/c" }),
        state: "idle",
        wedged: { wedged: true, reason: "no-pass", noPassForMs: 1_020_000 },
      }),
      cell({ id: "/w/d#work", tenant: tenant({ id: "/w/d" }), state: "waiting for slot" }),
    ],
    updatedAt: ago(12),
  };
  const event = localReport({
    facts: workspace,
    report: { schema: report().schema, receivedAt: ago(2), report: report({ fleet }) },
  });

  test("labels each child by slug, else folder, and says what the fleet has it doing", () => {
    expect(workspaceChildren(workspace, event)).toEqual([
      { dir: "/repos/ws/a", slug: "acme/a", label: "acme/a", tone: "attention", text: "held" },
      { dir: "/repos/ws/b", slug: null, label: "b", tone: "running", text: "working" },
      { dir: "/repos/ws/c", slug: "acme/c", label: "acme/c", tone: "attention", text: "wedged" },
      {
        dir: "/repos/ws/d",
        slug: "acme/d",
        label: "acme/d",
        tone: "running",
        text: "waiting for a slot",
      },
      {
        dir: "/repos/ws/e",
        slug: "acme/e",
        label: "acme/e",
        tone: "idle",
        text: "not in the fleet",
      },
    ]);
  });

  test("a tenant with no pipelines says so; one whose cells all idle is idle", () => {
    const quiet = localReport({
      facts: workspace,
      report: {
        schema: report().schema,
        receivedAt: ago(2),
        report: report({
          fleet: {
            tenants: [
              tenant({ id: "/w/a", path: "/w/a", slug: "acme/a" }),
              tenant({ id: "/w/c", path: "/w/c", slug: "acme/c" }),
            ],
            cells: [cell({ id: "/w/c#work", tenant: tenant({ id: "/w/c" }), state: "idle" })],
            updatedAt: ago(12),
          },
        }),
      },
    });
    const [a, , c] = workspaceChildren(
      install({
        dir: "/repos/ws",
        workspace: {
          children: [
            { dir: "/repos/ws/a", name: "a", slug: "acme/a" },
            { dir: "/repos/ws/b", name: "b", slug: null },
            { dir: "/repos/ws/c", name: "c", slug: "acme/c" },
          ],
        },
      }),
      quiet,
    );

    expect(a).toMatchObject({ tone: "idle", text: "no pipelines" });
    expect(c).toMatchObject({ tone: "idle", text: "idle" });
  });

  test("a stopped workspace lists its folders with nothing to say about them", () => {
    const stopped = install({ ...workspace, state: "stopped" });

    expect(workspaceChildren(stopped, localReport({ facts: stopped }))).toEqual(
      workspace.workspace!.children.map((child) => ({
        dir: child.dir,
        slug: child.slug,
        label: child.slug ?? child.name,
        tone: "stopped",
        text: "",
      })),
    );
    expect(workspaceChildren(workspace, null)).toHaveLength(5);
  });

  test("a solo install has no children", () => {
    expect(workspaceChildren(install(), event)).toEqual([]);
  });
});

describe("a workspace's tenant configs, for the config tab", () => {
  test("one reading per child, labelled by slug else folder, absent when there is no file", () => {
    const event = localReport({
      directory: directory({
        tenants: [
          {
            dir: "/w/a",
            name: "a",
            slug: "acme/a",
            configPath: "/w/a/phoebe.config.ts",
            configText: "export default {}\n",
            configFingerprint: "sha256:aa",
          },
          {
            dir: "/w/b",
            name: "b",
            slug: null,
            configPath: "/w/b/phoebe.config.ts",
            configText: null,
            configFingerprint: null,
          },
        ],
      }),
    });

    expect(tenantConfigs(event)).toEqual([
      {
        dir: "/w/a",
        label: "acme/a",
        config: {
          kind: "file",
          path: "/w/a/phoebe.config.ts",
          text: "export default {}\n",
          fingerprint: "sha256:aa",
        },
      },
      { dir: "/w/b", label: "b", config: { kind: "absent", path: "/w/b/phoebe.config.ts" } },
    ]);
  });

  test("nothing on a solo install, before the first read, or from a companion that does not read them", () => {
    expect(tenantConfigs(localReport())).toEqual([]);
    expect(tenantConfigs(null)).toEqual([]);
  });

  test("a config set aimed at a tenant carries its folder", () => {
    const config = {
      kind: "file" as const,
      path: "/w/a/phoebe.config.ts",
      text: "x",
      fingerprint: "sha256:aa",
    };
    expect(
      configSetRequest({
        install: install(),
        config,
        path: "engine.ref",
        literal: '"main"',
        tenant: "/w/a",
      }),
    ).toMatchObject({
      verb: "config set",
      tenant: "/w/a",
      fingerprint: "sha256:aa",
      value: "main",
    });
    expect(
      configSetRequest({ install: install(), config, path: "engine.ref", literal: '"main"' }),
    ).not.toHaveProperty("tenant");
  });
});
