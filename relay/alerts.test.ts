// The relay's half of alerting: the file, the sweep, and the POST (#515).
//
// The rule these exercise is tested as a function in
// src/contracts/alerts.test.ts. What is asked here is everything the rule
// cannot answer — does a restart re-fire, does a webhook outage become a storm,
// does forgetting a deployment say anything on its way out.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  ALERT_DARK_AFTER_MS,
  type AlertBody,
  type ConnectionAlertFacts,
  type ReportAlertFacts,
} from "../src/contracts/alerts.ts";
import {
  ALERTS_FILENAME,
  createAlertNotifier,
  createAlertStore,
  webhookSink,
  type AlertSink,
  type AlertStore,
} from "./alerts.ts";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const QUIET_SINCE = "2026-09-18T11:52:00.000Z";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "phoebe-alerts-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function connected(overrides: Partial<ConnectionAlertFacts> = {}): ConnectionAlertFacts {
  return {
    fingerprint: "fp-widget",
    name: "acme-site",
    connection: "connected",
    quietForMs: null,
    quietSince: null,
    maybeReplaced: false,
    ...overrides,
  };
}

/** Dark long enough to have crossed the debounce. */
function dark(): ConnectionAlertFacts {
  return connected({
    connection: "dark",
    quietForMs: ALERT_DARK_AFTER_MS,
    quietSince: QUIET_SINCE,
  });
}

/** A sink that remembers instead of sending. */
function recorder(): AlertSink & { taken: AlertBody[] } {
  const taken: AlertBody[] = [];
  return {
    name: "the recorder",
    taken,
    send(body) {
      taken.push(body);
    },
  };
}

function notifier(input: {
  store?: AlertStore;
  connections: ConnectionAlertFacts[];
  report?: (fingerprint: string) => ReportAlertFacts | null;
  sinks: readonly AlertSink[];
  webhook?: boolean;
  warn?: (message: string) => void;
}) {
  return createAlertNotifier({
    store: input.store ?? createAlertStore(dataDir),
    connections: () => input.connections,
    ...(input.report !== undefined ? { report: input.report } : {}),
    sinks: input.sinks,
    webhook: input.webhook ?? input.sinks.length > 0,
    consoleOrigin: "https://relay.example",
    clock: () => NOW,
    ...(input.warn !== undefined ? { warn: input.warn } : {}),
  });
}

function alertsFile(): unknown {
  return JSON.parse(readFileSync(join(dataDir, ALERTS_FILENAME), "utf8")) as unknown;
}

describe("the sweep", () => {
  test("a crossed edge reaches every sink", async () => {
    const one = recorder();
    const two = recorder();
    const sweeper = notifier({ connections: [dark()], sinks: [one, two] });

    const sent = await sweeper.sweep();

    expect(sent.map((edge) => `${edge.condition}:${edge.state}`)).toEqual(["dark:raised"]);
    expect(one.taken).toEqual(two.taken);
    expect(one.taken[0]).toMatchObject({
      kind: "alert",
      condition: "dark",
      state: "raised",
      text: "acme-site: dark (no heartbeat for 5 min)",
    });
  });

  test("the relay evaluates and records with no sinks at all", async () => {
    // An absent RELAY_ALERT_WEBHOOK means no webhook, not no evaluation
    // (#524 §1) — so the bookkeeping has to move either way, or adding a
    // webhook later would replay every edge since boot.
    const sweeper = notifier({ connections: [dark()], sinks: [], webhook: false });

    expect((await sweeper.sweep()).map((edge) => edge.condition)).toEqual(["dark"]);
    expect(alertsFile()).toEqual({
      deployments: {
        "fp-widget": {
          dark: { state: "raised", at: NOW.toISOString(), since: QUIET_SINCE },
        },
      },
    });
  });

  test("nothing crossed is nothing written", async () => {
    const sink = recorder();
    await notifier({ connections: [connected()], sinks: [sink] }).sweep();

    expect(sink.taken).toEqual([]);
    expect(() => alertsFile()).toThrow();
  });

  test("a second sweep over the same facts is silent", async () => {
    const sink = recorder();
    const store = createAlertStore(dataDir);
    const sweeper = notifier({ store, connections: [dark()], sinks: [sink] });

    await sweeper.sweep();
    await sweeper.sweep();

    expect(sink.taken).toHaveLength(1);
  });

  test("a restart re-reads the file and stays quiet about what is still true", async () => {
    const sink = recorder();
    await notifier({ connections: [dark()], sinks: [sink] }).sweep();

    // A whole new process, same volume.
    const afterRestart = recorder();
    await notifier({ connections: [dark()], sinks: [afterRestart] }).sweep();

    expect(afterRestart.taken).toEqual([]);
  });

  test("a deployment that recovered while the relay was down gets its clear", async () => {
    const sink = recorder();
    await notifier({ connections: [dark()], sinks: [sink] }).sweep();

    const afterRestart = recorder();
    await notifier({ connections: [connected()], sinks: [afterRestart] }).sweep();

    expect(afterRestart.taken).toHaveLength(1);
    expect(afterRestart.taken[0]).toMatchObject({ condition: "dark", state: "cleared" });
  });

  test("a report-borne condition reaches the sinks once the relay holds a report", async () => {
    const sink = recorder();
    const sweeper = notifier({
      connections: [connected()],
      report: () => ({
        at: "2026-09-18T11:59:00.000Z",
        doctor: "fail",
        doctorDetail: "clone, github-token",
        pipelines: [],
      }),
      sinks: [sink],
    });

    await sweeper.sweep();

    expect(sink.taken[0]).toMatchObject({
      condition: "doctor-fail",
      state: "raised",
      detail: "clone, github-token",
      url: "https://relay.example/#/d/fp-widget",
    });
  });
});

