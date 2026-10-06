import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ConfigFieldFacts,
  DesktopBridge,
  HarnessFacts,
  HarnessName,
  HarnessPin,
  HarnessReport,
  RunExit,
  TenantConfigFacts,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import {
  awaitingRebuild,
  engineReading,
  engineStanding,
  harnessReading,
  harnessRows,
  harnessStanding,
  harnessUsers,
  launcherStanding,
  launcherVersionOf,
  phoebeVersions,
  providerOf,
  updateReading,
  updateVerb,
  upgradeReading,
} from "./harness.ts";
import { HarnessPanel, HarnessSection, PhoebePanel } from "./harness-section.tsx";
import { workspaceChildren } from "./local-install.ts";
import { ago, bridge, directory, install, localReport } from "./test-fixture.ts";
import { rebuildRequests, runInSequence } from "./verb-run.ts";

/** The provider row of a config's field facts: set to `value`, or left to the default. */
function provider(value?: HarnessName): ConfigFieldFacts[] {
  return [
    {
      path: "defaultProvider",
      scope: "tenant",
      env: "PHOEBE_AGENT",
      type: "enum",
      values: ["cursor", "claude", "codex"],
      default: "cursor",
      ...(value === undefined ? { state: "unset" } : { state: "set", value }),
    },
  ];
}

function tenant(name: string, fields: ConfigFieldFacts[] | undefined): TenantConfigFacts {
  return {
    dir: `/repos/ws/${name}`,
    name,
    slug: `acme/${name}`,
    configPath: `/repos/ws/${name}/phoebe.config.ts`,
    configText: "export default {}\n",
    configFingerprint: "sha256:aa",
    ...(fields === undefined ? {} : { configFields: fields }),
  };
}

const pins = (claude: HarnessPin, codex: HarnessPin = { kind: "absent" }) => [
  { harness: "cursor" as const, pin: { kind: "pinned" as const, version: "2026.07.23-e383d2b" } },
  { harness: "claude" as const, pin: claude },
  { harness: "codex" as const, pin: codex },
];

const workspace = install({
  dir: "/repos/ws",
  name: "ws",
  state: "stopped",
  workspace: {
    children: [
      { dir: "/repos/ws/a", name: "a", slug: "acme/a" },
      { dir: "/repos/ws/b", name: "b", slug: "acme/b" },
      { dir: "/repos/ws/c", name: "c", slug: "acme/c" },
    ],
  },
});

function event(claude: HarnessPin = { kind: "pinned", version: "2.1.228" }) {
  return localReport({
    facts: workspace,
    directory: directory({
      bootstrapperRunning: false,
      tenants: [
        tenant("a", provider("claude")),
        tenant("b", provider()),
        tenant("c", provider("claude")),
      ],
      harnessPins: pins(claude),
    }),
  });
}

function facts(overrides: Partial<HarnessFacts> & { harness: HarnessName }): HarnessFacts {
  return { pin: { kind: "absent" }, running: null, latest: null, behind: null, ...overrides };
}

function report(overrides: Partial<HarnessReport> = {}): HarnessReport {
  return {
    dockerfile: "/repos/ws/container/Dockerfile",
    containerAsked: true,
    latestAt: "2026-10-01T12:00:00.000Z",
    user: { root: false, dockerfileDrops: true, unwritable: [] },
    launcher: {
      pin: { kind: "pinned", version: "0.13.2" },
      running: "0.13.0",
      latest: "0.14.1",
      behind: true,
    },
    harnesses: [
      facts({
        harness: "cursor",
        pin: { kind: "pinned", version: "2026.07.23-e383d2b" },
        running: "2026.07.23-e383d2b",
        latest: "2026.10.01-e373342",
        behind: true,
      }),
      facts({
        harness: "claude",
        pin: { kind: "pinned", version: "2.1.287" },
        running: "2.1.228",
        latest: "2.1.287",
        behind: false,
      }),
      facts({ harness: "codex", latest: "0.160.0" }),
    ],
    ...overrides,
  };
}

