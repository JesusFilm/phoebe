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
  /** GET — every deployment this relay knows, with where each one stands. */
  deployments: "/api/deployments",
  /**
   * POST — **forget** one deployment, named by fingerprint in the body (#505
   * §4). The fingerprint rides in the body rather than the path so this stays
   * one importable constant; no fingerprint spells `forget`, and the
   * per-deployment read this shares a prefix with is a GET.
   */
  forget: "/api/deployments/forget",
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
