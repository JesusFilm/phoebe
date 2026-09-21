// `/deployments` — the socket a deployment dials, the handshake that decides
// whether it is let in (#540), and what the relay knows about it afterwards
// (#541, decided in #506 §6–§8 and #507 §1).
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
// **After the handshake, the relay keeps talking.** Every twenty seconds each
// connection gets a WebSocket ping and a visible `heartbeat` message. Two
// mechanisms because neither side can do the other's job: the relay counts the
// automatic pong, which is the only liveness a built-in client offers it, and
// the deployment counts the message, because that client cannot see a ping
// arrive. A connection that has answered neither for a minute is terminated
// rather than left in the live map — a half-open socket reported as connected
// is the one lie this file must not tell.
//
// **What arrives on the socket is the report, and the relay does not read it**
// (#542). A deployment pushes its whole report on connect and again whenever
// any section of it moves; the relay lifts the `schema` integer out of the
// envelope, writes the body to `reports/<fingerprint>.json` exactly as it came,
// and announces it on the event stream. It derives nothing from it — not a
// pipeline's state, not a wedged verdict, not a count. That derivation is the
// deployment's, once, so a CLI and a console cannot disagree (#501).
//
// **In flight is not in a queue.** A request to a deployment lives in memory for
// as long as its socket does. The socket closes and every pending request comes
// back `undelivered`; a deployment that is not connected is refused the same
// word up front rather than having the request parked for a reconnect that may
// never come. Nothing is replayed: the operator re-issues, and the
// deployment-side ledgers make a re-issue idempotent (#506 §8).
//
// The relay is never load-bearing for the work a deployment does. Every failure
// here ends one socket and nothing else — no throw reaches the HTTP server this
// endpoint shares a process with.

import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  RELAY_CLOSE,
  RELAY_DARK_AFTER_MS,
  RELAY_DEPLOYMENTS_PATH,
  RELAY_HEARTBEAT_MS,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
  RELAY_UNDELIVERED,
  relayMessageType,
  relaySpeaks,
  type RelayChallenge,
  type RelayHeartbeat,
  type RelayHello,
  type RelayReceipt,
  type RelayReportMessage,
  type RelayRequest,
} from "../src/contracts/relay-protocol.ts";
import type { ConnectionAlertFacts } from "../src/contracts/alerts.ts";
import { RELAY_EVENTS } from "../src/contracts/relay-events.ts";
import type { RelayDeploymentRow, RelayStoredReport } from "../src/contracts/relay-routes.ts";
import { verifyNonceSignature } from "../src/ed25519.ts";
import {
  alertConnections,
  deploymentRows,
  NOTHING_HEARD,
  type ConnectionFacts,
} from "./connection.ts";
import type { RelayEventSink } from "./events.ts";
import type { IncomingReport, Reports } from "./reports.ts";
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
  /** Where a pushed report is written, and read back from after a restart. */
  reports: Reports;
  /** Where a report's arrival and a connection's change are announced. */
  events: RelayEventSink;
  /** Injected so tests do not race a clock. */
  clock?: () => Date;
  /** Injected so a test can assert on the exact nonce it challenged with. */
  nonce?: () => string;
  /** The protocol this relay speaks. */
  protocol?: number;
  /**
   * The ping interval and the silence that means darkness. Parameters only so a
   * test can watch a minute pass in a few milliseconds; in production they are
   * the constants both sides of the rail import, and an operator who tuned them
   * would be making one deployment's idea of "recently" disagree with its
   * relay's.
   */
  heartbeatMs?: number;
  darkAfterMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** Where alert edges are evaluated, when there is anywhere (#515). */
  alerts?: AlertHook;
};

/**
 * What this endpoint tells the alert notifier (#515). Two moments, because
 * silence is an event nobody fires: the notifier sweeps on its own timer for
 * darkness, and this hook is how a connection arriving or leaving gets its
 * clear or its raise now rather than up to one sweep later.
 */
export type AlertHook = {
  /** A connection came or went — re-evaluate this fleet. */
  changed: () => void;
  /** A link is gone: drop its entries, and send no clear (#515 §5). */
  forgotten: (fingerprint: string) => void;
};

