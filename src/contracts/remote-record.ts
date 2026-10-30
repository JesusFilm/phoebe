// What the companion keeps and emits about a **remote** — one paired record of
// one deployment reached over the deployment API (map #690; decided in #697
// and #699). Types only, like the rest of contracts; the supervisor that
// produces them is apps/desktop, the pure state machine behind the
// reachability words is apps/console/src/reachability.ts, and the bridge
// between them is `remotes` in desktop-bridge.ts.
//
// **Route** is the word for one way of reaching a deployment. `local` is a
// folder on this machine read over compose exec; `remote` is one of these,
// read over the API. A deployment can have both, keyed on its `deploymentId`,
// and the companion draws both.

import type { AlertMessage } from "./alerts.ts";
import type { StoredReport } from "./local-report.ts";
import type { RemoteScope, SessionRow } from "./remote-protocol.ts";

/**
 * The companion's own reading of whether a remote can be reached — derived
 * from the stream and the last successful read, never reported by the
 * deployment (#697).
 *
 *   - `connected`     something arrived in the last 60 s.
 *   - `disconnected`  the stream dropped or a request failed, under 60 s ago.
 *   - `dark`          unheard for 60 s or more.
 *   - `blocked`       a 401, or a descriptor that rules the pairing out.
 */
export type Reachability = "connected" | "disconnected" | "dark" | "blocked";

/**
 * Why a remote is blocked, and what the row says:
 *
 *   - `expired`   `401 expired` — session expired · pair again
 *   - `revoked`   `401 unknown` with the stored id still answering — session revoked · pair again
 *   - `replaced`  the descriptor's id differs from the stored one — a different deployment answers here · pair again
 *   - `protocol`  the descriptor's protocol is newer than this companion — newer than this companion · update
 */
export type BlockedReason = "expired" | "revoked" | "replaced" | "protocol";

/** One remote as the companion persists and emits it. The bearer is never on it. */
export type RemoteRecord = {
  /** The key. Pairing a URL whose descriptor names a held id replaces that record's bearer. */
  deploymentId: string;
  /** `https://<node>.ts.net[:port]`, as paired. The rail groups on its hostname. */
  url: string;
  /** What the deployment calls itself, from the descriptor and the report. */
  name: string;
  /** The label this device gave at pair time, which the deployment's devices list shows. */
  label: string;
  arm: "sidecar" | "host";
  /** The descriptor's `protocol` at the last read. */
  protocol: number;
  scopes: RemoteScope[];
  /** The session's expiry, ISO. */
  expiresAt: string;
  /** This session's id on the deployment, for the devices list's "this device" mark. */
  sessionId: string | null;
  pairedAt: string;
  /** The last thing heard from the deployment, ISO; null before anything was. */
  lastHeardAt: string | null;
  /** The last report received, kept across a relaunch so the page is never empty. */
  lastReport: StoredReport | null;
  reachability: Reachability;
  /** Set while `reachability` is `blocked`. */
  blocked?: BlockedReason;
};

/** One supervisor emission: the record as it now stands, the way a local read emits `report`. */
export type RemoteReportEvent = {
  type: "remote";
  deploymentId: string;
  /** When the supervisor emitted it, ISO. */
  at: string;
  record: RemoteRecord;
};

/** An alert main raised over a remote (#697). Keyed on the remote route, never the deployment. */
export type RemoteAlertEvent = {
  type: "alert";
  deploymentId: string;
  at: string;
  alert: AlertMessage;
};

/** One request the renderer asks main to make with the bearer added. */
export type RemotePassthrough = {
  method: "GET" | "POST" | "DELETE";
  /** A path under `/api`, as `REMOTE_ROUTES` spells it. */
  path: string;
  body?: unknown;
};

/** What came back, status and parsed body. A transport failure is a rejection. */
export type RemoteResponse = { status: number; body: unknown };

/** What `remotes.pair` came to, each failure mapped to one line of wording in the console. */
export type PairResult =
  | { outcome: "paired"; record: RemoteRecord }
  | {
      outcome: "unreachable" | "not-phoebe" | "code-rejected" | "protocol" | "tailscale-off";
      detail: string;
    };

/**
 * One line a remote's container printed, as main forwards it off `GET
 * /api/logs` (map #690). The deployment redacted its secrets before the line
 * left it; the companion keeps it only as long as a pane follows.
 */
export type RemoteLogLine = { deploymentId: string; line: string };

/** A remote's log stream stopped on its own: the socket dropped, or the deployment refused it. */
export type RemoteLogsEnded = { deploymentId: string; reason: string };

/** What `remotes.revoke` came to. */
export type RevokeOutcome =
  | { outcome: "revoked" }
  | { outcome: "revoke-self" }
  | { outcome: "not-found" }
  | { outcome: "needs-operate" }
  | { outcome: "failed"; detail: string };

export type { SessionRow };
