// The relay's HTTP paths, as one closed record. Lives in contracts because two
// codebases have to agree on them and only one of them is this repo: the relay
// serves these paths, and the console — in a browser, and in the companion's
// renderer over the desktop bridge — calls them (#538, map #497 §10).
//
// A string literal copied into a fetch is how a path drifts. Importing it is
// how it does not.

/**
 * Every path the relay answers on. `as const` so each value is its own literal
 * type and a typo in a caller is a type error rather than a 404 at runtime.
 *
 * Sign-in is split between two paths because Google demands it: `signIn` is the
 * one a person's browser is sent to, `callback` is the single redirect URI
 * registered with Google for this relay. The companion starts on its own
 * `/auth/device/*` path and comes back through that same one callback (#523
 * §2), so Google still knows exactly one redirect URI.
 */
export const RELAY_ROUTES = {
  /** GET — start the Google authorization-code flow; redirects to Google. */
  signIn: "/auth/google/start",
  /** GET — Google's redirect back; the only URI registered with Google. */
  callback: "/auth/google/callback",
  /** POST — drop this browser's session. */
  signOut: "/auth/sign-out",
  /**
   * GET — start a companion's sign-in (#523 §2). Takes `challenge`, the S256 of
   * a PKCE verifier only the companion holds, and `name`, what the companion
   * calls itself. It runs the same Google flow `signIn` does; what differs is
   * where a completed sign-in lands, which is the custom scheme.
   */
  deviceStart: "/auth/device/start",
  /**
   * POST — spend the one-time code from `phoebe://auth?code=…` for a device
   * token. The body is `DeviceExchange`, and its verifier is what proves this
   * is the instance that started the flow.
   */
  deviceExchange: "/auth/device/exchange",
  /** POST — revoke the bearer this request carries. How a companion signs out. */
  deviceRevoke: "/auth/device/revoke",
  /**
   * GET — every companion signed in to this relay, whoever it belongs to. The
   * People page groups them by person and draws a remove beside each (#523 §4).
   */
  devices: "/api/devices",
  /**
   * POST — revoke devices: one named by `id`, or all of one person's named by
   * `sub`, which is what removing them from the allowlist does. The selector
   * rides in the body, as `forget`'s does, so this stays one importable path.
   */
  deviceRemove: "/api/devices/remove",
  /** GET — who the session belongs to. The read that proves a session works. */
  me: "/api/me",
  /** POST — mint a pairing token for one new deployment. Shown once (#540). */
  pairingTokens: "/api/pairing-tokens",
  /**
   * GET — every deployment this relay knows, with where each one stands. One
   * deployment on its own is this path plus its fingerprint,
   * `/api/deployments/<fingerprint>`: that read answers the same row and the
   * last report the relay took delivery of (#542).
   */
  deployments: "/api/deployments",
  /**
   * POST — **forget** one deployment, named by fingerprint in the body (#505
   * §4). The fingerprint rides in the body rather than the path so this stays
   * one importable constant; no fingerprint spells `forget`, and the
   * per-deployment read this shares a prefix with is a GET.
   */
  forget: "/api/deployments/forget",
  /**
   * GET — the server-sent-events stream: reports and connection changes as they
   * happen, so a page updates without polling (#506 §10, #542). The event names
   * and their payloads are in relay-events.ts.
   */
  events: "/api/events",
} as const;

/** One of the relay's paths. */
export type RelayRoute = (typeof RELAY_ROUTES)[keyof typeof RELAY_ROUTES];

/**
 * Where a companion's sign-in lands: the custom scheme the companion registers
 * with the OS, carrying the one-time code as `?code=` (#523 §2).
 *
 * It is in contracts because two codebases have to agree on the string — the
 * relay redirects to it, the companion registers the scheme in front of it. The
 * companion serves its own renderer on that same scheme under a different host
 * (`phoebe://console/`); the host is what keeps the two apart.
 */
export const COMPANION_AUTH_URL = "phoebe://auth";

/**
 * How long a companion has to spend its one-time code. Sixty seconds, because
 * the only gap it covers is the OS handing one URL to a running process — the
 * operator's time in front of Google is already spent by the time the code
 * exists (#523 §2).
 */
export const DEVICE_CODE_TTL_MS = 60_000;

/**
 * The body of `POST /auth/device/exchange`. `verifier` is the PKCE secret the
 * companion minted before opening the browser; the relay hashes it and checks
 * it against the challenge the code was bound to. That binding is what makes
 * the scheme hop safe — any app can register `phoebe://`, but only the one
 * holding the verifier can spend the code (#523 §2).
 */
export type DeviceExchange = { code: string; verifier: string };

/**
 * What the exchange answers. `token` is the whole of the secret and this is the
 * only time it exists outside the companion's keyring: the relay keeps its
 * SHA-256 and nothing else, so there is no second chance to read it.
 */
export type DeviceExchangeResult = { token: string; device: RelayDevice };

