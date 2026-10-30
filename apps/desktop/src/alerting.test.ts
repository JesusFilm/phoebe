// What main decides about alerts, with no Electron: the edges of a local
// install's reads, and the badge they add up to.

import { describe, expect, test } from "vite-plus/test";
import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts";
import type { LocalInstall, LocalReportEvent, StoredReport } from "phoebe-agent/contracts";
import { createCompanionAlerts, reportAlertFacts, type RemoteAlertInput } from "./alerting.ts";

const DIR = "/repos/youtube-studio";
const OTHER = "/repos/acme-site";

function install(overrides: Partial<LocalInstall> = {}): LocalInstall {
  return {
    dir: DIR,
    name: "youtube-studio",
    addedAt: "2026-09-18T09:00:00.000Z",
    state: "running",
    containerVersion: null,
    ...overrides,
  };
}

/** One read, with as many wedged and crash-looping pipelines as the test wants. */
function read(
  pipelines: { id: string; wedged?: boolean; crashLooping?: boolean }[],
  overrides: Partial<LocalReportEvent> = {},
): LocalReportEvent {
  const dir = overrides.install ?? DIR;
  return {
    type: "report",
    install: dir,
    at: "2026-09-18T10:00:00.000Z",
    facts: install({ dir, name: dir.split("/").pop()! }),
    directory: {
      configPath: `${dir}/phoebe.config.ts`,
      configText: "export default defineConfig({})\n",
      configFingerprint: "abc123",
      envPresent: true,
      bootstrapperRunning: true,
    },
    report: {
      schema: DEPLOYMENT_SCHEMA,
      receivedAt: "2026-09-18T10:00:00.000Z",
      report: {
        schema: DEPLOYMENT_SCHEMA,
        bootstrapper: {
          children: pipelines.map((pipeline) => ({
            id: pipeline.id,
            crashLooping: pipeline.crashLooping === true,
            restarts: pipeline.crashLooping === true ? 4 : 0,
          })),
        },
        fleet: {
          cells: pipelines.map((pipeline) => ({
            id: pipeline.id,
            tenant: { id: pipeline.id.split("#")[0], path: pipeline.id.split("#")[0] },
            pipeline: pipeline.id.split("#")[1],
            source: "enumerated",
            wedged:
              pipeline.wedged === true
                ? { wedged: true, reason: "no-pass", noPassForMs: 17 * 60_000 }
                : { wedged: false },
          })),
        },
      },
    },
    ...overrides,
  };
}

/** A stopped install: facts, and nothing to read a verdict out of. */
function stopped(dir = DIR): LocalReportEvent {
  return {
    ...read([], { install: dir }),
    report: null,
    reason: "the container is not running",
  };
}

describe("the local arm's edges", () => {
  test("the first read of an install seeds and raises nothing (#524 §3)", () => {
    const alerts = createCompanionAlerts();

    const raised = alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    expect(raised).toEqual([]);
  });

  test("but it still counts, so a relaunch onto a wedged fleet badges at once", () => {
    const alerts = createCompanionAlerts();

    alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    expect(alerts.badge()).toBe(1);
  });

  test("a condition that turns true after the seed is one alert", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry" }]));

    const raised = alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    expect(raised).toHaveLength(1);
    expect(raised[0]!.alert.condition).toBe("wedged");
    expect(raised[0]!.alert.state).toBe("raised");
    expect(raised[0]!.alert.pipeline).toBe("acme/sentry");
    expect(raised[0]!.install).toBe(DIR);
  });

  test("and turning false again is the matching clear (#515 §3)", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry" }]));
    alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    const cleared = alerts.local(read([{ id: "acme#sentry" }]));

    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.alert.state).toBe("cleared");
    expect(alerts.badge()).toBe(0);
  });

  test("a read where nothing moved says nothing at all", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    expect(alerts.local(read([{ id: "acme#sentry", wedged: true }]))).toEqual([]);
  });

  test("crash-looping is the second report-borne condition, off the child", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry" }]));

    const raised = alerts.local(read([{ id: "acme#sentry", crashLooping: true }]));

    expect(raised.map((event) => event.alert.condition)).toEqual(["crash-looping"]);
    expect(raised[0]!.alert.detail).toBe("4 restart(s)");
  });

  test("the sentence is the alert's own, deployment name and all (#515 §9)", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry" }]));

    const raised = alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    expect(raised[0]!.alert.text).toBe(
      "youtube-studio: pipeline sentry wedged (no pass for 17 min)",
    );
  });

  test("the url is a page in this companion, not on somebody's relay", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry" }]));

    const raised = alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    expect(raised[0]!.alert.url.startsWith("phoebe://console/")).toBe(true);
  });

  test("a local install never goes dark or replaced — there is no socket (#524 §3)", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry" }]));

    // Every later read, including one with nothing running behind it.
    const raised = [...alerts.local(stopped()), ...alerts.local(read([{ id: "acme#sentry" }]))];

    expect(raised.map((event) => event.alert.condition)).not.toContain("dark");
    expect(raised.map((event) => event.alert.condition)).not.toContain("replaced");
  });

  test("a stopped install holds its raise rather than clearing on no report", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry" }]));
    alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    expect(alerts.local(stopped())).toEqual([]);
    expect(alerts.badge()).toBe(1);
  });
});

