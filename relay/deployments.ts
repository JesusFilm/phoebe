// `/deployments` — the socket a deployment dials, and the handshake that
// decides whether it is let in (#540, decided in #506 §4–§7).
//
// The relay speaks first. On every connection it sends `challenge` with a fresh
// nonce and its own protocol integer, and then waits for exactly one `hello`.
// That ordering is the whole design: no credential rides on the upgrade
// request, so nothing sensitive reaches a proxy log, and a deployment never has
// to send anything a header could have carried.
//
// A `hello` arrives one of two ways, and the relay treats them very differently:
//
//  - **With a signature.** The relay looks the public key up in `links.json`. No
//    link means no deployment — `unlinked`. A link whose key does not verify the
//    nonce means someone is replaying someone else's hello — `bad-signature`.
//  - **With a pairing token.** The relay spends the token (single use, fifteen
//    minutes, in memory) and records the public key as the link. An unknown,
//    expired or already-spent token is `token-spent`, one word for all three,
//    because saying which would help a guesser.
//
// Refusal is always a close code, never a message: a refused deployment has no
// session to hold the answer in, and a code survives the close that follows it.
//
// The relay is never load-bearing for the work a deployment does. Every failure
// here ends one socket and nothing else — no throw reaches the HTTP server this
// endpoint shares a process with.

import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  RELAY_CLOSE,
  RELAY_DEPLOYMENTS_PATH,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
  relayMessageType,
  relaySpeaks,
  type RelayChallenge,
  type RelayHello,
} from "../src/contracts/relay-protocol.ts";
import { verifyNonceSignature } from "../src/ed25519.ts";
import type { Link, Links, PairingTokens } from "./links.ts";

/**
 * How long a connection may sit between the challenge and its hello. Generous
 * for a deployment on a bad link, far too short to be worth parking sockets on.
 */
export const HELLO_TIMEOUT_MS = 30_000;

/** A deployment that completed the handshake and is holding its socket open. */
export type ConnectedDeployment = {
  link: Link;
  socket: WebSocket;
  since: Date;
};