describe("which provider a config runs", () => {
  test("is the literal it sets, or the default when it sets none", () => {
    expect(providerOf(provider("codex"))).toBe("codex");
    expect(providerOf(provider())).toBe("cursor");
  });

  test("is unknown when the file computes it, or there are no fields to read", () => {
    expect(providerOf([{ ...provider()[0]!, state: "computed" }])).toBeNull();
    expect(providerOf(undefined)).toBeNull();
    expect(providerOf([])).toBeNull();
  });

  test("a workspace's users are its tenants; a solo install's is itself", () => {
    expect(harnessUsers(workspace, event())).toEqual([
      { dir: "/repos/ws/a", label: "acme/a", harness: "claude" },
      { dir: "/repos/ws/b", label: "acme/b", harness: "cursor" },
      { dir: "/repos/ws/c", label: "acme/c", harness: "claude" },
    ]);
    const solo = install({ dir: "/repos/one", name: "one" });
    expect(
      harnessUsers(
        solo,
        localReport({ facts: solo, directory: directory({ configFields: provider("codex") }) }),
      ),
    ).toEqual([{ dir: "/repos/one", label: "one", harness: "codex" }]);
    expect(harnessUsers(workspace, null)).toEqual([]);
  });
});

describe("the rows a page draws", () => {
  const users = harnessUsers(workspace, event());

  test("before any check, the pins that came with the read are enough to list them", () => {
    const rows = harnessRows(null, event(), users);

    // Codex is neither installed nor run by anyone, so it is not a row.
    expect(rows.map((row) => row.harness)).toEqual(["cursor", "claude"]);
    expect(rows[1]).toMatchObject({
      label: "Claude Code",
      pin: { kind: "pinned", version: "2.1.228" },
      running: null,
      usedBy: ["acme/a", "acme/c"],
    });
  });

  test("a check's facts replace them", () => {
    const rows = harnessRows(report(), event(), users);

    expect(rows[1]).toMatchObject({ running: "2.1.228", latest: "2.1.287", behind: false });
  });

  test("a harness somebody runs is listed even when nothing installs it", () => {
    const rows = harnessRows(null, event({ kind: "absent" }), users);

    expect(rows[1]).toMatchObject({ harness: "claude", pin: { kind: "absent" } });
    expect(harnessStanding(rows[1]!)).toEqual({ text: "missing", tone: "fail" });
  });

  test("a tenant's page narrows to the one it runs", () => {
    expect(harnessRows(report(), event(), users, "claude").map((row) => row.harness)).toEqual([
      "claude",
    ]);
  });

  test("says the pin, what the container has, and the latest, leaving out what is unknown", () => {
    const [cursor, claude] = harnessRows(report(), event(), users);

    expect(harnessReading(claude!, true)).toBe(
      "pinned to 2.1.287 · the container has 2.1.228 · latest 2.1.287",
    );
    expect(harnessReading({ ...cursor!, running: null, latest: null }, false)).toBe(
      "pinned to 2026.07.23-e383d2b",
    );
    expect(harnessReading({ ...cursor!, running: null, latest: null }, true)).toBe(
      "pinned to 2026.07.23-e383d2b · the container does not have it",
    );
    expect(harnessStanding(cursor!)).toEqual({ text: "behind", tone: "warn" });
    // The pin is the latest, and the container is not on it yet.
    expect(harnessStanding(claude!)).toEqual({ text: "needs rebuild", tone: "warn" });
    expect(harnessStanding({ ...claude!, running: "2.1.287" })).toEqual({
      text: "current",
      tone: "ok",
    });
  });

  test("a pin the container has not caught up with is waiting on a rebuild", () => {
    const rows = harnessRows(report(), event(), users);

    expect(awaitingRebuild(rows).map((row) => row.harness)).toEqual(["claude"]);
  });

  test("the button is named for what it would do", () => {
    expect(updateVerb({ kind: "pinned", version: "1.0.0" })).toBe("Update");
    expect(updateVerb({ kind: "unpinned" })).toBe("Pin");
    expect(updateVerb({ kind: "absent" })).toBe("Install");
  });

  test("an update's outcome is a sentence", () => {
    expect(
      updateReading({
        kind: "moved",
        harness: "claude",
        from: "2.1.228",
        to: "2.1.287",
        file: "f",
      }),
    ).toContain("now pins Claude Code 2.1.287 (was 2.1.228)");
    expect(
      updateReading({ kind: "refused", harness: "cursor", why: "no pin", instruction: "Copy it." }),
    ).toBe("Cursor agent was not moved: no pin. Copy it.");
  });
});