export type DeploymentGate = {
  /** Every deployment connected right now. */
  connected: () => ConnectedDeployment[];
  /**
   * Every link this relay knows, each with where the relay holds it —
   * `connected`, `disconnected` with a count of seconds, `dark`, or `unseen`.
   * Derived on every call, because that is the only way it is ever right.
   */
  rows: (now?: Date) => RelayDeploymentRow[];
  /**
   * The same links as {@link DeploymentGate.rows}, in the vocabulary the alert
   * edge rule reads: the silence clock in ms rather than the seconds a console
   * is shown, and no facts the rule has no opinion about.
   */
  alertConnections: (now?: Date) => ConnectionAlertFacts[];
  /**
   * Send one `id`-bearing request and wait for its receipt. Answers
   * `undelivered` — never queues, never throws — when the deployment is not
   * connected, and answers it again for anything still in flight when a socket
   * closes.
   */
  request: (fingerprint: string, message: RelayRequest) => Promise<RelayReceipt>;
  /**
   * **Forget** one deployment: delete the link, then close any live connection
   * with `unlinked`. In that order, so a redial that races the close finds no
   * link to be admitted by.
   */
  forget: (fingerprint: string) => Link | null;
  close: () => Promise<void>;
};

/** One admitted connection, and everything the relay holds for its duration. */
type LiveConnection = {
  link: Link;
  socket: WebSocket;
  since: Date;
  /** Last pong, message or handshake — the input to the dark clock. */
  lastHeard: Date;
  /** The heartbeat timer, cleared with the socket it belongs to. */
  beat: ReturnType<typeof setInterval>;
  /** Requests waiting for a receipt, in the order they were sent. */
  pending: Map<string, (receipt: RelayReceipt) => void>;
};

/**
 * Attach the deployment endpoint to a running HTTP server. Returns immediately;
 * everything after is driven by socket events and one timer per connection.
 */
