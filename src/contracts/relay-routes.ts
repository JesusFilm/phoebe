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