describe("the badge", () => {
  test("counts subjects, not edges: three wedged pipelines are one install (#524 §4)", () => {
    const alerts = createCompanionAlerts();
    alerts.local(
      read([
        { id: "acme#one", wedged: true },
        { id: "acme#two", wedged: true },
        { id: "acme#three", wedged: true },
      ]),
    );

    expect(alerts.badge()).toBe(1);
  });

  test("forgetting an install drops what it was raising", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    alerts.forgetInstall(DIR);

    expect(alerts.badge()).toBe(0);
  });

  test("and the install is seeded again if it comes back, so it does not re-fire", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry", wedged: true }]));
    alerts.forgetInstall(DIR);

    expect(alerts.local(read([{ id: "acme#sentry", wedged: true }]))).toEqual([]);
  });

  test("two installs in trouble are two", () => {
    const alerts = createCompanionAlerts();

    alerts.local(read([{ id: "acme#sentry", wedged: true }]));
    alerts.local(read([{ id: "acme#sentry", wedged: true }], { install: OTHER }));

    expect(alerts.badge()).toBe(2);
  });
});

describe("the report, projected onto what the rule reads", () => {
  test("a schema this build does not know reads as no report at all", () => {
    const event = read([{ id: "acme#sentry", wedged: true }]);

    const facts = reportAlertFacts({
      ...event,
      report: { ...event.report!, schema: DEPLOYMENT_SCHEMA + 99 },
    });

    expect(facts).toBeNull();
  });

  test("a cell discovery did not enumerate is not a pipeline", () => {
    const event = read([{ id: "acme#sentry", wedged: true }]);
    const body = event.report!.report as { fleet: { cells: { source: string }[] } };
    body.fleet.cells[0]!.source = "state-dir";

    expect(reportAlertFacts(event)!.pipelines).toEqual([]);
  });

  test("doctor has no section in the report yet, so it is unknown and silent", () => {
    expect(reportAlertFacts(read([]))!.doctor).toBe("unknown");
  });
});