describe("the section on screen", () => {
  const users = harnessUsers(workspace, event());
  const noop = (): void => undefined;

  function panel(overrides: Partial<Parameters<typeof HarnessPanel>[0]> = {}) {
    return renderToStaticMarkup(
      <HarnessPanel
        install={workspace}
        rows={harnessRows(report(), event(), users)}
        shared={false}
        containerAsked
        latestAt="2026-10-01T12:00:00.000Z"
        lookingUp={false}
        updating={null}
        outcome={null}
        trouble={null}
        busy={false}
        onLookUp={noop}
        onUpdate={noop}
        onRebuild={noop}
        {...overrides}
      />,
    );
  }

  test("lists each harness with its versions, who runs it, and a field to move it", () => {
    const markup = panel();

    expect(markup).toContain('aria-label="AI harness"');
    expect(markup).toContain("pinned to 2.1.287 · the container has 2.1.228 · latest 2.1.287");
    expect(markup).toContain("Runs acme/a, acme/c");
    // The field offers the latest known, ready to press.
    expect(markup).toMatch(/aria-label="Version of Cursor agent"[^>]*value="2026.10.01-e373342"/);
    expect(markup).toContain("Check for updates");
  });

  test("a pin ahead of the container says so and offers the rebuild", () => {
    const markup = panel();

    expect(markup).toContain("The Dockerfile pins Claude Code 2.1.287 and the");
    expect(markup).toContain("Rebuild and start");
    expect(panel({ install: { ...workspace, state: "running" } })).toContain("Rebuild and restart");
  });

  test("with nothing waiting there is no rebuild to offer", () => {
    const settled = report({
      harnesses: [
        facts({
          harness: "claude",
          pin: { kind: "pinned", version: "2.1.287" },
          running: "2.1.287",
          latest: "2.1.287",
          behind: false,
        }),
      ],
    });

    expect(panel({ rows: harnessRows(settled, event(), users) })).not.toContain("Rebuild");
  });

  test("a move just made is not said twice", () => {
    const markup = panel({
      outcome: { kind: "moved", harness: "claude", from: "2.1.228", to: "2.1.287", file: "f" },
    });

    expect(markup).toContain("The Dockerfile now pins Claude Code 2.1.287 (was 2.1.228)");
    expect(markup).not.toContain("Rebuild to pick the pin up");
    expect(markup).toContain("Rebuild and start");
  });

  test("a move just made is said, with the rebuild beside it", () => {
    const markup = panel({
      outcome: {
        kind: "moved",
        harness: "cursor",
        from: "2026.07.23-e383d2b",
        to: "2026.10.01-e373342",
        file: "f",
      },
    });

    expect(markup).toContain("The Dockerfile now pins Cursor agent 2026.10.01-e373342");
    expect(markup).toContain("Rebuild and start");
  });

  test("a provider with no CLI in the container is the loudest thing in its row", () => {
    const markup = panel({ rows: harnessRows(null, event({ kind: "absent" }), users) });

    expect(markup).toContain("acme/a, acme/c run on it, and the container has no such CLI");
    expect(markup).toContain(">Install<");
  });

  test("on a tenant's page it says the container is shared", () => {
    const markup = panel({ shared: true, rows: harnessRows(report(), event(), users, "claude") });

    expect(markup).toContain("which every tenant in it shares");
    expect(markup).not.toContain("Cursor agent");
    // Whose it runs is the page's own heading, so the row does not repeat it.
    expect(markup).not.toContain("Runs acme/a");
  });

  test("before a look-up it says nothing has been asked, and what asking would ask", () => {
    expect(panel({ latestAt: null })).toContain("Checking asks npm and Cursor");
  });

  test("an install with no Dockerfile has no section at all", () => {
    const bare = localReport({
      facts: workspace,
      directory: directory({ bootstrapperRunning: false }),
    });

    expect(
      renderToStaticMarkup(
        <HarnessSection
          install={workspace}
          bridge={bridge()}
          event={bare}
          busy={false}
          onRebuild={noop}
        />,
      ),
    ).toBe("");
    // With pins on the read, it draws from them before any check has answered.
    expect(
      renderToStaticMarkup(
        <HarnessSection
          install={workspace}
          bridge={bridge()}
          event={event()}
          tenant="/repos/ws/a"
          busy={false}
          onRebuild={noop}
        />,
      ),
    ).toContain("pinned to 2.1.228");
  });
});

