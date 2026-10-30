// The **deployment API** a paired client speaks to one deployment over Tailscale
// (map #690; decided in #694 and #698). Pure constants and types, so the
// companion's renderer and a future mobile client can load them from
// `phoebe-agent/contracts`; the server is bootstrap/remote-api.ts.
//
// One integer, `REMOTE_PROTOCOL`, numbers the whole surface. It moves only for a
// change an older client would misread; adding a field an old client ignores
// does not move it. The companion reads it off the open descriptor before it
// spends a code, and treats a newer one as `blocked: protocol`.

import type { DeploymentArm } from "./deployment.ts";

/** The protocol this build speaks. Mirrored by hand in index.mjs. */
export const REMOTE_PROTOCOL = 1;

/** The one open read: who answers here, before any code is spent. */
export const DESCRIPTOR_PATH = "/.well-known/phoebe/deployment";

/**
 * The listener's Unix socket on the sidecar arm, in the directory both
 * services mount. Never a TCP port there: in userspace mode netstack forwards
 * an unserved tailnet port to loopback, so a loopback listener would answer
 * every tailnet device around Serve (#691).
 */
export const API_SOCKET_PATH = "/var/run/phoebe/api.sock";

/**
 * The paths under `/api`, as one closed record. A string literal copied into a
 * fetch is how a path drifts; importing it is how it does not.
 */
export const REMOTE_ROUTES = {
  /** GET, open — the descriptor. */
  descriptor: DESCRIPTOR_PATH,
  /** POST, open — spend a pairing code for a session. */
  pair: "/api/pair",
  /** GET, read — `{ report, builtAt }`. */
  report: "/api/report",
  /** GET, read — the event stream. */
  events: "/api/events",
  /** GET, read — this session. DELETE, read — sign out (idempotent, 204). */
  session: "/api/session",
  /** GET, operate — every session. `DELETE /api/sessions/:id`, operate — revoke one. */
  sessions: "/api/sessions",
  /** POST, operate — one config edit. */
  configSet: "/api/config-set",
  /** POST, operate — run doctor. */
  doctorRun: "/api/doctor-run",
  /** POST, operate — set or clear a tenant secret. */
  secrets: "/api/secrets",
  /**
   * GET, read — the container's output as server-sent events: a `backlog`
   * event with the lines the deployment holds, then one `line` per line as it
   * is printed, a comment every 25 s. Every line has the deployment's secrets
   * redacted before it leaves.
   */
  logs: "/api/logs",
  /** POST, operate — drain every pipeline and hold the fleet down. */
  fleetStop: "/api/fleet/stop",
  /** POST, operate — release the hold and bring the fleet back up. */
  fleetStart: "/api/fleet/start",
} as const;

/** What a session may do: `read` sees, `operate` changes files or the store. */
export type RemoteScope = "read" | "operate";

/** What a client says it is at pair time. */
export type RemoteDeviceType = "desktop" | "mobile";

/** The open descriptor's body. */
export type RemoteDescriptor = {
  /** `dep_` and 26 Crockford base32 characters, minted once per data volume. */
  deploymentId: string;
  name: string;
  protocol: number;
  /** The `phoebe-agent` version the bootstrapper runs. */
  version: string;
  arm: "sidecar" | "host";
};

/** `POST /api/pair`'s body. */
export type PairRequest = {
  code: string;
  client: { label: string; deviceType: RemoteDeviceType; os: string };
};

/** `POST /api/pair`'s answer: the one time the token exists on the wire. */
export type PairResponse = {
  token: string;
  expiresAt: string;
  scopes: RemoteScope[];
  deploymentId: string;
};

/** One paired device's standing, as the list and `phoebe sessions` show it. */
export type SessionRow = {
  id: string;
  scopes: RemoteScope[];
  label: string;
  deviceType: RemoteDeviceType;
  os: string;
  /** The `Tailscale-User-Login` Serve supplied at pair time; null on the host arm. */
  pairedAs: string | null;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string;
};

/** `GET /api/session`'s answer: this session, minus what the list adds. */
export type SessionSelf = Pick<SessionRow, "id" | "label" | "scopes" | "issuedAt" | "expiresAt">;

/** `GET /api/sessions`'s answer. */
export type SessionsResponse = { sessions: SessionRow[]; self: string };

/** The 401 body. `expired` is said because the client holds the token and the message differs. */
export type UnauthenticatedBody = { error: "unauthenticated"; reason: "expired" | "unknown" };

/** The 403 body: right token, wrong scope. */
export type ForbiddenBody = { error: "forbidden"; needs: RemoteScope };

/** `GET /api/report`'s answer. */
export type ReportResponse<R = unknown> = { report: R | null; builtAt: string | null };

/** `POST /api/doctor-run`'s answer: the runner's own words. */
export type DoctorRunResponse = { outcome: "started" | "joined" | "refused"; detail?: string };

/**
 * `POST /api/fleet/stop` and `/api/fleet/start`'s answer. `unchanged` is a
 * stop on a fleet already held, or a start on one already running: nothing
 * moved, and the report says which it was.
 */
export type FleetVerbResponse = {
  outcome: "stopped" | "started" | "unchanged" | "refused";
  detail?: string;
};

/**
 * The fleet is held down (map #690): who asked and when. Null on the report's
 * bootstrapper section while the fleet runs. The container and the API stay
 * up under a stop — that is what lets a device start it again — so this is
 * not the container being down, which only `phoebe stop` on the host does.
 */
export type FleetStop = { by: string; at: string };

/** The first event on `/api/logs`: what the deployment held when the stream opened. */
export type LogsBacklog = { lines: string[] };

/** One `line` event on `/api/logs`. */
export type LogsLineEvent = { line: string };

/** The deployment report's section (replaces the relay's). */
export type RemoteReport = {
  /** Is there a `remote` block at all? */
  configured: boolean;
  arm: "sidecar" | "host" | null;
  /** `https://<node>.ts.net[:port]`, once the deployment has learned it. */
  url: string | null;
  sessions: { active: number; expired: number };
  /** The sessions file differs from what this bootstrapper last wrote (#696). */
  tampered: boolean;
  /**
   * The pair budget (#694): rejected attempts in the last minute, and whether
   * every attempt is being refused for it. Optional, so an older report reads.
   */
  pairRejections?: { lastMinute: number; refusing: boolean };
  updatedAt: string;
};

export type { DeploymentArm };
