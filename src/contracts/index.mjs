// Runtime surface of `phoebe-agent/contracts` — the `import` condition of the
// subpath export. Nearly everything in contracts is type declarations, and
// types leave nothing behind at runtime; this entry carries the few values that
// are pure enough to live in the subpath.
//
// A value here is written twice: typed in index.ts for the type condition, and
// in plain JS here for Node, which will not type-strip a `.ts` file out of
// node_modules. Same reason bootstrap/index.mjs exists. The two copies are held
// together by index.test.ts, which compares them key by key — a hand-written
// mirror nothing checks is a mirror that drifts.

/**
 * The relay's HTTP paths (#538). Mirror of `RELAY_ROUTES` in relay-routes.ts;
 * the doc comments live there.
 */
export const RELAY_ROUTES = {
  signIn: "/auth/google/start",
  callback: "/auth/google/callback",
  signOut: "/auth/sign-out",
  me: "/api/me",
};