describe("the rail, for a tenant whose provider the container cannot run", () => {
  test("is a warning on its row, on a stopped workspace too", () => {
    const rows = workspaceChildren(workspace, event({ kind: "absent" }));

    expect(rows[0]!.problems).toEqual([
      { level: "warning", text: "its provider (claude) has no CLI in the container" },
    ]);
    // Cursor is installed, so the tenant on the default has nothing to say.
    expect(rows[1]!.problems).toEqual([]);
  });

  test("an installed harness, pinned or not, warns about nothing", () => {
    expect(workspaceChildren(workspace, event())[0]!.problems).toEqual([]);
    expect(workspaceChildren(workspace, event({ kind: "unpinned" }))[0]!.problems).toEqual([]);
  });
});

describe("Phoebe's own versions", () => {
  /** The engine rows of a root config's field facts. */
  function engineFields(ref: string | undefined, source: "github" | "local" = "github") {
    return [
      {
        path: "engine.source",
        scope: "deployment" as const,
        type: "enum" as const,
        values: ["github", "local"],
        state: "set" as const,
        value: source,
      },
      {
        path: "engine.ref",
        scope: "deployment" as const,
        type: "string" as const,
        default: "main",
        ...(ref === undefined
          ? { state: "unset" as const }
          : { state: "set" as const, value: ref }),
      },
    ];
  }
  const root = (ref: string | undefined, source: "github" | "local" = "github") =>
    localReport({
      facts: workspace,
      directory: directory({
        bootstrapperRunning: false,
        configFields: engineFields(ref, source),
        harnessPins: pins({ kind: "absent" }),
      }),
    });

  test("the launcher is the check's facts, and the install's pin before any check", () => {
    expect(phoebeVersions(workspace, root("v0.13.2"), report()).launcher).toMatchObject({
      pin: { kind: "pinned", version: "0.13.2" },
      running: "0.13.0",
      latest: "0.14.1",
    });
    expect(
      phoebeVersions({ ...workspace, containerVersion: "0.12.1" }, root("v0.13.2"), null).launcher,
    ).toEqual({
      pin: { kind: "pinned", version: "0.12.1" },
      running: null,
      latest: null,
      behind: null,
    });
  });

  test("an image that installs no launcher has none to list", () => {
    const mounted = report({
      launcher: { pin: { kind: "absent" }, running: null, latest: "0.14.1", behind: null },
    });

    expect(phoebeVersions(workspace, root(undefined, "local"), mounted)).toEqual({
      launcher: null,
      engine: { source: "local" },
    });
  });

  test("an engine on a release tag is behind or current by the newest release", () => {
    expect(phoebeVersions(workspace, root("v0.13.2"), report()).engine).toEqual({
      source: "github",
      ref: "v0.13.2",
      release: true,
      latest: "v0.14.1",
      behind: true,
    });
    expect(phoebeVersions(workspace, root("v0.14.1"), report()).engine).toMatchObject({
      behind: false,
    });
    expect(
      engineReading({
        source: "github",
        ref: "v0.13.2",
        release: true,
        latest: "v0.14.1",
        behind: true,
      }),
    ).toBe("ref v0.13.2 · latest v0.14.1");
  });

  test("an engine on a branch follows it, and is neither behind nor current", () => {
    const engine = phoebeVersions(workspace, root(undefined), report()).engine!;

    expect(engine).toMatchObject({ source: "github", ref: "main", release: false, behind: null });
    expect(engineReading(engine)).toBe("ref main · follows that ref as it moves");
    expect(engineStanding(engine)).toBeNull();
  });

  test("a launcher the container has not caught up with needs a rebuild before anything else", () => {
    expect(launcherStanding(report().launcher)).toEqual({ text: "needs rebuild", tone: "warn" });
    expect(launcherStanding({ ...report().launcher, running: "0.13.2" })).toEqual({
      text: "behind",
      tone: "warn",
    });
  });

  test("a launcher version is three numbers, with or without the v", () => {
    expect(launcherVersionOf("0.14.1")).toBe("0.14.1");
    expect(launcherVersionOf(" v0.14.1 ")).toBe("0.14.1");
    expect(launcherVersionOf("main")).toBeNull();
    expect(launcherVersionOf("")).toBeNull();
  });

  test("an upgrade's outcome is a sentence per half, and says when a rebuild is owed", () => {
    expect(
      upgradeReading({
        kind: "upgraded",
        target: "cli",
        engine: null,
        cli: { kind: "moved", from: "0.13.2", to: "0.14.1" },
        ok: true,
      }),
    ).toEqual({
      text: "The Dockerfile now pins the launcher at 0.14.1 (was 0.13.2). Rebuild to put it in the container.",
      ok: true,
      rebuild: true,
    });
    expect(
      upgradeReading({
        kind: "upgraded",
        target: "engine",
        engine: { kind: "refused", stage: "migrate" },
        cli: null,
        ok: false,
      }),
    ).toMatchObject({ ok: false, rebuild: false });
    // A check moves nothing, and has its own line on the tab.
    expect(
      upgradeReading({
        kind: "checked",
        ok: true,
        report: {
          engine: { source: "local", ref: null, latest: null, tracking: false, behind: null },
          cli: { installed: null, latest: null, behind: null },
          ok: true,
        },
      }),
    ).toBeNull();
  });

  function phoebe(overrides: Partial<Parameters<typeof PhoebePanel>[0]> = {}) {
    const noop = (): void => undefined;
    return renderToStaticMarkup(
      <PhoebePanel
        install={workspace}
        versions={phoebeVersions(workspace, root("v0.13.2"), report())}
        containerAsked
        run={null}
        lookingUp={false}
        busy={false}
        onLookUp={noop}
        onUpgrade={noop}
        onRebuild={noop}
        {...overrides}
      />,
    );
  }

  test("lists the launcher and the engine, each with a field offering the latest", () => {
    const markup = phoebe();

    expect(markup).toContain('aria-label="Phoebe versions"');
    expect(markup).toContain("pinned to 0.13.2 · the container has 0.13.0 · latest 0.14.1");
    expect(markup).toMatch(/aria-label="Version of the launcher"[^>]*value="0.14.1"/);
    expect(markup).toContain("ref v0.13.2 · latest v0.14.1");
    expect(markup).toMatch(/aria-label="Ref of the engine"[^>]*value="v0.14.1"/);
    expect(markup).toContain(">Upgrade<");
    expect(markup).toContain(">Move<");
  });

  test("a pin ahead of the container offers the rebuild", () => {
    const markup = phoebe();

    expect(markup).toContain("The Dockerfile pins the launcher at 0.13.2 and the container has");
    expect(markup).toContain("Rebuild and start");
  });

  test("an upgrade just run is said in the section, and one in flight says so", () => {
    const moved = phoebe({
      run: {
        runId: "run-1",
        install: workspace.dir,
        verb: "upgrade",
        startedAt: ago(5),
        lines: [],
        exit: {
          runId: "run-1",
          code: 0,
          outcome: {
            verb: "upgrade",
            outcome: {
              kind: "upgraded",
              target: "cli",
              engine: null,
              cli: { kind: "moved", from: "0.13.2", to: "0.14.1" },
              ok: true,
            },
          },
        },
      },
    });

    expect(moved).toContain("The Dockerfile now pins the launcher at 0.14.1 (was 0.13.2)");
    expect(moved).toContain("Rebuild and start");
    expect(
      phoebe({
        run: {
          runId: "run-2",
          install: workspace.dir,
          verb: "upgrade",
          startedAt: ago(1),
          lines: [],
        },
      }),
    ).toContain("Upgrading. The console&#x27;s cli tab has the run.");
  });

  test("a local engine and no launcher leave nothing to move", () => {
    const markup = phoebe({
      versions: { launcher: null, engine: { source: "local" } },
    });

    expect(markup).toContain("runs from a folder mounted into the container");
    expect(markup).not.toContain(">Move<");
    expect(markup).not.toContain(">Upgrade<");
    expect(phoebe({ versions: { launcher: null, engine: null } })).toBe("");
  });

  test("the install's page draws it above the harnesses, and a tenant's page does not", () => {
    const noop = (): void => undefined;
    const page = (tenant?: string) =>
      renderToStaticMarkup(
        <HarnessSection
          install={{ ...workspace, containerVersion: "0.13.2" }}
          bridge={bridge()}
          event={event()}
          busy={false}
          onRebuild={noop}
          onStart={noop}
          {...(tenant === undefined ? {} : { tenant })}
        />,
      );

    expect(page().indexOf('aria-label="Phoebe versions"')).toBeGreaterThan(-1);
    expect(page().indexOf('aria-label="Phoebe versions"')).toBeLessThan(
      page().indexOf('aria-label="AI harness"'),
    );
    expect(page("/repos/ws/a")).not.toContain("Phoebe versions");
  });
});

