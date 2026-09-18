// Runtime surface of `phoebe-agent/contracts` — the `import` condition of the
// subpath export. Almost everything here is types, and types leave nothing
// behind at runtime; what is left is the handful of pure constants a reader
// needs to *check* something, written twice by hand.
//
// Twice, because Node will not type-strip a `.ts` file out of node_modules: an
// installed consumer's `import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts"`
// resolves to this file and never to index.ts. The type condition points at the
// `.ts`, so a type-checker reads the documented declaration and a runtime reads
// this. src/contracts/deployment.test.ts and src/contracts/index.test.ts hold
// the copies to the same value; bootstrap/index.mjs exists for the same reason.

/** The `schema` integer `state/deployment.json` carries — see deployment.ts. */
export const DEPLOYMENT_SCHEMA = 1;

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
