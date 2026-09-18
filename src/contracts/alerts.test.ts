// The edge rule, exercised as a function because that is all it is: facts and a
// last-notified state in, messages to send out (#515, #524 §1).
//
// Every case here is a sentence from the resolution. The relay's own wiring —
// the file, the sweep timer, the POST — is relay/alerts.test.ts; nothing in
// this file touches a disk or a clock.

import { describe, expect, test } from "vite-plus/test";
import {
  ALERT_DARK_AFTER_MS,
  ALERT_SCHEMA,
  alertEdges,
  alertKeyOf,
  alertMessage,
  alertTestMessage,
  type AlertEdge,
  type DeploymentAlertFacts,
  type NotifiedAlerts,
  type PipelineAlertFacts,
  type ReportAlertFacts,
} from "./alerts.ts";

const NOW = "2026-09-18T12:00:00.000Z";
const QUIET_SINCE = "2026-09-18T11:52:00.000Z";

function pipeline(overrides: Partial<PipelineAlertFacts> = {}): PipelineAlertFacts {
  return {
    pipeline: "acme-site/sentry",
    wedged: false,
    wedgedDetail: "a pass completed 2 min ago",
    crashLooping: false,
    crashLoopDetail: "no self-death since boot",
    ...overrides,
  };
}

function report(overrides: Partial<ReportAlertFacts> = {}): ReportAlertFacts {
  return {
    at: "2026-09-18T11:59:00.000Z",
    doctor: "ok",
    doctorDetail: "every check passed",
    pipelines: [pipeline()],
    ...overrides,
  };
}

function facts(overrides: Partial<DeploymentAlertFacts> = {}): DeploymentAlertFacts {
  return {
    fingerprint: "fp-widget",
    name: "acme-site",
    connection: "connected",
    quietForMs: null,
    quietSince: null,
    maybeReplaced: false,
    report: report(),
    ...overrides,
  };
}

/** The rule, with nothing notified yet. */
function edges(
  overrides: Partial<DeploymentAlertFacts>,
  notified: NotifiedAlerts = {},
): AlertEdge[] {
  return alertEdges({ facts: facts(overrides), notified, now: NOW });
}

/** One notified entry, as the store would have written it. */
function notified(key: string, state: "raised" | "cleared"): NotifiedAlerts {
  return { [key]: { state, at: "2026-09-18T11:00:00.000Z", since: QUIET_SINCE } };
}

describe("a quiet fleet stays quiet", () => {
  test("a connected deployment with a clean report crosses nothing", () => {
    expect(edges({})).toEqual([]);
  });

  test("an unseen link is silent on every condition", () => {
    // Setup in progress, not an incident (#515 §3). No dark, no replaced, and
    // no report-borne conditions either, however long it has been like this.
    expect(
      edges({
        connection: "unseen",
        quietForMs: 10 * ALERT_DARK_AFTER_MS,
        quietSince: QUIET_SINCE,
        report: null,
      }),
    ).toEqual([]);
  });

  test("a reader with no relay evaluates the report and nothing else", () => {
    // A companion watching a local install (#524 §3): no darkness to observe,
    // no link to be replaced, and the three report-borne conditions live.
    const sent = edges({
      connection: null,
      quietForMs: 10 * ALERT_DARK_AFTER_MS,
      quietSince: QUIET_SINCE,
      maybeReplaced: true,
      report: report({ doctor: "fail", doctorDetail: "clone, github-token" }),
    });

    expect(sent.map((edge) => edge.condition)).toEqual(["doctor-fail"]);
  });
});

