// The engine's side of the deployment report (#532) — two messages up the IPC
// channel it already has (bootstrap/engine-report-ipc.ts on the other end).
//
// The bootstrapper keeps one read model for the whole deployment, and two facts
// in it are the engine's to tell:
//
//   - **pass** — this loop pass is over. The bootstrapper holds the arrival time
//     in memory as that pipeline's pass clock, which is what makes a child whose
//     process lives but whose loop has stopped visible at all (#507): an idle
//     engine writes no snapshot, so nothing else about it ever moves. The
//     message carries the pipeline's own `pollIntervalMs` because the supervisor
//     does not know it — the cadence is declared on the pipeline and overlaid by
//     env, both of which this process has already resolved and the bootstrapper
//     has not.
//   - **status** — the `status.json` this pass just wrote, so the report's copy
//     of the snapshot moves when the file does. Over IPC rather than `fs.watch`,
//     which #501 rejected: the channel is already there and already ordered.
//
// Both are fire-and-forget. Nothing the engine does waits on them, an
// unsupervised engine (no channel) gets a null client and sends nothing, and a
// send that fails because the supervisor went away is swallowed — the engine's
// work must never depend on being watched.

import type { StatusSnapshot } from "./contracts/status-snapshot.ts";
import type { ParentChannel } from "./slot-client.ts";

/** This engine finished a loop pass. */
export const REPORT_PASS = "phoebe:report:pass";
/** This engine rewrote its `status.json`; the new snapshot rides along. */
export const REPORT_STATUS = "phoebe:report:status";

export type ReportClient = {
  /** Report a completed loop pass, with the cadence the next one is due on. */
  pass(pollIntervalMs: number): void;
  /** Report the snapshot as it now stands on disk. */
  snapshot(snapshot: StatusSnapshot): void;
};

/**
 * Build the reporter bound to the parent IPC channel, or null when there is no
 * channel — a standalone engine (dev, `--run-once`, a local mount) has no
 * bootstrapper to report to, exactly as it has no slot broker to ask.
 *
 * Every send carries an error-first callback: a callback-less `send` over a
 * channel the supervisor has already closed emits an `'error'` on `process` that
 * nothing is listening for, and a report is the last thing that should be able
 * to kill an engine mid-drain. The throw the same case raises synchronously is
 * swallowed here for the same reason.
 */
export function createReportClient(parent: ParentChannel): ReportClient | null {
  if (typeof parent.send !== "function") return null;
  const send = (message: unknown): void => {
    try {
      parent.send?.(message, () => {});
    } catch {
      // The supervisor is gone or going. Nothing here is worth an exception.
    }
  };
  return {
    pass: (pollIntervalMs) => send({ type: REPORT_PASS, pollIntervalMs }),
    snapshot: (snapshot) => send({ type: REPORT_STATUS, snapshot }),
  };
}