export type DeploymentGateOptions = {
  /** The HTTP server to take `/deployments` upgrades from. */
  server: Server;
  links: Links;
  tokens: PairingTokens;
  /** Injected so tests do not race a clock. */
  clock?: () => Date;
  /** Injected so a test can assert on the exact nonce it challenged with. */
  nonce?: () => string;
  /** The protocol this relay speaks. */
  protocol?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

export type DeploymentGate = {
  /** Every deployment connected right now, keyed by fingerprint. */
  connected: () => ConnectedDeployment[];
  close: () => Promise<void>;
};

/**
 * Attach the deployment endpoint to a running HTTP server. Returns immediately;
 * everything after is driven by socket events.
 */
export function serveDeployments(options: DeploymentGateOptions): DeploymentGate {
  const clock = options.clock ?? (() => new Date());
  const newNonce = options.nonce ?? (() => randomBytes(24).toString("base64url"));
  const protocol = options.protocol ?? RELAY_PROTOCOL;
  const log = options.log ?? (() => {});
  const warn = options.warn ?? log;

  const wss = new WebSocketServer({ server: options.server, path: RELAY_DEPLOYMENTS_PATH });
  const live = new Map<string, ConnectedDeployment>();

  wss.on("connection", (socket: WebSocket) => {
    const nonce = newNonce();
    let answered = false;

    // A socket that never says hello is a socket holding a file descriptor for
    // nothing. The timer is cleared by the first frame either way.
    const timeout = setTimeout(() => {
      if (answered) return;
      socket.close(1008, "no hello");
    }, HELLO_TIMEOUT_MS);
    // The relay is a long-lived process and this timer must never be the reason
    // it stays alive a moment longer than the socket does.
    timeout.unref?.();

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      if (answered) return;
      answered = true;
      clearTimeout(timeout);
      const verdict = admit(frameText(raw));
      if (verdict.admitted) {
        register(verdict.link, socket);
        return;
      }
      socket.close(verdict.code, verdict.reason);
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      for (const [fingerprint, entry] of live) {
        if (entry.socket === socket) live.delete(fingerprint);
      }
    });

    // An `error` on a `ws` socket is followed by `close`; unhandled, it takes
    // the process with it.
    socket.on("error", (error: Error) => {
      warn(`[phoebe:relay] deployment socket error: ${error.message}`);
    });

    const challenge: RelayChallenge = { type: RELAY_MESSAGES.challenge, nonce, protocol };
    socket.send(JSON.stringify(challenge));

    /** The whole decision, as data, so it is testable without a socket. */
    function admit(
      data: string,
    ): { admitted: true; link: Link } | { admitted: false; code: number; reason: string } {
      const hello = parseHello(data);
      if (hello === null) {
        return { admitted: false, code: 1008, reason: "malformed hello" };
      }
      if (!relaySpeaks(protocol, hello.protocol)) {
        return {
          admitted: false,
          code: RELAY_CLOSE.protocol,
          reason: `relay speaks ${protocol}`,
        };
      }
      const now = clock();
      if (hello.pairingToken !== undefined) {
        const spent = options.tokens.spend(hello.pairingToken, now);
        if (!spent.spent) {
          return { admitted: false, code: RELAY_CLOSE.tokenSpent, reason: "token-spent" };
        }
        const link = options.links.pair(
          { publicKey: hello.publicKey, name: hello.name, by: spent.by },
          now,
        );
        log(
          `[phoebe:relay] paired ${link.name} (${link.fingerprint}) ` +
            `on a token minted by ${spent.by}`,
        );
        return { admitted: true, link };
      }
      const link = options.links.find(hello.publicKey);
      if (link === null) {
        return { admitted: false, code: RELAY_CLOSE.unlinked, reason: "unlinked" };
      }
      if (
        hello.signature === undefined ||
        !verifyNonceSignature(hello.publicKey, nonce, hello.signature)
      ) {
        return { admitted: false, code: RELAY_CLOSE.badSignature, reason: "bad-signature" };
      }
      options.links.seen(hello.publicKey, now);
      return { admitted: true, link: { ...link, lastSeen: now.toISOString() } };
    }
  });

  /**
   * Hold the admitted socket, displacing any older one from the same key. A
   * deployment that reconnects before the relay noticed the old socket died
   * would otherwise appear twice, and the older of the two is the ghost.
   */
  function register(link: Link, socket: WebSocket): void {
    const previous = live.get(link.fingerprint);
    if (previous !== undefined && previous.socket !== socket) {
      previous.socket.close(RELAY_CLOSE.replaced, "replaced");
    }
    live.set(link.fingerprint, { link, socket, since: clock() });
    log(`[phoebe:relay] ${link.name} (${link.fingerprint}) connected`);
  }

  return {
    connected: () => [...live.values()],
    close: () =>
      new Promise<void>((resolve) => {
        for (const entry of live.values()) entry.socket.close(1001, "relay closing");
        live.clear();
        wss.close(() => resolve());
      }),
  };
}

/**
 * One `ws` frame as text. The library hands over a Buffer, a list of them for a
 * fragmented message, or an ArrayBuffer depending on how the frame arrived, and
 * all three are the same JSON to everyone downstream.
 */
function frameText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw instanceof Buffer ? raw : new Uint8Array(raw)).toString("utf8");
}

/**
 * A `hello` with every field the relay reads, or null. Exactly one of
 * `signature` and `pairingToken` may be present: a frame carrying both is a
 * deployment hedging about which identity it is claiming, and the relay does not
 * guess.
 */
export function parseHello(data: string): RelayHello | null {
  let frame: unknown;
  try {
    frame = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (relayMessageType(frame) !== RELAY_MESSAGES.hello) return null;
  const hello = frame as Partial<RelayHello>;
  if (!Number.isInteger(hello.protocol)) return null;
  if (typeof hello.publicKey !== "string" || hello.publicKey.length === 0) return null;
  if (typeof hello.name !== "string" || hello.name.length === 0) return null;
  const signed = typeof hello.signature === "string" && hello.signature.length > 0;
  const pairing = typeof hello.pairingToken === "string" && hello.pairingToken.length > 0;
  if (signed === pairing) return null;
  return {
    type: RELAY_MESSAGES.hello,
    protocol: hello.protocol as number,
    publicKey: hello.publicKey,
    name: hello.name,
    ...(signed ? { signature: hello.signature } : { pairingToken: hello.pairingToken }),
  };
}
