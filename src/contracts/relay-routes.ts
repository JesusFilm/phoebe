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
 * registered with Google for this relay. A native companion's sign-in gets its
 * own `/auth/device/*` paths when it lands (#523) and does not disturb these.
 */
export const RELAY_ROUTES = {
  /** GET — start the Google authorization-code flow; redirects to Google. */
  signIn: "/auth/google/start",
  /** GET — Google's redirect back; the only URI registered with Google. */
  callback: "/auth/google/callback",
  /** POST — drop this browser's session. */
  signOut: "/auth/sign-out",
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
   * POST — **set one config field** on one deployment (#503, #547). The
   * deployment's fingerprint rides in the body beside the patch, for the reason
   * `forget` does: one importable constant, and the per-deployment read this
   * shares a prefix with is a GET.
   */
  configSet: "/api/deployments/config-set",
  /**
   * GET — the server-sent-events stream: reports and connection changes as they
   * happen, so a page updates without polling (#506 §10, #542). The event names
   * and their payloads are in relay-events.ts.
   */
  events: "/api/events",
  /**
   * POST — set or clear one tenant secret on a deployment (#550). The body
   * carries the fingerprint, the tenant, the key and — on a set — the envelope
   * the **browser** sealed to that deployment's box key. The relay forwards it
   * unopened and cannot do otherwise; what it adds is `by`, from its own
   * session, so the ledger entry on the deployment names a person rather than
   * whatever the caller claimed.
   *
   * The answer is the deployment's receipt: `written`, `refused`, or the
   * relay's own `undelivered` when the socket went away with the request in
   * flight. Nothing is queued.
   */
  secrets: "/api/secrets",
} as const;

/** One of the relay's paths. */
export type RelayRoute = (typeof RELAY_ROUTES)[keyof typeof RELAY_ROUTES];

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
  /**
   * The deployment key's public half — raw Ed25519, base64url. The fingerprint
   * above is derived from exactly these bytes, so an operator comparing the
   * fingerprint on this page with the one in the container's log is comparing
   * against this key and not against the relay's word for it (#514 §8).
   */
  publicKey: string;
  /**
   * The deployment's **box key**: raw X25519, base64url, what the console seals
   * a secret to (#549). Null for a link paired before box keys existed — that
   * deployment's secrets can be read but not set, until it reconnects and its
   * hello carries one.
   */
  boxKey: string | null;
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

/**
 * The body of `POST /api/deployments/config-set` — one field patch, addressed
 * to one deployment (#503, #547).
 *
 * What is deliberately not here is the author. The relay stamps the signed-in
 * address onto the edit before it goes on the rail, so a console cannot name
 * someone else as the editor and the ledger entry carries the session's word
 * rather than the browser's (#506).
 */
export type RelayConfigSetRequest = {
  /** Which deployment. A console reads it off the row it is looking at. */
  fingerprint: string;
  /** Idempotency key. The same id twice is the same edit, answered identically. */
  id: string;
  /** The dotted path of the leaf, as the effective-config tree spells it. */
  path: string;
  /** The new value. A leaf is a literal; nothing here carries an object. */
  value: string | number | boolean | null;
  /** The `sha256:` the page was shown, out of the report's config section. */
  configFingerprint: string;
};

/**
 * What the relay answers a config-set with: the deployment's own receipt, or
 * the relay's own word that it never got there.
 *
 * Two arms rather than one, because the relay is a courier and not a judge. A
 * receipt is quoted verbatim — a deployment newer than its relay passes through
 * rather than being mistranslated — and `undelivered` is the one outcome the
 * relay is entitled to author, because it is a fact about the socket and not
 * about the edit. A console renders that arm with the manual edit it composed
 * itself, since there is no receipt to carry one.
 *
 * `receipt` is `unknown` for the reason {@link RelayStoredReport.report} is:
 * the deployment owns the shape (`EditReceipt` in config-edit.ts) and the relay
 * hands the bytes on without reading a field of them. A console narrows it.
 */
export type RelayConfigSetAnswer = {
  /**
   * The deployment's own word — `written` or `refused` — or the relay's
   * `undelivered`. A `string` and not a union of the three, because the relay
   * quotes what it was told: a deployment newer than its relay may answer a
   * word this relay has never heard of, and passing it through is how a console
   * one version ahead reads it.
   */
  outcome: string;
  /** The receipt, absent only when the deployment never got the ask. */
  receipt?: unknown;
};