describe("a rebuild, as the runs it is", () => {
  /** A bridge whose runs exit with the codes given, in order, and which records each start. */
  function sequenced(codes: number[], refuseAt = -1) {
    const started: VerbRunRequest[] = [];
    const listeners = new Set<(exit: RunExit) => void>();
    const base = bridge();
    const fake: DesktopBridge = {
      ...base,
      runs: {
        ...base.runs,
        start: (request) => {
          if (started.length === refuseAt) return Promise.reject(new Error("another run is going"));
          started.push(request);
          const runId = `run-${started.length}`;
          const code = codes[started.length - 1] ?? 0;
          setTimeout(() => {
            for (const listener of listeners) listener({ runId, code });
          }, 0);
          return Promise.resolve(runId);
        },
        exits: (onExit) => {
          listeners.add(onExit);
          return () => void listeners.delete(onExit);
        },
      },
    };
    return { fake, started };
  }

  test("a running install is drained, then started with a build", async () => {
    const { fake, started } = sequenced([0, 0]);
    const shown: string[] = [];

    const trouble = await runInSequence(
      fake,
      "/repos/ws",
      rebuildRequests("/repos/ws", true),
      (run) => shown.push(run.verb),
    );

    expect(trouble).toBeNull();
    expect(started).toEqual([
      { install: "/repos/ws", verb: "stop" },
      { install: "/repos/ws", verb: "start", build: true },
    ]);
    expect(shown).toEqual(["stop", "start"]);
  });

  test("a stopped install is only started", () => {
    expect(rebuildRequests("/repos/ws", false)).toEqual([
      { install: "/repos/ws", verb: "start", build: true },
    ]);
  });

  test("a stop that fails leaves the build unstarted", async () => {
    const { fake, started } = sequenced([1]);

    await runInSequence(fake, "/repos/ws", rebuildRequests("/repos/ws", true), () => undefined);

    expect(started).toEqual([{ install: "/repos/ws", verb: "stop" }]);
  });

  test("a refusal from main is returned as its own words", async () => {
    const { fake } = sequenced([], 0);

    expect(
      await runInSequence(fake, "/repos/ws", rebuildRequests("/repos/ws", false), () => undefined),
    ).toBe("another run is going");
  });
});
