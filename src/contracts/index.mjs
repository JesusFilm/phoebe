// Runtime surface of `phoebe-agent/contracts` — the `import` condition of the
// subpath export. Most of contracts is type declarations, which leave nothing
// behind at runtime; what lands here is the constants a reader needs to *check*
// something and the functions a consumer actually calls.
//
// Plain JS, because Node will not type-strip a `.ts` file under a
// `node_modules` segment and the installed package lives exactly there: a
// consumer's `import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts"`
// resolves to this file and never to index.ts. The types come from index.ts (the
// `types` condition). Anything with an implementation lives in a plain-JS
// sibling and is re-exported here, written once; the bare constants below are
// mirrored by hand from their `.ts` declaration, and
// src/contracts/deployment.test.ts and src/contracts/index.test.ts hold the two
// copies to the same value. bootstrap/index.mjs exists for the same reason.

export { openSecret, sealSecret } from "./secret-envelope.mjs";

/** The `schema` integer `state/deployment.json` carries — see deployment.ts. */
export const DEPLOYMENT_SCHEMA = 1;

/** The wire version both ends exchange in the handshake — see relay-protocol.ts. */
export const RELAY_PROTOCOL = 1;

/** The path on the relay that deployments dial. */
export const RELAY_DEPLOYMENTS_PATH = "/deployments";

/** How often the relay pings and heartbeats — see relay-protocol.ts (#541). */
export const RELAY_HEARTBEAT_MS = 20_000;

/** How long silence lasts before it is darkness — see relay-protocol.ts. */
export const RELAY_DARK_AFTER_MS = 60_000;

/** The receipt outcome for a request whose socket closed first (#506 §8). */
export const RELAY_UNDELIVERED = "undelivered";

/** Every message type on the deployment rail (#540). Mirror of relay-protocol.ts. */
export const RELAY_MESSAGES = {
  challenge: "phoebe:relay:challenge",
  heartbeat: "phoebe:relay:heartbeat",
  configSet: "phoebe:relay:config-set",
  secretSet: "phoebe:relay:secret-set",
  doctorRun: "phoebe:relay:doctor-run",
  hello: "phoebe:relay:hello",
  report: "phoebe:relay:report",
  receipt: "phoebe:relay:receipt",
};

/** The relay's own close codes, in WebSocket's private range. */
export const RELAY_CLOSE = {
  unlinked: 4001,
  protocol: 4002,
  badSignature: 4003,
  tokenSpent: 4004,
  replaced: 4005,
};

/**
 * The relay's HTTP paths (#538). Mirror of `RELAY_ROUTES` in relay-routes.ts;
 * the doc comments live there.
 */
export const RELAY_ROUTES = {
  signIn: "/auth/google/start",
  callback: "/auth/google/callback",
  signOut: "/auth/sign-out",
  me: "/api/me",
  pairingTokens: "/api/pairing-tokens",
  deployments: "/api/deployments",
  forget: "/api/deployments/forget",
  events: "/api/events",
  secrets: "/api/secrets",
};

/**
 * The event-stream names (#542). Mirror of `RELAY_EVENTS` in relay-events.ts;
 * the doc comments live there.
 */
export const RELAY_EVENTS = {
  report: "report",
  connected: "connected",
  disconnected: "disconnected",
  dark: "dark",
};
