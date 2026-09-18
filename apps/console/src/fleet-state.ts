// The fleet, as the page holds it, and what each event does to it (#542).
//
// Two reads and one stream, and the stream is not a third read (relay/http.ts):
// every event carries the fact that just became true, in full, so applying one is
// a replacement rather than a merge. That is what makes this a plain reducer with
// no reconciliation in it — and why a page that missed an event catches up by
// calling `loadFleet` again rather than by asking the relay what it missed.

import { RELAY_EVENTS } from "phoebe-agent/contracts";
import type { RelayDeploymentRow, RelayEvent, RelayStoredReport } from "phoebe-agent/contracts";
import type { RelayClient } from "./relay-client.ts";

/** The fleet: one row per link, plus the last report each one pushed. */
export type FleetState = {
  rows: RelayDeploymentRow[];
  /** Keyed by fingerprint. A deployment that has never reported has no entry. */
  reports: Record<string, RelayStoredReport>;
};

export const EMPTY_FLEET: FleetState = { rows: [], reports: {} };

/**
 * The initial read: the rows, then each row's report.
 *
 * One request per row, because `/api/deployments` answers rows only and a bar
 * segment per pipeline is a fact from the report (relay-routes.ts). They go out
 * together, and a row whose detail fails is kept with no report rather than
 * dropped — the relay's connection facts for it are still true, and "connected,
 * report unreadable" is a state an operator needs to see.
 */
export async function loadFleet(client: RelayClient): Promise<FleetState> {
  const rows = await client.deployments();
  const details = await Promise.all(
    rows.map((row) =>
      client.deployment(row.fingerprint).then(
        (detail) => detail.report,
        () => null,
      ),
    ),
  );
  const reports: Record<string, RelayStoredReport> = {};
  rows.forEach((row, index) => {
    const report = details[index];
    if (report != null) reports[row.fingerprint] = report;
  });
  return { rows, reports };
}

/**
 * One event applied. Returns the same object when nothing moved, so a React
 * setter can skip a render it does not need.
 *
 * A connection event for a fingerprint the page has never seen **inserts** the
 * row. That is a deployment paired in another browser tab and booting for the
 * first time, and dropping it would leave the fleet page quietly a row short
 * until someone reloaded.
 */
export function applyEvent(state: FleetState, event: RelayEvent): FleetState {
  if (event.type === RELAY_EVENTS.report) {
    const stored: RelayStoredReport = {
      fingerprint: event.fingerprint,
      schema: event.schema,
      receivedAt: event.at,
      report: event.report,
    };
    return { rows: state.rows, reports: { ...state.reports, [event.fingerprint]: stored } };
  }

  const incoming = event.deployment;
  const index = state.rows.findIndex((row) => row.fingerprint === incoming.fingerprint);
  if (index === -1) return { rows: [...state.rows, incoming], reports: state.reports };
  const rows = [...state.rows];
  rows[index] = incoming;
  return { rows, reports: state.reports };
}
