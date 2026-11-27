// The supervisor side of the engine's report rail (#532) — the adapter that
// turns one child's IPC messages into notes on the live deployment report.
//
// Same shape as the broker's adapter (bootstrap/broker-ipc.ts) and the same
// channel: each engine child is spawned with IPC, runs `createReportClient`
// (src/report-client.ts), and sends three kinds of message. A completed loop pass
// moves that pipeline's pass clock; a `status.json` write hands over the
// snapshot the deployment report publishes; a unit record appended to the
// pipeline's history moves its history summary (#929), and the record it
// carries goes on to the OTLP forwarder when one is running (#993).
//
// This is where #501's "the bootstrapper learns of a snapshot change over the
// existing engine→parent IPC" lands. Not `fs.watch` — the config watch already
// found that unreliable on Node 24, and the channel is both already there and
// already ordered with respect to the child's own writes.
//
// A malformed message is ignored. The rail is one-way and unacknowledged, so
// there is nothing to answer and nothing a bad message can wedge.

import { REPORT_PASS, REPORT_RECORD, REPORT_STATUS } from "../src/report-client.ts";
import type { StatusSnapshot } from "../src/contracts/status-snapshot.ts";
import { UNIT_RECORD_VERSION, type UnitRecord } from "../src/contracts/unit-record.ts";
import type { BrokerChild } from "./broker-ipc.ts";
import type { DeploymentState } from "./deployment-state.ts";

function fieldOf(message: unknown, key: string): unknown {
  return typeof message === "object" && message !== null
    ? (message as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The record a record message carries, when it is one this bootstrapper can
 * read. An engine older than #993 sends none, and one newer than this
 * bootstrapper may send a version it does not know; neither is forwarded.
 */
function recordOf(message: unknown): UnitRecord | null {
  const record = fieldOf(message, "record");
  if (fieldOf(record, "v") !== UNIT_RECORD_VERSION) return null;
  const unit = fieldOf(record, "unit");
  if (typeof fieldOf(unit, "kind") !== "string" || typeof fieldOf(unit, "id") !== "string") {
    return null;
  }
  if (typeof fieldOf(record, "startedAt") !== "string") return null;
  if (!Array.isArray(fieldOf(record, "agentRuns"))) return null;
  return record as UnitRecord;
}

/**
 * Wire one child's report messages to the deployment state under its pipeline
 * id. Call once at spawn, beside `attachBroker`.
 */
export function attachEngineReports(opts: {
  pipelineId: string;
  child: BrokerChild;
  state: DeploymentState;
  /** A unit record landed and came over the rail whole: the OTLP forwarder's input. */
  onRecord?: (record: UnitRecord) => void;
}): void {
  const { pipelineId, child, state, onRecord } = opts;
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
      case REPORT_RECORD: {
        state.noteEngineReport(pipelineId, { kind: "record" });
        const record = recordOf(message);
        if (record !== null) onRecord?.(record);
        break;
      }
    }
  });
}
