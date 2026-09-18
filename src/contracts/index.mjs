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

/** The effective config's own shape version — see effective-config.ts. */
export const EFFECTIVE_CONFIG_VERSION = 1;

/** The console API version the relay publishes — see console-protocol.ts (#525 §4). */
export const CONSOLE_PROTOCOL = 1;

/** The wire version both ends exchange in the handshake — see relay-protocol.ts. */
export const RELAY_PROTOCOL = 1;

/** The path on the relay that deployments dial. */
export const RELAY_DEPLOYMENTS_PATH = "/deployments";

/** How often the relay pings and heartbeats — see relay-protocol.ts (#541). */
export const RELAY_HEARTBEAT_MS = 20_000;

/** How long silence lasts before it is darkness — see relay-protocol.ts. */
export const RELAY_DARK_AFTER_MS = 60_000;

/** The global the companion's preload exposes its bridge on — see desktop-bridge.ts. */
export const DESKTOP_BRIDGE_GLOBAL = "phoebe";

/** How many lines of a verb run main keeps — see verb-run.ts (#527 §13). */
export const MAX_RUN_LINES = 2000;

/** The verbs a companion can cancel — see verb-run.ts (#527 §2). */
export const CANCELLABLE_VERBS = ["start", "stop"];
/** Where a companion's sign-in lands — see relay-routes.ts (#554). */
export const COMPANION_AUTH_URL = "phoebe://auth";

/** How long a companion has to spend its one-time code — see relay-routes.ts. */
export const DEVICE_CODE_TTL_MS = 60_000;

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
  version: "/api/version",
  signIn: "/auth/google/start",
  callback: "/auth/google/callback",
  signOut: "/auth/sign-out",
  deviceStart: "/auth/device/start",
  deviceExchange: "/auth/device/exchange",
  deviceRevoke: "/auth/device/revoke",
  me: "/api/me",
  pairingTokens: "/api/pairing-tokens",
  devices: "/api/devices",
  deviceRemove: "/api/devices/remove",
  deployments: "/api/deployments",
  forget: "/api/deployments/forget",
  configSet: "/api/deployments/config-set",
  events: "/api/events",
  secrets: "/api/secrets",
  testAlert: "/api/alerts/test",
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
  alert: "alert",
};

/**
 * The config-edit closed set (#503). Mirror of `CLOSED_EDIT_BLOCKS` in
 * config-edit.ts; the doc comments live there.
 */
export const CLOSED_EDIT_BLOCKS = [
  {
    prefix: "workspace",
    why: "the fleet declaration is yours — adding, removing or reordering tenants is a git edit, never a console one",
  },
  {
    prefix: "engine",
    why: "`engine.ref` picks which engine runs and moves with `phoebe upgrade`, so the migrations for the new ref run with it",
  },
  {
    prefix: "relay",
    why: "the relay block is the pairing's own, written when a deployment is paired rather than edited field by field",
  },
  {
    prefix: "deployment",
    why: "the `deployment` block holds the host's lifecycle commands, which run outside the container and are not the container's to rewrite",
  },
  {
    prefix: "paths",
    why: "`paths` is derived from `repoSlug` and the data volume; nothing at that path is read from the file",
  },
  {
    prefix: "workKinds",
    why: "top-level `workKinds` is the permanent alias for `pipelines.work.kinds` — set it at the path the effective config prints",
  },
];

/** The `schema` integer every alert body carries (#515 §9) — see alerts.ts. */
export const ALERT_SCHEMA = 1;

/** How long after the last heartbeat silence becomes an alert (#515 §4). */
export const ALERT_DARK_AFTER_MS = 300_000;

/** The five conditions (#515 §3). Mirror of `ALERT_CONDITIONS` in alerts.ts. */
export const ALERT_CONDITIONS = ["dark", "wedged", "crash-looping", "doctor-fail", "replaced"];
