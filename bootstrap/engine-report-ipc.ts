// The supervisor side of the engine's report rail (#532) — the adapter that
// turns one child's IPC messages into notes on the live deployment report.
//
// Same shape as the broker's adapter (bootstrap/broker-ipc.ts) and the same
// channel: each engine child is spawned with IPC, runs `createReportClient`
// (src/report-client.ts), and sends two kinds of message. A completed loop pass
// moves that pipeline's pass clock; a `status.json` write hands over the
// snapshot the deployment report publishes.
//
// This is where #501's "the bootstrapper learns of a snapshot change over the
// existing engine→parent IPC" lands. Not `fs.watch` — the config watch already
// found that unreliable on Node 24, and the channel is both already there and
// already ordered with respect to the child's own writes.
//
// A malformed message is ignored. The rail is one-way and unacknowledged, so
// there is nothing to answer and nothing a bad message can wedge.

import { REPORT_PASS, REPORT_STATUS } from "../src/report-client.ts";
import type { StatusSnapshot } from "../src/contracts/status-snapshot.ts";
import type { BrokerChild } from "./broker-ipc.ts";
import type { DeploymentState } from "./deployment-state.ts";

function fieldOf(message: unknown, key: string): unknown {
  return typeof message === "object" && message !== null
    ? (message as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Wire one child's report messages to the deployment state under its pipeline
 * id. Call once at spawn, beside `attachBroker`.
 */
export function attachEngineReports(opts: {
  pipelineId: string;
  child: BrokerChild;
  state: DeploymentState;
}): void {
  const { pipelineId, child, state } = opts;
  child.on("message", (message) => {
    switch (fieldOf(message, "type")) {
      case REPORT_PASS: {
        const declared = fieldOf(message, "pollIntervalMs");
        state.noteEngineReport(pipelineId, {
          kind: "pass",
          pollIntervalMs: typeof declared === "number" && declared > 0 ? declared : null,
        });
        break;
      }
      case REPORT_STATUS: {
        const snapshot = fieldOf(message, "snapshot");
        if (typeof snapshot === "object" && snapshot !== null) {
          state.noteEngineReport(pipelineId, {
            kind: "status",
            snapshot: snapshot as StatusSnapshot,
          });
        }
        break;
      }
    }
  });
}
