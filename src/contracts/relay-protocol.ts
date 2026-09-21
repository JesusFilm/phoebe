// The wire between a deployment and its relay (#540, decided in #506 §4–§7).
//
// Every message is JSON with a `phoebe:relay:`-prefixed `type`. Anything that
// wants an answer carries an `id` and is answered by a `receipt` bearing the
// same one — the `phoebe:slot:` rail's shape (src/slot-client.ts), one layer
// out. Nothing here reaches a socket: these are the declarations both ends
// import so neither can invent a field the other does not read.
//
// **The handshake is the relay's opening move.** The deployment dials, says
// nothing, and waits: the relay sends `challenge` with a nonce and its own
// `protocol`, and the deployment answers `hello` with its public key and either
// a signature over that nonce (it is already paired) or a pairing token (it is
// not). Nothing rides on the upgrade request — no headers, no query string —
// which keeps the token out of every proxy log between here and there and
// sidesteps Node's built-in `WebSocket` client, whose header support the
// transport research could not confirm.
//
// **One integer, and the relay is the newer side.** `protocol` is not the
// package version: it moves when the wire changes and stays put through every
// release that does not touch it. A relay speaks every protocol up to its own
// and refuses anything above — so the rule an operator has to remember is
// *upgrade the relay first*.

/**
 * The protocol this engine speaks. Bump when a message's meaning changes in a
 * way the other side would misread; adding an optional field does not move it.
 */
export const RELAY_PROTOCOL = 1;

/** The path on the relay that deployments dial. */
export const RELAY_DEPLOYMENTS_PATH = "/deployments";

/**
 * How often the relay pings (#506 §7, #541). Twenty seconds, a constant on both
 * sides rather than configuration: an operator who tuned it would be making one
 * deployment's idea of "recently" disagree with its relay's.
 *
 * Each tick is a WebSocket ping *and* a visible `heartbeat` message. The ping is
 * what the relay counts — Node's built-in client auto-pongs and cannot be asked
 * to ping — and the message is what the deployment counts, because that same
 * client cannot see a ping arrive.
 */
export const RELAY_HEARTBEAT_MS = 20_000;

/**
 * How long silence lasts before it means something. Three missed heartbeats,
 * and one number for both sides of the rail:
 *
 *  - The relay calls a deployment **dark** after this long unheard, however the
 *    connection ended, and terminates a socket that has gone quiet for it
 *    rather than reporting a half-open connection as connected.
 *  - The deployment redials after this long with nothing inbound, which is the
 *    only way it notices a connection that died without a close frame.
 *
 * Before it passes, the relay's word is **disconnected for N seconds** — a fact
 * a console states, not a fourth state (#507 §1).
 */
export const RELAY_DARK_AFTER_MS = 60_000;

/**
 * The receipt outcome the relay writes itself when a request's deployment went
 * away before answering (#506 §8). In-flight requests are refused, never
 * queued: nothing is replayed on reconnect, the operator re-issues, and the
 * deployment-side ledgers make a re-issue idempotent.
 */
export const RELAY_UNDELIVERED = "undelivered";

/**
 * Every message type on the rail, as one closed record. `as const` so a typo in
 * a sender is a type error rather than a message the far side silently drops.
 */
export const RELAY_MESSAGES = {
  /** relay → deployment: the opening move, `{ nonce, protocol }`. */
  challenge: "phoebe:relay:challenge",
  /** relay → deployment: liveness the deployment can see, `{}`. */
  heartbeat: "phoebe:relay:heartbeat",
  /** relay → deployment: write one config field. */
  configSet: "phoebe:relay:config-set",
  /** relay → deployment: store one secret from its sealed envelope. */
  secretSet: "phoebe:relay:secret-set",
  /** relay → deployment: run doctor now and report what it found. */
  doctorRun: "phoebe:relay:doctor-run",
  /** deployment → relay: the answer to a challenge. */
  hello: "phoebe:relay:hello",
  /** deployment → relay: the deployment report, schema and all. */
  report: "phoebe:relay:report",
  /** deployment → relay: the outcome of one `id`-bearing request. */
  receipt: "phoebe:relay:receipt",
} as const;

/** One message type. */
export type RelayMessageType = (typeof RELAY_MESSAGES)[keyof typeof RELAY_MESSAGES];

/**
 * The close codes the relay owns, in the private range WebSocket reserves for
 * applications (4000–4999). A code, not a message, because a refusal has to
 * survive a socket the relay is closing anyway.
 *
 * What the deployment does with each is its own decision and not the relay's:
 * three of them mean *stop dialling and wait for a human*, and retrying them on
 * a timer would be a deployment hammering a door that will not open.
 */