describe("dark waits five minutes", () => {
  test("silence inside the debounce says nothing, though the console says dark", () => {
    expect(
      edges({
        connection: "dark",
        quietForMs: ALERT_DARK_AFTER_MS - 1,
        quietSince: QUIET_SINCE,
      }),
    ).toEqual([]);
  });

  test("five minutes unheard raises, dated from the last heartbeat", () => {
    const sent = edges({
      connection: "dark",
      quietForMs: ALERT_DARK_AFTER_MS,
      quietSince: QUIET_SINCE,
    });

    expect(sent).toEqual([
      {
        key: "dark",
        condition: "dark",
        state: "raised",
        pipeline: null,
        since: QUIET_SINCE,
        detail: "no heartbeat for 5 min",
      },
    ]);
  });

  test("the next connection clears it, dated now", () => {
    const sent = edges({ connection: "connected" }, notified("dark", "raised"));

    expect(sent).toEqual([
      {
        key: "dark",
        condition: "dark",
        state: "cleared",
        pipeline: null,
        since: NOW,
        detail: "connected",
      },
    ]);
  });

  test("a deployment that was never dark is never told it has stopped being dark", () => {
    expect(edges({ connection: "connected" })).toEqual([]);
  });

  test("a still-dark deployment after a restart sends nothing twice", () => {
    expect(
      edges(
        { connection: "dark", quietForMs: 9 * ALERT_DARK_AFTER_MS, quietSince: QUIET_SINCE },
        notified("dark", "raised"),
      ),
    ).toEqual([]);
  });
});

describe("a dark deployment's report-borne conditions freeze", () => {
  test("no clear goes out while it is dark, however clean the stale report reads", () => {
    // Its last report says nothing is wedged, but that report predates the
    // silence and the relay will not read a recovery out of a stale file.
    expect(
      edges(
        {
          connection: "dark",
          quietForMs: ALERT_DARK_AFTER_MS,
          quietSince: QUIET_SINCE,
          report: report(),
        },
        {
          ...notified("dark", "raised"),
          ...notified(alertKeyOf("wedged", "acme-site/sentry"), "raised"),
        },
      ),
    ).toEqual([]);
  });

  test("and they are re-evaluated the moment a fresh report arrives", () => {
    const sent = edges(
      { connection: "connected", report: report() },
      notified(alertKeyOf("wedged", "acme-site/sentry"), "raised"),
    );

    expect(sent).toEqual([
      {
        key: "wedged:acme-site/sentry",
        condition: "wedged",
        state: "cleared",
        pipeline: "acme-site/sentry",
        since: NOW,
        detail: "a pass completed 2 min ago",
      },
    ]);
  });

  test("a deployment the relay holds no report for says nothing about a report", () => {
    expect(edges({ connection: "connected", report: null })).toEqual([]);
  });
});

describe("the three conditions a report carries", () => {
  test("wedged and crash-looping are per pipeline and name it", () => {
    const sent = edges({
      report: report({
        pipelines: [
          pipeline({ wedged: true, wedgedDetail: "no pass for 17 min" }),
          pipeline({
            pipeline: "acme-site/work",
            crashLooping: true,
            crashLoopDetail: "4 self-deaths in 3 min",
          }),
        ],
      }),
    });

    expect(sent.map((edge) => [edge.condition, edge.pipeline, edge.detail])).toEqual([
      ["wedged", "acme-site/sentry", "no pass for 17 min"],
      ["crash-looping", "acme-site/work", "4 self-deaths in 3 min"],
    ]);
  });

  test("doctor-fail is one condition per deployment and names the failing checks", () => {
    const sent = edges({
      report: report({ doctor: "fail", doctorDetail: "clone, github-token" }),
    });

    expect(sent).toEqual([
      {
        key: "doctor-fail",
        condition: "doctor-fail",
        state: "raised",
        pipeline: null,
        since: "2026-09-18T11:59:00.000Z",
        detail: "clone, github-token",
      },
    ]);
  });

  test("a report that stays failing with different checks sends nothing", () => {
    expect(
      edges(
        { report: report({ doctor: "fail", doctorDetail: "clone" }) },
        notified("doctor-fail", "raised"),
      ),
    ).toEqual([]);
  });

  test("an unknown verdict neither raises nor clears", () => {
    expect(edges({ report: report({ doctor: "unknown", doctorDetail: "timed out" }) })).toEqual([]);
    expect(
      edges(
        { report: report({ doctor: "unknown", doctorDetail: "timed out" }) },
        notified("doctor-fail", "raised"),
      ),
    ).toEqual([]);
  });

  test("a pipeline that has left the report is no longer wedged", () => {
    const sent = edges(
      { report: report({ pipelines: [] }) },
      notified(alertKeyOf("crash-looping", "acme-site/gone"), "raised"),
    );

    expect(sent).toEqual([
      {
        key: "crash-looping:acme-site/gone",
        condition: "crash-looping",
        state: "cleared",
        pipeline: "acme-site/gone",
        since: NOW,
        detail: "the pipeline is no longer in the report",
      },
    ]);
  });
});

