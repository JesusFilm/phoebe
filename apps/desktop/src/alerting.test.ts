// What main decides about alerts, with no Electron and no relay.
//
// Everything here is the local arm's half plus the badge, because those are the
// two things main decides. The relay's edges were already decided by the relay
// — what is asserted about them is only that they move the count.

import { describe, expect, test } from "vite-plus/test";
import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts";
import type { AlertMessage, LocalInstall, LocalReportEvent } from "phoebe-agent/contracts";
import { createCompanionAlerts, reportAlertFacts } from "./alerting.ts";

const DIR = "/repos/youtube-studio";
const OTHER = "/repos/acme-site";

function install(overrides: Partial<LocalInstall> = {}): LocalInstall {
  return {
    dir: DIR,
    name: "youtube-studio",
    addedAt: "2026-09-18T09:00:00.000Z",
    state: "running",
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

  test("adds the relay's deployments to the local installs", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry", wedged: true }]));

    alerts.relay(alert({ condition: "dark", state: "raised" }));

    expect(alerts.badge()).toBe(2);
  });

  test("a relay clear takes its deployment back off", () => {
    const alerts = createCompanionAlerts();
    alerts.relay(alert({ condition: "dark", state: "raised" }));

    alerts.relay(alert({ condition: "dark", state: "cleared" }));

    expect(alerts.badge()).toBe(0);
  });

  test("one condition clearing does not take a deployment still raised on another off", () => {
    const alerts = createCompanionAlerts();
    alerts.relay(alert({ condition: "dark", state: "raised" }));
    alerts.relay(alert({ condition: "replaced", state: "raised" }));

    alerts.relay(alert({ condition: "dark", state: "cleared" }));

    expect(alerts.badge()).toBe(1);
  });

  test("the test alert is about the relay, so it raises nothing (#515 §13)", () => {
    const alerts = createCompanionAlerts();

    alerts.relay({
      schema: 1,
      kind: "test",
      by: "ada@example.test",
      at: "2026-09-18T10:00:00.000Z",
      text: "Phoebe relay test alert",
      url: "https://relay.example/",
    });

    expect(alerts.badge()).toBe(0);
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

  test("signing out drops the relay's half and keeps the local one", () => {
    const alerts = createCompanionAlerts();
    alerts.local(read([{ id: "acme#sentry", wedged: true }]));
    alerts.relay(alert({ condition: "dark", state: "raised" }));

    alerts.forgetRelay();

    expect(alerts.badge()).toBe(1);
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

/** One relay alert, as the stream carries it. */
function alert(overrides: Partial<AlertMessage>): AlertMessage {
  return {
    schema: 1,
    kind: "alert",
    condition: "dark",
    state: "raised",
    deployment: { name: "acme-site", keyFingerprint: "ff00" },
    since: "2026-09-18T09:55:00.000Z",
    detail: "no heartbeat for 5 min",
    text: "acme-site: dark (no heartbeat for 5 min)",
    url: "https://relay.example/#/d/ff00",
    ...overrides,
  };
}