export const RELAY_CLOSE = {
  /** The link was forgotten on the relay. Stop; wait for a config change. */
  unlinked: 4001,
  /** The deployment speaks a protocol above the relay's. Retry on reconcile. */
  protocol: 4002,
  /** The signature did not verify against the recorded key. Stop. */
  badSignature: 4003,
  /** The pairing token is unknown, expired, or already spent. Stop. */
  tokenSpent: 4004,
  /** A newer connection from the same key superseded this one. No retry. */
  replaced: 4005,
} as const;

/** One of the relay's close codes. */
export type RelayCloseCode = (typeof RELAY_CLOSE)[keyof typeof RELAY_CLOSE];

/**
 * Does a relay speaking `relayProtocol` admit a deployment speaking
 * `deploymentProtocol`? The whole of the version rule, in one place both sides
 * import so neither can get the inequality backwards.
 */
export function relaySpeaks(relayProtocol: number, deploymentProtocol: number): boolean {
  return relayProtocol >= deploymentProtocol;
}

/** relay → deployment. The first thing on every connection. */
export type RelayChallenge = {
  type: typeof RELAY_MESSAGES.challenge;
  /** Random, single-use, base64url. What a paired deployment signs. */
  nonce: string;
  /** The relay's own protocol integer. */
  protocol: number;
};

/**
 * deployment → relay. Exactly one of `signature` and `pairingToken` is present:
 * a deployment with a key on its volume signs, a deployment without one spends
 * the token the operator minted. Sending both is a malformed hello.
 */
export type RelayHello = {
  type: typeof RELAY_MESSAGES.hello;
  /** The protocol the deployment speaks. */
  protocol: number;
  /** The deployment key's public half — raw Ed25519, base64url. */
  publicKey: string;
  /** What a console shows for this deployment. The relay never keys on it. */
  name: string;
  /** Base64url signature over the challenge nonce. */
  signature?: string;
  /** The single-use pairing token, on a first connection only. */
  pairingToken?: string;
};

/** relay → deployment, on the relay's ping timer. Carries nothing. */
export type RelayHeartbeat = { type: typeof RELAY_MESSAGES.heartbeat };

/** relay → deployment: one field of the root config, written by a person. */
export type RelayConfigSet = {
  type: typeof RELAY_MESSAGES.configSet;
  id: string;
  /** Dotted path into the config, e.g. `pipelines.work.pollIntervalMs`. */
  path: string;
  value: unknown;
  /** The config fingerprint the edit was composed against. */
  fingerprint: string;
  /** The signed-in address that asked for it — the edit ledger's actor. */
  by: string;
};

/** relay → deployment: one secret, sealed to this deployment. */
export type RelaySecretSet = {
  type: typeof RELAY_MESSAGES.secretSet;
  id: string;
  key: string;
  /** Opaque to the relay: the browser sealed it, the deployment opens it. */
  envelope: string;
  by: string;
};

/** relay → deployment: run doctor and answer with what it said. */
export type RelayDoctorRun = {
  type: typeof RELAY_MESSAGES.doctorRun;
  id: string;
  by: string;
};

/**
 * deployment → relay: the deployment report, carried verbatim. The relay stores
 * and forwards the body without reading it, so a console one version ahead
 * renders fields this relay has never heard of.
 */
export type RelayReportMessage = {
  type: typeof RELAY_MESSAGES.report;
  /** The report's own `schema` integer, hoisted so a reader can branch on it. */
  schema: number;
  report: unknown;
};

/** deployment → relay: what became of one `id`-bearing request. */
export type RelayReceipt = {
  type: typeof RELAY_MESSAGES.receipt;
  id: string;
  /** The verb's own word — `written`, `refused`, and so on per request. */
  outcome: string;
  /** Whatever that verb has to say beyond its outcome. */
  detail?: unknown;
};

/** Everything the relay may send. */
export type RelayToDeployment =
  | RelayChallenge
  | RelayHeartbeat
  | RelayConfigSet
  | RelaySecretSet
  | RelayDoctorRun;

/**
 * The relay's messages that want an answer — the ones carrying an `id` and
 * waiting for a `receipt` under it. Anything in this union can come back
 * {@link RELAY_UNDELIVERED} instead, because the socket is allowed to close
 * mid-flight and the console is not left waiting when it does.
 */
export type RelayRequest = RelayConfigSet | RelaySecretSet | RelayDoctorRun;

/** Everything a deployment may send. */
export type DeploymentToRelay = RelayHello | RelayReportMessage | RelayReceipt;

/**
 * Read one frame's `type` without trusting any of it. Parsing is the receiving
 * side's job either way; this is the guard that makes the union usable, and it
 * lives here so both ends reject the same garbage.
 */
export function relayMessageType(frame: unknown): RelayMessageType | null {
  if (typeof frame !== "object" || frame === null) return null;
  const { type } = frame as { type?: unknown };
  if (typeof type !== "string") return null;
  const known = Object.values(RELAY_MESSAGES) as string[];
  return known.includes(type) ? (type as RelayMessageType) : null;
}
