// The fleet as the page holds it: the initial read, and what the stream does to
// it without a reload (#542).

import { describe, expect, test } from "vite-plus/test";
import { CONSOLE_PROTOCOL, RELAY_EVENTS } from "phoebe-agent/contracts";
import type { RelayDeploymentDetail, RelayEvent } from "phoebe-agent/contracts";
import { applyEvent, EMPTY_FLEET, loadFleet } from "./fleet-state.ts";
import type { RelayClient } from "./relay-client.ts";
import { ago, client as stubClient, report, row, stored } from "./test-fixture.ts";

/** A client that answers from a table, and records nothing it was not asked. */
function fakeClient(
  details: Record<string, RelayDeploymentDetail | Error>,
  rows = Object.values(details)
    .filter((detail): detail is RelayDeploymentDetail => !(detail instanceof Error))
    .map((detail) => detail.deployment),
): RelayClient {
  return stubClient({
    version: () => Promise.resolve({ version: "0.13.0", console: CONSOLE_PROTOCOL }),
    deployments: () => Promise.resolve(rows),
    deployment: (fingerprint) => {
      const detail = details[fingerprint];
      if (detail === undefined) return Promise.reject(new Error("no such deployment"));
      return detail instanceof Error ? Promise.reject(detail) : Promise.resolve(detail);
    },
  });
}

describe("the initial read", () => {
  test("pairs every row with the report the relay holds for it", async () => {
    const first = row({ fingerprint: "one", name: "alpha" });
    const second = row({ fingerprint: "two", name: "beta" });
    const client = fakeClient({
      one: { deployment: first, report: stored(report(), { fingerprint: "one" }) },
      two: { deployment: second, report: null },
    });

    const fleet = await loadFleet(client);

    expect(fleet.rows).toEqual([first, second]);
    expect(fleet.reports.one?.fingerprint).toBe("one");
    expect(fleet.reports.two).toBeUndefined();
  });

  test("a detail read that fails keeps the row and drops only the report", async () => {
    const only = row({ fingerprint: "one" });
    const client = fakeClient({ one: new Error("boom") }, [only]);

    const fleet = await loadFleet(client);

    expect(fleet.rows).toEqual([only]);
    expect(fleet.reports).toEqual({});
  });
});

describe("one event applied", () => {
  const paired = row({ fingerprint: "one", name: "alpha" });

  test("a report replaces the one held for that deployment", () => {
    const before = { rows: [paired], reports: {} };
    const event: RelayEvent = {
      type: RELAY_EVENTS.report,
      at: ago(1),
      fingerprint: "one",
      schema: 1,
      report: report(),
    };

    const after = applyEvent(before, event);

    expect(after.reports.one).toEqual({
      fingerprint: "one",
      schema: 1,
      receivedAt: event.at,
      report: event.report,
    });
    expect(after.rows).toBe(before.rows);
  });

  test("a connection change replaces the row in place", () => {
    const before = { rows: [paired], reports: {} };
    const gone = { ...paired, state: "dark" as const, connectedSince: null };

    const after = applyEvent(before, {
      type: RELAY_EVENTS.dark,
      at: ago(0),
      deployment: gone,
    });

    expect(after.rows).toEqual([gone]);
  });

  test("a deployment paired elsewhere and booting for the first time is inserted", () => {
    const fresh = row({ fingerprint: "two", name: "beta" });

    const after = applyEvent(
      { rows: [paired], reports: {} },
      { type: RELAY_EVENTS.connected, at: ago(0), deployment: fresh },
    );

    expect(after.rows.map((entry) => entry.fingerprint)).toEqual(["one", "two"]);
  });

  test("an alert changes nothing: it is a moment, not a fact (#524 §1)", () => {
    const before = { rows: [paired], reports: {} };

    const after = applyEvent(before, {
      type: RELAY_EVENTS.alert,
      at: ago(0),
      alert: {
        schema: 1,
        kind: "alert",
        condition: "dark",
        state: "raised",
        deployment: { name: "alpha", keyFingerprint: "one" },
        since: ago(5),
        detail: "no heartbeat for 5 min",
        text: "alpha: dark (no heartbeat for 5 min)",
        url: "https://relay.example/#/d/one",
      },
    });

    expect(after).toBe(before);
  });

  test("an event that lands before the read applies to the empty fleet", () => {
    const after = applyEvent(EMPTY_FLEET, {
      type: RELAY_EVENTS.connected,
      at: ago(0),
      deployment: paired,
    });

    expect(after.rows).toEqual([paired]);
    expect(EMPTY_FLEET.rows).toEqual([]);
  });
});