export function serveDeployments(options: DeploymentGateOptions): DeploymentGate {
  const clock = options.clock ?? (() => new Date());
  const newNonce = options.nonce ?? (() => randomBytes(24).toString("base64url"));
  const protocol = options.protocol ?? RELAY_PROTOCOL;
  const heartbeatMs = options.heartbeatMs ?? RELAY_HEARTBEAT_MS;
  const darkAfterMs = options.darkAfterMs ?? RELAY_DARK_AFTER_MS;
  const log = options.log ?? (() => {});
  const warn = options.warn ?? log;

  const wss = new WebSocketServer({ server: options.server, path: RELAY_DEPLOYMENTS_PATH });
  const live = new Map<string, LiveConnection>();
  /** The dark clock's other input: what this process heard, after it heard it. */
  const heard = new Map<string, Date>();
  const closes = new Map<string, { code: number; reason: string; at: string }>();
  /**
   * The last word the event stream said about each link. An event is emitted
   * when this and the row disagree, and never otherwise — which is what keeps
   * `dark` to one announcement rather than one per sweep (#542).
   */
  const announced = new Map<string, RelayDeploymentRow["state"]>();
  /**
   * When this process started serving. The dark clock counts from the later of
   * this and the last heartbeat, so a restart does not paint the fleet dark
   * (#507 §1).
   */
  const startedAt = clock();

  wss.on("connection", (socket: WebSocket) => {
    const nonce = newNonce();
    let answered = false;
    /** Set once this socket is admitted; the handle everything after hangs off. */
    let entry: LiveConnection | null = null;

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
      if (entry !== null) {
        entry.lastHeard = clock();
        readFrame(entry, frameText(raw));
        return;
      }
      if (answered) return;
      answered = true;
      clearTimeout(timeout);
      const verdict = admit(frameText(raw));
      if (verdict.admitted) {
        entry = register(verdict.link, socket);
        return;
      }
      socket.close(verdict.code, verdict.reason);
    });

    // The pong a built-in WebSocket client sends without being asked. It
    // carries nothing and means everything: the far end is still there.
    socket.on("pong", () => {
      if (entry !== null) entry.lastHeard = clock();
    });

    socket.on("close", (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      if (entry === null) return;
      retire(entry, code, reason.toString("utf8"));
      entry = null;
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
   * Hold the admitted socket, displacing any older one from the same key, and
   * start its heartbeat. A deployment that reconnects before the relay noticed
   * the old socket died would otherwise appear twice, and the older of the two
   * is the ghost.
   */
  function register(link: Link, socket: WebSocket): LiveConnection {
    const previous = live.get(link.fingerprint);
    if (previous !== undefined && previous.socket !== socket) {
      previous.socket.close(RELAY_CLOSE.replaced, "replaced");
    }
    const now = clock();
    const entry: LiveConnection = {
      link,
      socket,
      since: now,
      lastHeard: now,
      beat: heartbeat(() => entry),
      pending: new Map(),
    };
    live.set(link.fingerprint, entry);
    heard.set(link.fingerprint, now);
    log(`[phoebe:relay] ${link.name} (${link.fingerprint}) connected`);
    announce(now);
    // A deployment that has come back clears its dark alert now, not at the
    // next sweep: the operator is most likely reading their phone right now.
    options.alerts?.changed();
    return entry;
  }

  /**
   * One connection's twenty-second timer: ping, heartbeat, and — when three of
   * them have gone unanswered — terminate. Terminating is what keeps `dark` and
   * `connected` from ever being true of the same socket at once.
   *
   * The entry arrives through a thunk because the timer is part of the record it
   * reads.
   */
  function heartbeat(of: () => LiveConnection): ReturnType<typeof setInterval> {
    const beat = setInterval(() => {
      const entry = of();
      const now = clock();
      if (now.getTime() - entry.lastHeard.getTime() >= darkAfterMs) {
        warn(
          `[phoebe:relay] ${entry.link.name} (${entry.link.fingerprint}) has answered ` +
            `nothing for ${Math.round(darkAfterMs / 1000)}s — dropping a half-open socket`,
        );
        entry.socket.terminate();
        return;
      }
      entry.socket.ping();
      const message: RelayHeartbeat = { type: RELAY_MESSAGES.heartbeat };
      entry.socket.send(JSON.stringify(message));
    }, heartbeatMs);
    // A heartbeat must never be the reason this process outlives its work.
    beat.unref?.();
    return beat;
  }

  /** Read one frame from an admitted deployment: a report, or a receipt. */
  function readFrame(entry: LiveConnection, data: string): void {
    const incoming = parseReport(data);
    if (incoming !== null) {
      takeReport(entry, incoming);
      return;
    }
    const receipt = parseReceipt(data);
    if (receipt === null) return;
    const waiting = entry.pending.get(receipt.id);
    if (waiting === undefined) return;
    entry.pending.delete(receipt.id);
    waiting(receipt);
  }

  /**
   * Take delivery of one report: write it over the last one, announce it, and
   * read none of it. A volume that will not take the write is a relay that has
   * lost its reports, not a relay that should drop the connection carrying
   * them — the deployment is supervising a fleet and this is a console.
   */
  function takeReport(entry: LiveConnection, incoming: IncomingReport): void {
    const fingerprint = entry.link.fingerprint;
    let stored: RelayStoredReport | null;
    try {
      stored = options.reports.save(fingerprint, incoming, clock());
    } catch (error) {
      warn(
        `[phoebe:relay] could not store the report from ${entry.link.name} (${fingerprint}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (stored === null) return;
    options.events.emit({
      type: RELAY_EVENTS.report,
      at: stored.receivedAt,
      fingerprint,
      schema: stored.schema,
      report: stored.report,
    });
  }

  /**
   * Say on the event stream what has changed about who is connected, and
   * nothing that has not. Called at both ends of a connection and on a timer,
   * because two of the three changes are things that happen — a handshake, a
   * close — and the third, **dark**, is a threshold nothing crosses out loud.
   *
   * `unseen` is never announced. It is where every link starts, so there is no
   * moment at which a deployment *became* unseen for a console to act on.
   */
  function announce(now: Date = clock()): void {
    for (const row of rowsAt(now)) {
      if (announced.get(row.fingerprint) === row.state) continue;
      announced.set(row.fingerprint, row.state);
      if (row.state === "unseen") continue;
      options.events.emit({ type: row.state, at: now.toISOString(), deployment: row });
    }
  }

  /** Every link as a console reads it, at one moment. */
  function rowsAt(now: Date): RelayDeploymentRow[] {
    return deploymentRows({
      links: options.links.all(),
      facts: factsOf,
      relayStartedAt: startedAt,
      now,
      darkAfterMs,
    });
  }

  /**
   * A connection is over: stop its heartbeat, settle everything it was carrying
   * as `undelivered`, and leave behind the two facts a console reads afterwards
   * — when the relay last heard from it, and how it ended.
   */
  function retire(entry: LiveConnection, code: number, reason: string): void {
    clearInterval(entry.beat);
    const fingerprint = entry.link.fingerprint;
    if (live.get(fingerprint) === entry) live.delete(fingerprint);
    heard.set(fingerprint, entry.lastHeard);
    closes.set(fingerprint, { code, reason, at: clock().toISOString() });
    const orphaned = [...entry.pending.entries()];
    entry.pending.clear();
    for (const [id, waiting] of orphaned) waiting(undelivered(id));
    if (orphaned.length > 0) {
      log(
        `[phoebe:relay] ${entry.link.name} (${fingerprint}) closed with ` +
          `${orphaned.length} request(s) in flight — undelivered`,
      );
    }
    announce();
    options.alerts?.changed();
  }

  /** The connection facts one link's row is built from. */
  function factsOf(link: Link): ConnectionFacts {
    const entry = live.get(link.fingerprint);
    return {
      ...NOTHING_HEARD,
      ...(entry !== undefined ? { connectedSince: entry.since } : {}),
      lastHeard: entry?.lastHeard ?? heard.get(link.fingerprint) ?? null,
      lastClose: closes.get(link.fingerprint) ?? null,
    };
  }

  /**
   * The sweep that notices darkness. Nothing happens when a deployment goes
   * dark — that is what darkness is — so the one way the stream can carry it is
   * to look on a timer. One timer for the whole relay, on the heartbeat's
   * cadence, which bounds how late the word can be by one beat.
   */
  const watch = setInterval(() => announce(), heartbeatMs);
  // A sweep must never be the reason this process outlives its work.
  watch.unref?.();

  return {
    connected: () => [...live.values()].map(({ link, socket, since }) => ({ link, socket, since })),

    rows: (now = clock()) => rowsAt(now),

    alertConnections: (now = clock()) =>
      alertConnections({
        links: options.links.all(),
        facts: factsOf,
        relayStartedAt: startedAt,
        now,
        darkAfterMs,
      }),

    request(fingerprint, message) {
      const entry = live.get(fingerprint);
      if (entry === undefined) return Promise.resolve(undelivered(message.id));
      return new Promise<RelayReceipt>((resolve) => {
        entry.pending.set(message.id, resolve);
        try {
          entry.socket.send(JSON.stringify(message));
        } catch (error) {
          // A send onto a socket that died between the lookup and here is the
          // same event as a close, and gets the same word.
          warn(
            `[phoebe:relay] could not reach ${entry.link.name} (${fingerprint}): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          entry.pending.delete(message.id);
          resolve(undelivered(message.id));
        }
      });
    },

    forget(fingerprint) {
      const link = options.links.forget(fingerprint);
      if (link === null) return null;
      live.get(fingerprint)?.socket.close(RELAY_CLOSE.unlinked, "unlinked");
      // The report goes with the link. A file left behind would be a report
      // from a deployment the relay no longer knows, ready to reappear under a
      // deployment that pairs the same key again.
      options.reports.forget(fingerprint);
      announced.delete(fingerprint);
      // Forgetting is the mute for a dead key (#515 §8): the entries go, and
      // nothing is sent — a clear for a deployment nobody is watching any more
      // would be the relay talking about a link it no longer has.
      options.alerts?.forgotten(fingerprint);
      log(`[phoebe:relay] forgot ${link.name} (${fingerprint})`);
      return link;
    },

    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(watch);
        for (const entry of live.values()) {
          clearInterval(entry.beat);
          entry.socket.close(1001, "relay closing");
        }
        live.clear();
        wss.close(() => resolve());
      }),
  };
}