describe("delivery is one attempt", () => {
  test("a sink that throws is a warn, and the state is still recorded", async () => {
    const warned: string[] = [];
    const broken: AlertSink = {
      name: "the alert webhook",
      send: () => Promise.reject(new Error("connect ECONNREFUSED")),
    };
    const sweeper = notifier({
      connections: [dark()],
      sinks: [broken],
      warn: (message) => warned.push(message),
    });

    await sweeper.sweep();

    expect(warned).toEqual([
      "[phoebe:relay] the alert webhook did not take dark raised for acme-site: " +
        "connect ECONNREFUSED",
    ]);
    // Written after the attempt, not after the success (#515 §12): the next
    // sweep must not re-send what this one lost.
    expect(alertsFile()).toMatchObject({
      deployments: { "fp-widget": { dark: { state: "raised" } } },
    });
  });

  test("one broken sink does not swallow the edge for the others", async () => {
    const good = recorder();
    const broken: AlertSink = {
      name: "the broken one",
      send: () => Promise.reject(new Error("x")),
    };
    await notifier({ connections: [dark()], sinks: [broken, good] }).sweep();

    expect(good.taken).toHaveLength(1);
  });
});

describe("the webhook", () => {
  test("it POSTs the body as JSON and never logs the URL", async () => {
    const seen: { url: string; method: string | undefined; body: string }[] = [];
    const sink = webhookSink("https://hooks.example.test/secret-path", {
      fetchFn: (url, init) => {
        seen.push({
          url,
          method: init.method,
          body: typeof init.body === "string" ? init.body : "",
        });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await sink.send({
      schema: 1,
      kind: "test",
      by: "ada@example.test",
      at: NOW.toISOString(),
      text: "a test",
      url: "https://relay.example/",
    });

    expect(seen[0]?.url).toBe("https://hooks.example.test/secret-path");
    expect(seen[0]?.method).toBe("POST");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ kind: "test" });
    expect(sink.name).not.toContain("secret-path");
  });

  test("a non-2xx answer is a failure the notifier will warn about", async () => {
    const sink = webhookSink("https://hooks.example.test/abc", {
      fetchFn: () => Promise.resolve(new Response("no", { status: 500 })),
    });

    await expect(
      sink.send({ schema: 1, kind: "test", by: "a", at: "b", text: "c", url: "d" }),
    ).rejects.toThrow("answered 500");
  });
});

describe("the test alert", () => {
  test("it goes to every sink and says how many took it", async () => {
    const sink = recorder();
    const sweeper = notifier({ connections: [], sinks: [sink] });

    expect(await sweeper.test("ada@example.test")).toEqual({ sinks: 1 });
    expect(sink.taken[0]).toMatchObject({ kind: "test", by: "ada@example.test" });
  });

  test("it records nothing — a test is not an edge", async () => {
    await notifier({ connections: [], sinks: [recorder()] }).test("ada@example.test");

    expect(() => alertsFile()).toThrow();
  });
});

describe("forgetting", () => {
  test("the entries go, and nothing is sent", async () => {
    const sink = recorder();
    const store = createAlertStore(dataDir);
    const sweeper = notifier({ store, connections: [dark()], sinks: [sink] });
    await sweeper.sweep();

    sweeper.forget("fp-widget");

    expect(alertsFile()).toEqual({ deployments: {} });
    expect(sink.taken).toHaveLength(1);
  });
});

describe("what the connection panel reads", () => {
  test("the webhook flag is the environment's answer, not a guess at the sinks", () => {
    expect(notifier({ connections: [], sinks: [], webhook: false }).facts().webhook).toBe(false);
    expect(notifier({ connections: [], sinks: [], webhook: true }).facts().webhook).toBe(true);
  });

  test("the last alert per deployment is the most recent attempt", async () => {
    const store = createAlertStore(dataDir);
    store.record(
      "fp-widget",
      [
        {
          key: "dark",
          condition: "dark",
          state: "raised",
          pipeline: null,
          since: QUIET_SINCE,
          detail: "",
        },
      ],
      new Date("2026-09-18T10:00:00.000Z"),
    );
    store.record(
      "fp-widget",
      [
        {
          key: "wedged:acme-site/sentry",
          condition: "wedged",
          state: "raised",
          pipeline: "acme-site/sentry",
          since: QUIET_SINCE,
          detail: "",
        },
      ],
      new Date("2026-09-18T11:00:00.000Z"),
    );

    expect(notifier({ store, connections: [], sinks: [] }).facts().last).toEqual({
      "fp-widget": {
        condition: "wedged",
        pipeline: "acme-site/sentry",
        state: "raised",
        at: "2026-09-18T11:00:00.000Z",
      },
    });
  });
});

describe("the file itself", () => {
  test("a malformed alerts.json is a relay that has notified nothing", () => {
    writeFileSync(join(dataDir, ALERTS_FILENAME), "{ not json");
    expect(createAlertStore(dataDir).notified("fp-widget")).toEqual({});
  });

  test("a missing one is the same", () => {
    expect(createAlertStore(dataDir).last()).toEqual({});
  });
});