/**
 * One signed-in companion, as the relay can describe it (#523 §3). The token is
 * not in here and cannot be derived from anything that is — `id` is the relay's
 * own name for the device, minted beside the token rather than out of it.
 *
 * There is no expiry field because there is no expiry. A device token ends when
 * someone revokes it, and that is the whole of its lifecycle.
 */
export type RelayDevice = {
  /** The relay's name for this device — what `deviceRemove` takes. */
  id: string;
  /** Google's `sub`: which person this companion signed in as. */
  sub: string;
  /** The address that person signed in with, as the allowlist recorded it. */
  email: string;
  /** What the companion calls itself — hostname and OS (#523 glossary). */
  name: string;
  /** ISO 8601, when the token was issued. */
  createdAt: string;
  /** ISO 8601 of the last request that carried this token, or null. */
  lastSeenAt: string | null;
};

/** The body of `GET /api/me` — the signed-in person, as the relay knows them. */
export type RelayIdentity = {
  /** Google's `sub`: the stable key a person is recorded under. */
  sub: string;
  /** The verified address that person signed in with. */
  email: string;
};

/**
 * Where the relay holds one deployment, in four words (#501, #507 §1). The
 * relay derives this and never stores it: it is a reading of one clock against
 * one `lastSeen`, and a stored copy would be wrong the second after it was
 * written.
 *
 *  - `connected` — a live socket, right now.
 *  - `disconnected` — heard from inside the dark window. A fact with a
 *    duration, not a verdict: the relay cannot know whether the deployment is
 *    reconnecting, so it says how long it has been quiet and no more.
 *  - `dark` — `RELAY_DARK_AFTER_MS` unheard, however the connection
 *    ended. Requests to it are refused up front.
 *  - `unseen` — a link with no completed handshake behind it. Not the same as
 *    dark, and a console that conflated them would accuse an operator of losing
 *    a deployment they have never booted.
 */
export type RelayConnectionState = "connected" | "disconnected" | "dark" | "unseen";

/**
 * One deployment as the relay can describe it: the link from `links.json`, plus
 * the connection facts only the live process knows. The doctor report is not
 * here and never will be — the relay answers none of doctor's checks, and its
 * own facts are a separate panel beside it (#507 §8).
 */
export type RelayDeploymentRow = {
  /** The link's fingerprint: the name files, URLs and requests use. */
  fingerprint: string;
  /** What the deployment calls itself. Two rows may share one. */
  name: string;
  /** ISO 8601, when the pairing token was spent. */
  firstSeen: string;
  /** ISO 8601 of the last completed handshake, or null for an unseen link. */
  lastSeen: string | null;
  /** The address that minted the token this link was paired with. */
  pairedBy: string;
  state: RelayConnectionState;
  /** ISO 8601 of the live connection's start, when there is one. */
  connectedSince: string | null;
  /**
   * How long it has been quiet, in whole seconds, while `disconnected`. Null in
   * every other state: a dark deployment's age is read off `lastSeen`, and
   * counting seconds past the threshold would dress one fact as two.
   */
  disconnectedForSeconds: number | null;
  /** How the last connection ended, in this process. Null before the first. */
  lastClose: { code: number; reason: string; at: string } | null;
  /**
   * A newer link shares this dark link's name (#505 §5). A data-volume wipe
   * loses the deployment key, so re-pairing is a new record and the old one
   * stays behind — evidence, not garbage. The relay says "probably replaced"
   * and leaves the forgetting to a person.
   */
  maybeReplaced: boolean;
};

/**
 * One deployment report as the relay holds it (#506 §3, #542). The relay keeps
 * the latest per deployment and nothing else: no history, no deltas, one file
 * per fingerprint that the next report replaces.
 *
 * `report` is `unknown` here and everywhere in the relay. The deployment owns
 * the report's shape (`DeploymentReport` in deployment.ts) and the relay stores
 * and forwards it without reading a field of it, so a console newer than its
 * relay renders sections this relay has never heard of.
 */
export type RelayStoredReport = {
  /** The deployment this report came from. */
  fingerprint: string;
  /** The report's own `schema` integer, hoisted out of the opaque body. */
  schema: number;
  /** When the relay took delivery, ISO 8601. Not when the deployment built it. */
  receivedAt: string;
  /** The report, exactly as it arrived. */
  report: unknown;
};

/**
 * The body of `GET /api/deployments/<fingerprint>`: what the deployment last
 * said about itself, and what the relay knows about the connection it said it
 * over. Two sources, side by side and never merged — the relay's connection
 * facts are not in the report, and nothing in the report is the relay's to
 * derive (#507 §8).
 *
 * `report` is null for a deployment that has never pushed one: a link paired
 * against a deployment that has not booted since, or one whose report was lost
 * with the relay's volume.
 */
export type RelayDeploymentDetail = {
  deployment: RelayDeploymentRow;
  report: RelayStoredReport | null;
};