describe("replaced", () => {
  test("a newer link on a dark link's name raises", () => {
    const sent = edges({
      connection: "dark",
      quietForMs: ALERT_DARK_AFTER_MS,
      quietSince: QUIET_SINCE,
      maybeReplaced: true,
    });

    expect(sent.map((edge) => edge.condition)).toEqual(["dark", "replaced"]);
  });

  test("the old deployment turning up again clears it", () => {
    const sent = edges({ connection: "connected" }, notified("replaced", "raised"));

    expect(sent).toEqual([
      {
        key: "replaced",
        condition: "replaced",
        state: "cleared",
        pipeline: null,
        since: NOW,
        detail: "no newer link shares this name",
      },
    ]);
  });
});

describe("the body both sinks carry", () => {
  const edge: AlertEdge = {
    key: "wedged:acme-site/sentry",
    condition: "wedged",
    state: "raised",
    pipeline: "acme-site/sentry",
    since: "2026-09-18T11:12:00.000Z",
    detail: "no pass for 17 min",
  };

  test("it is #515 §9's shape, text and deep link included", () => {
    expect(
      alertMessage({
        edge,
        deployment: { name: "acme-site", fingerprint: "fp-widget" },
        consoleOrigin: "https://relay.example",
      }),
    ).toEqual({
      schema: ALERT_SCHEMA,
      kind: "alert",
      condition: "wedged",
      state: "raised",
      deployment: { name: "acme-site", keyFingerprint: "fp-widget" },
      pipeline: "acme-site/sentry",
      since: "2026-09-18T11:12:00.000Z",
      detail: "no pass for 17 min",
      text: "acme-site: pipeline sentry wedged (no pass for 17 min)",
      url: "https://relay.example/#/d/fp-widget",
    });
  });

  test("a whole-deployment condition carries no pipeline field at all", () => {
    const body = alertMessage({
      edge: {
        key: "dark",
        condition: "dark",
        state: "raised",
        pipeline: null,
        since: QUIET_SINCE,
        detail: "no heartbeat for 5 min",
      },
      deployment: { name: "acme-site", fingerprint: "fp-widget" },
      consoleOrigin: "https://relay.example/",
    });

    expect("pipeline" in body).toBe(false);
    expect(body.text).toBe("acme-site: dark (no heartbeat for 5 min)");
    expect(body.url).toBe("https://relay.example/#/d/fp-widget");
  });

  test("a clear reads as the same sentence, negated", () => {
    const body = alertMessage({
      edge: { ...edge, state: "cleared", detail: "a pass completed" },
      deployment: { name: "acme-site", fingerprint: "fp-widget" },
      consoleOrigin: "https://relay.example",
    });

    expect(body.text).toBe("acme-site: pipeline sentry no longer wedged (a pass completed)");
  });

  test("the test body is its own kind, so nothing mistakes it for an incident", () => {
    const body = alertTestMessage({
      by: "ada@example.test",
      at: NOW,
      consoleOrigin: "https://relay.example",
    });

    expect(body.kind).toBe("test");
    expect(body.text).toContain("ada@example.test");
  });
});

describe("the key one notified state is recorded under", () => {
  test("a per-deployment condition is its own key", () => {
    expect(alertKeyOf("dark")).toBe("dark");
    expect(alertKeyOf("dark", null)).toBe("dark");
  });

  test("a per-pipeline condition carries the pipeline", () => {
    expect(alertKeyOf("wedged", "acme-site/sentry")).toBe("wedged:acme-site/sentry");
  });
});
