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

export { openSecret, sealSecret } from "./secret-envelope.mjs";

/** The `schema` integer `state/deployment.json` carries — see deployment.ts. */
export const DEPLOYMENT_SCHEMA = 1;

/** The effective config's own shape version — see effective-config.ts. */
export const EFFECTIVE_CONFIG_VERSION = 1;
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
  testAlert: "/api/alerts/test",
};

/** The `schema` integer every alert body carries (#515 §9) — see alerts.ts. */
export const ALERT_SCHEMA = 1;

/** How long after the last heartbeat silence becomes an alert (#515 §4). */
export const ALERT_DARK_AFTER_MS = 300_000;

/** The five conditions (#515 §3). Mirror of `ALERT_CONDITIONS` in alerts.ts. */
export const ALERT_CONDITIONS = ["dark", "wedged", "crash-looping", "doctor-fail", "replaced"];