describe("the remote arm's alerts (map #690)", () => {
  const T0 = Date.parse("2026-10-16T12:00:00.000Z");
  const wedgedReport = (): StoredReport => ({
    schema: DEPLOYMENT_SCHEMA,
    receivedAt: new Date(T0).toISOString(),
    report: {
      schema: DEPLOYMENT_SCHEMA,
      identity: { name: "acme" },
      bootstrapper: { children: [] },
      fleet: {
        cells: [
          {
            id: "t#work",
            pipeline: "work",
            source: "enumerated",
            tenant: { path: "acme", id: "t" },
            wedged: { wedged: true, reason: "no-pass", noPassForMs: 17 * 60_000 },
          },
        ],
      },
    },
  });
  const input = (overrides: Partial<RemoteAlertInput> = {}): RemoteAlertInput => ({
    deploymentId: "dep_A",
    name: "acme",
    reachability: "connected",
    lastHeardAt: new Date(T0).toISOString(),
    maybeReplaced: false,
    report: wedgedReport(),
    notified: {},
    seeded: false,
    ...overrides,
  });

  test("the first evaluation seeds and says nothing; the next one speaks", () => {
    const alerts = createCompanionAlerts({ clock: () => new Date(T0) });
    const first = alerts.remote(input());
    expect(first.alerts).toEqual([]);
    expect(first.seeded).toBe(true);
    expect(Object.keys(first.notified)).toEqual(["wedged:acme/work"]);
    expect(alerts.badge()).toBe(1);
    const cleared = alerts.remote(
      input({
        notified: first.notified,
        seeded: true,
        report: {
          ...wedgedReport(),
          report: {
            schema: DEPLOYMENT_SCHEMA,
            fleet: { cells: [] },
            bootstrapper: { children: [] },
          },
        },
      }),
    );
    expect(cleared.alerts.map((alert) => [alert.alert.condition, alert.alert.state])).toEqual([
      ["wedged", "cleared"],
    ]);
    expect(cleared.alerts[0]!.alert.url).toBe("phoebe://console/#/r/dep_A");
    expect(cleared.alerts[0]!.alert.deployment).toEqual({ name: "acme", keyFingerprint: "dep_A" });
    expect(alerts.badge()).toBe(0);
  });

  test("once per row: two routes to one deployment are two badges and two notifications", () => {
    const alerts = createCompanionAlerts({ clock: () => new Date(T0) });
    const local = { ...wedgedReport() };
    const seeded = alerts.remote(input({ report: null }));
    alerts.remote(input({ ...seeded, report: wedgedReport() }));
    expect(alerts.badge()).toBe(1);
    // The same deployment's folder on this machine, read locally.
    alerts.local({
      type: "report",
      install: "/deploy",
      at: new Date(T0).toISOString(),
      facts: {
        dir: "/deploy",
        name: "acme",
        addedAt: "",
        state: "running",
        containerVersion: null,
      },
      directory: {
        configPath: "",
        configText: null,
        configFingerprint: null,
        envPresent: true,
        bootstrapperRunning: true,
      },
      report: {
        ...local,
        report: {
          ...(local.report as object),
          fleet: { cells: [] },
          bootstrapper: { children: [] },
        },
      },
    });
    const raised = alerts.local({
      type: "report",
      install: "/deploy",
      at: new Date(T0).toISOString(),
      facts: {
        dir: "/deploy",
        name: "acme",
        addedAt: "",
        state: "running",
        containerVersion: null,
      },
      directory: {
        configPath: "",
        configText: null,
        configFingerprint: null,
        envPresent: true,
        bootstrapperRunning: true,
      },
      report: local,
    });
    expect(raised).toHaveLength(1);
    expect(alerts.badge()).toBe(2);
  });

  test("a relaunch with a persisted map re-fires nothing, dates darkness from real last contact, and can clear", () => {
    const alerts = createCompanionAlerts({ clock: () => new Date(T0) });
    const persisted = { dark: { state: "raised" as const, at: "earlier", since: "earlier" } };
    const stillDark = alerts.remote(
      input({
        reachability: "dark",
        lastHeardAt: new Date(T0 - 10 * 60_000).toISOString(),
        notified: persisted,
        seeded: true,
        report: null,
      }),
    );
    expect(stillDark.alerts).toEqual([]);
    expect(alerts.badge()).toBe(1);
    const back = alerts.remote(
      input({
        reachability: "connected",
        notified: stillDark.notified,
        seeded: true,
        report: null,
      }),
    );
    expect(back.alerts.map((alert) => [alert.alert.condition, alert.alert.state])).toEqual([
      ["dark", "cleared"],
    ]);
  });

  test("darkness raises only past five minutes, with the coarse wording", () => {
    const alerts = createCompanionAlerts({ clock: () => new Date(T0) });
    const seeded = alerts.remote(input({ report: null }));
    const soon = alerts.remote(
      input({
        ...seeded,
        reachability: "dark",
        lastHeardAt: new Date(T0 - 2 * 60_000).toISOString(),
        report: null,
      }),
    );
    expect(soon.alerts).toEqual([]);
    const late = alerts.remote(
      input({
        ...soon,
        reachability: "dark",
        lastHeardAt: new Date(T0 - 6 * 60_000).toISOString(),
        report: null,
      }),
    );
    expect(late.alerts.map((alert) => alert.alert.detail)).toEqual(["unreachable for 6 min"]);
  });

  test("blocked is never evaluated, never notified, never counted", () => {
    const alerts = createCompanionAlerts({ clock: () => new Date(T0) });
    const out = alerts.remote(
      input({
        reachability: "blocked",
        notified: { dark: { state: "raised", at: "", since: "" } },
        seeded: true,
      }),
    );
    expect(out.alerts).toEqual([]);
    expect(out.notified).toEqual({ dark: { state: "raised", at: "", since: "" } });
    expect(alerts.badge()).toBe(0);
  });

  test("a replaced descriptor raises `replaced`", () => {
    const alerts = createCompanionAlerts({ clock: () => new Date(T0) });
    const seeded = alerts.remote(input({ report: null }));
    const moved = alerts.remote(
      input({
        ...seeded,
        reachability: "dark",
        lastHeardAt: new Date(T0 - 6 * 60_000).toISOString(),
        maybeReplaced: true,
        report: null,
      }),
    );
    expect(moved.alerts.map((alert) => alert.alert.condition).sort()).toEqual(["dark", "replaced"]);
    alerts.forgetRemote("dep_A");
    expect(alerts.badge()).toBe(0);
  });
});