/** The receipt the relay writes when the deployment never wrote one (#506 §8). */
function undelivered(id: string): RelayReceipt {
  return { type: RELAY_MESSAGES.receipt, id, outcome: RELAY_UNDELIVERED };
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

/**
 * A `receipt` with an id and an outcome, or null. `detail` is carried through
 * unread: what a verb has to say beyond its outcome is between that verb and
 * the console, and the relay forwarding it opaque is what lets a console one
 * version ahead read fields this relay has never heard of.
 */
export function parseReceipt(data: string): RelayReceipt | null {
  let frame: unknown;
  try {
    frame = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (relayMessageType(frame) !== RELAY_MESSAGES.receipt) return null;
  const receipt = frame as Partial<RelayReceipt>;
  if (typeof receipt.id !== "string" || receipt.id.length === 0) return null;
  if (typeof receipt.outcome !== "string" || receipt.outcome.length === 0) return null;
  return {
    type: RELAY_MESSAGES.receipt,
    id: receipt.id,
    outcome: receipt.outcome,
    ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
  };
}

/**
 * A `report` message, read exactly as far as the relay needs it and no further
 * (#542). Two checks and both are about the envelope: the `schema` integer the
 * relay hoists so a reader can branch on it, and that the body is an object at
 * all rather than a string or a number somebody sent.
 *
 * What is inside the body is not this function's business and not the relay's.
 * A relay that validated the report's sections would be a relay that refuses
 * the day a deployment adds one — the opposite of the rule that a relay stores
 * and forwards the body opaque.
 */
export function parseReport(data: string): IncomingReport | null {
  let frame: unknown;
  try {
    frame = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (relayMessageType(frame) !== RELAY_MESSAGES.report) return null;
  const message = frame as Partial<RelayReportMessage>;
  if (!Number.isInteger(message.schema)) return null;
  if (typeof message.report !== "object" || message.report === null) return null;
  return { schema: message.schema as number, report: message.report };
}
