// The supervisor side of the engine's report rail (#532): a child's pass and
// status messages reach the deployment state, and nothing else does.

import { describe, expect, test } from "vite-plus/test";
import { REPORT_PASS, REPORT_STATUS } from "../src/report-client.ts";
import { SLOT_ACQUIRE } from "../src/slot-client.ts";
import type { StatusSnapshot } from "../src/contracts/status-snapshot.ts";
import type { BrokerChild } from "./broker-ipc.ts";
import { attachEngineReports } from "./engine-report-ipc.ts";
import type { DeploymentState, EngineReport } from "./deployment-state.ts";

function fakeChild(): BrokerChild & { emitMessage: (message: unknown) => void } {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    on: (event, listener) => {
      if (event === "message") listeners.push(listener as (message: unknown) => void);
    },
    emitMessage: (message) => listeners.forEach((listener) => listener(message)),
  };
}

function recorder(): { state: DeploymentState; seen: Array<[string, EngineReport]> } {
  const seen: Array<[string, EngineReport]> = [];
  const noop = (): void => {};
  return {
    seen,
    state: {
      noteEngine: noop,
      noteReconcile: noop,
      noteSpawn: noop,
      noteDraining: noop,
      noteExit: noop,
      noteEngineReport: (id: string, report: EngineReport) => seen.push([id, report]),
      notePipelines: noop,
      noteHolds: noop,
      publish: noop,
    } as unknown as DeploymentState,
  };
}

const snapshot: StatusSnapshot = {
  tenant: "acme/widget",
  pipeline: "work",
  currentUnits: [],
  waitingForSlot: false,
  lastError: null,
  lastTimeoutAt: null,
  updatedAt: "2026-05-05T00:00:00.000Z",
};

describe("attachEngineReports", () => {
  test("a pass carries the pipeline's own cadence up to the supervisor", () => {
    const { state, seen } = recorder();
    const child = fakeChild();
    attachEngineReports({ pipelineId: "t#work", child, state });

    child.emitMessage({ type: REPORT_PASS, pollIntervalMs: 900_000 });
    expect(seen).toEqual([["t#work", { kind: "pass", pollIntervalMs: 900_000 }]]);
  });

  test("a pass from an engine that names no cadence still moves the clock", () => {
    const { state, seen } = recorder();
    const child = fakeChild();
    attachEngineReports({ pipelineId: "t#work", child, state });

    child.emitMessage({ type: REPORT_PASS });
    expect(seen).toEqual([["t#work", { kind: "pass", pollIntervalMs: null }]]);
  });

  test("a status message hands over the snapshot the child just wrote", () => {
    const { state, seen } = recorder();
    const child = fakeChild();
    attachEngineReports({ pipelineId: "t#work", child, state });

    child.emitMessage({ type: REPORT_STATUS, snapshot });
    expect(seen).toEqual([["t#work", { kind: "status", snapshot }]]);
  });

  test("the broker's messages, and malformed ones, are not this adapter's business", () => {
    const { state, seen } = recorder();
    const child = fakeChild();
    attachEngineReports({ pipelineId: "t#work", child, state });

    child.emitMessage({ type: SLOT_ACQUIRE });
    child.emitMessage({ type: REPORT_STATUS });
    child.emitMessage("not an object");
    child.emitMessage(null);
    expect(seen).toEqual([]);
  });
});
