// The engine's side of the report rail (#532): three fire-and-forget messages, a
// null client when nothing is supervising, and a send that can never take the
// engine down.

import { describe, expect, test } from "vite-plus/test";
import { createReportClient, REPORT_PASS, REPORT_RECORD, REPORT_STATUS } from "./report-client.ts";
import type { StatusSnapshot } from "./contracts/status-snapshot.ts";
import type { UnitRecord } from "./contracts/unit-record.ts";

const snapshot: StatusSnapshot = {
  tenant: "acme/widget",
  pipeline: "work",
  currentUnits: [],
  waitingForSlot: false,
  lastError: null,
  lastTimeoutAt: null,
  updatedAt: "2026-05-05T00:00:00.000Z",
};

const record = {
  v: 1,
  tenant: "acme/widget",
  pipeline: "work",
  unit: { kind: "issues", id: "7" },
} as unknown as UnitRecord;

describe("createReportClient", () => {
  test("an engine with no IPC channel has nobody to report to", () => {
    expect(createReportClient({})).toBeNull();
  });

  test("a pass names the pipeline's cadence, which the supervisor cannot know", () => {
    const sent: unknown[] = [];
    const client = createReportClient({ send: (message) => sent.push(message) })!;
    client.pass(900_000);
    expect(sent).toEqual([{ type: REPORT_PASS, pollIntervalMs: 900_000 }]);
  });

  test("a snapshot rides over the channel rather than being re-read from disk", () => {
    const sent: unknown[] = [];
    const client = createReportClient({ send: (message) => sent.push(message) })!;
    client.snapshot(snapshot);
    expect(sent).toEqual([{ type: REPORT_STATUS, snapshot }]);
  });

  test("a new unit record rides along, for the forwarder that sends each one once", () => {
    const sent: unknown[] = [];
    const client = createReportClient({ send: (message) => sent.push(message) })!;
    client.record(record);
    expect(sent).toEqual([{ type: REPORT_RECORD, record }]);
  });

  test("every send carries an error-first callback, so a closed channel is handled", () => {
    const callbacks: unknown[] = [];
    const client = createReportClient({
      send: (_message, callback) => callbacks.push(callback),
    })!;
    client.pass(1000);
    expect(typeof callbacks[0]).toBe("function");
  });

  test("a supervisor that went away mid-send is not the engine's problem", () => {
    const client = createReportClient({
      send: () => {
        throw new Error("ERR_IPC_CHANNEL_CLOSED");
      },
    })!;
    expect(() => client.pass(1000)).not.toThrow();
    expect(() => client.snapshot(snapshot)).not.toThrow();
    expect(() => client.record(record)).not.toThrow();
  });
});
