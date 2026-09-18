// The deployment's half of the relay rail (#540, decided in #505 and #506).
//
// The deployment dials **out** and holds the connection open. Nothing dials in:
// the container publishes no port, and that is what lets it run behind any NAT
// with no inbound attack surface. The transport is a WebSocket over TLS on 443,
// through Node's built-in `WebSocket` client — stable since 22.4, no flag, no
// dependency (docs/research/outbound-relay-transport.md).
//
// **The relay opens; the deployment answers.** A dial that succeeds sends
// nothing and waits for `challenge`. The answer is a `hello` carrying the
// public key and either a signature over the challenge nonce (already paired)
// or the pairing token (not yet). Nothing rides on the upgrade request itself,
// which keeps the token out of every proxy log on the way and sidesteps the
// header support Node's client has never documented.
//
// **A refusal is a close code, and half of them are terminal.** `unlinked`,
// `bad-signature` and `token-spent` all mean *a human has to do something*, so
// the link stops dialling and says so through the report; retrying them on a
// timer is a deployment knocking on a door that will not open until someone
// edits a file. `protocol` retries slowly, because the fix is upgrading the
// relay and that may be happening right now. Everything else — a dropped
// socket, a relay restart, a network that came back — is the ordinary case and
// backs off with jitter.
//
// **Nothing here is load-bearing for work.** A deployment with no relay, an
// unreachable relay, or a refused link supervises its fleet exactly as it
// always did. The link reports where it stands and never throws into the
// supervisor.

import {
  RELAY_CLOSE,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
  relayMessageType,
  relaySpeaks,
  type RelayChallenge,
  type RelayHello,
} from "../src/contracts/relay-protocol.ts";
import type { RelayClose, RelayState } from "../src/contracts/deployment.ts";
import type { RelayStatus } from "./deployment-state.ts";
import type { DeploymentKey } from "./relay-key.ts";

/**
 * The reconnect ladder, in ms. The last entry repeats forever: a relay that has
 * been down for an hour is a relay worth checking once a minute, not one worth
 * giving up on — the deployment is the side with nothing better to do.
 */
export const RECONNECT_SCHEDULE_MS: readonly number[] = [
  1_000, 2_000, 5_000, 15_000, 30_000, 60_000,
];

/**
 * How long a `protocol` refusal waits. Long, and fixed: the fix is an operator
 * upgrading the relay, and the retry exists so that when they do, the fleet
 * comes back on its own rather than needing a restart each.
 */
export const PROTOCOL_RETRY_MS = 5 * 60_000;

/**
 * The delay before attempt `attempt` (0-based), jittered. Full jitter over the
 * ladder's entry rather than the entry itself: a relay that restarts with fifty
 * deployments against it gets them back spread over the window instead of in
 * one thundering reconnect (RFC 6455 §7.2.3).
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 0), RECONNECT_SCHEDULE_MS.length - 1);
  const ceiling = RECONNECT_SCHEDULE_MS[index]!;
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** The close codes a deployment must not retry, and what each one means. */
const TERMINAL_CLOSES: ReadonlyMap<number, string> = new Map([
  [
    RELAY_CLOSE.unlinked,
    "the relay has forgotten this deployment — pair again with a fresh token, or drop `relay` from the config",
  ],
  [
    RELAY_CLOSE.badSignature,
    "the relay holds a different key for this deployment — the volume's key and the link disagree",
  ],
  [
    RELAY_CLOSE.tokenSpent,
    "the pairing token is unknown, expired or already spent — mint a new one and set PHOEBE_RELAY_TOKEN",
  ],
  [
    RELAY_CLOSE.replaced,
    "a newer connection from this key superseded it — another process is dialling with the same volume",
  ],
]);

/** The socket this module drives, narrowed to what it uses. Injected in tests. */
export type RelaySocketHandlers = {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (code: number, reason: string) => void;
};

export type RelaySocket = {
  send: (data: string) => void;
  close: () => void;
};

/** Dial one socket. The default reaches Node's built-in `WebSocket`. */
export type OpenRelaySocket = (url: string, handlers: RelaySocketHandlers) => RelaySocket;

export type RelayLinkDeps = {
  /** `relay.url` — where to dial. */
  url: string;
  /** `relay.name`, or the default this deployment answers to. */
  name: string;
  /**
   * The key on the volume, or null when this deployment has never paired. Null
   * with a token is a pairing; null without one is a deployment that cannot
   * dial at all.
   */
  key: DeploymentKey | null;
  /**
   * `PHOEBE_RELAY_TOKEN`, if the operator set it. Read from the environment,
   * held in memory for exactly as long as this link runs, and never written to
   * the volume. Ignored outright when a key is already on disk.
   */
  pairingToken?: string | undefined;
  /** Mint a key and hand back the pair. Called once, and only for a pairing. */
  mintKey: () => DeploymentKey;
  /** Persist a freshly minted key, as it is presented. */
  saveKey: (key: DeploymentKey) => void;
  /**
   * Take a just-minted key back off the volume. Called when the relay refuses
   * the pairing that minted it — a key nothing will accept is worse than none,
   * because the next boot would sign with it instead of pairing again.
   */
  forgetKey: () => void;
  /** Where the link's state goes: straight into the report's relay section. */
  onStatus: (status: RelayStatus) => void;
  /** The deployment key's fingerprint, once there is one to report. */
  onPaired?: (key: DeploymentKey) => void;
  /** Operator-facing lines. Defaults to stdout through the caller. */
  log?: (message: string) => void;
  warn?: (message: string) => void;
  open?: OpenRelaySocket;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  protocol?: number;
  random?: () => number;
};

export type RelayLink = {
  /** Stop dialling and close any open socket. The deployment is going down. */
  stop: () => void;
};

/**
 * Open the link and keep it open. Returns immediately: the first dial is
 * already in flight, and everything after it is driven by socket events and one
 * timer.
 */
export function connectRelay(deps: RelayLinkDeps): RelayLink {
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? log;
  const open = deps.open ?? openNodeWebSocket;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as never));
  const protocol = deps.protocol ?? RELAY_PROTOCOL;
  const random = deps.random ?? Math.random;

  let key = deps.key;
  /** Unspent, in memory, gone the moment it is spent. */
  let token = key === null ? deps.pairingToken : undefined;
  let socket: RelaySocket | null = null;
  /** Was the key on this connection minted here, rather than read off the volume? */
  let mintedHere = false;
  let timer: unknown = null;
  let attempt = 0;
  let stopped = false;
  let lastClose: RelayClose | null = null;

  if (key !== null && deps.pairingToken !== undefined) {
    log(
      "[phoebe] relay: a deployment key is already on the volume — PHOEBE_RELAY_TOKEN is ignored. " +
        "Remove it from the root `.env`; `phoebe doctor` will keep saying so until you do.",
    );
  }

  const report = (state: RelayState, nextRetryAt: string | null): void => {
    deps.onStatus({ configured: true, state, nextRetryAt, lastClose });
  };

  /** Stop for good, with the reason an operator can act on. */
  const halt = (reason: string): void => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    warn(`[phoebe] relay: not dialling — ${reason}`);
    report("unpaired", null);
  };

  if (key === null && token === undefined) {
    halt(
      "`relay.url` is set but this deployment has no key on its volume and no PHOEBE_RELAY_TOKEN " +
        "in its environment. Mint a pairing token on the relay and set it in the root `.env`.",
    );
    return { stop: () => {} };
  }

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    report("reconnecting", new Date(now() + delayMs).toISOString());
    timer = setTimer(() => {
      timer = null;
      dial();
    }, delayMs);
  };

  function dial(): void {
    if (stopped) return;
    let answered = false;
    const current = open(deps.url, {
      onOpen: () => {
        // Deliberately silent: the relay speaks first, and a deployment that
        // announced itself before the challenge would be telling a stranger its
        // public key for nothing.
      },

      onMessage: (data) => {
        const frame = parseFrame(data);
        if (relayMessageType(frame) !== RELAY_MESSAGES.challenge) return;
        if (answered) return;
        answered = true;
        const challenge = frame as RelayChallenge;
        if (!relaySpeaks(challenge.protocol, protocol)) {
          // The relay will refuse with `protocol` anyway; saying it here is what
          // turns a close code into the sentence "upgrade the relay first".
          warn(
            `[phoebe] relay: the relay speaks protocol ${challenge.protocol} and this ` +
              `deployment speaks ${protocol}. Upgrade the relay first; retrying in ` +
              `${Math.round(PROTOCOL_RETRY_MS / 60_000)} minutes.`,
          );
        }
        const paired = key !== null;
        if (key === null) {
          key = deps.mintKey();
          mintedHere = true;
          deps.onPaired?.(key);
        }
        const hello: RelayHello = {
          type: RELAY_MESSAGES.hello,
          protocol,
          publicKey: key.publicKey,
          name: deps.name,
          ...(paired ? { signature: key.sign(challenge.nonce) } : { pairingToken: token ?? "" }),
        };
        current.send(JSON.stringify(hello));
        if (!paired) {
          // The token is spent whatever the relay decides; a second attempt
          // with it would be refused and would keep a live credential in memory
          // for no reason.
          token = undefined;
          deps.saveKey(key);
          log(
            `[phoebe] relay: paired with ${deps.url} as ${deps.name} ` +
              `(key ${key.fingerprint}). Remove PHOEBE_RELAY_TOKEN from the root \`.env\`.`,
          );
        }
        // Acceptance is silence: a refusal arrives as a close code within the
        // moment, and the report follows it down.
        attempt = 0;
        report("connected", null);
      },

      onClose: (code, reason) => {
        if (socket === current) socket = null;
        lastClose = { code, reason, at: new Date(now()).toISOString() };
        const terminal = TERMINAL_CLOSES.get(code);
        if (terminal !== undefined) {
          if (mintedHere) {
            // The pairing this key was minted for was refused. Leaving it on the
            // volume would turn one mistyped token into a deployment that signs
            // with an identity the relay has never heard of, forever.
            deps.forgetKey();
            key = null;
          }
          halt(`${terminal} (close ${code}${reason ? `: ${reason}` : ""})`);
          return;
        }
        mintedHere = false;
        if (code === RELAY_CLOSE.protocol) {
          schedule(PROTOCOL_RETRY_MS);
          return;
        }
        schedule(reconnectDelayMs(attempt++, random));
      },
    });
    socket = current;
  }

  report("reconnecting", new Date(now()).toISOString());
  dial();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      socket?.close();
      socket = null;
    },
  };
}

/** A frame, or null for anything that is not JSON. Never throws at the caller. */
function parseFrame(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

/**
 * The default socket: Node's built-in `WebSocket`. An `error` event is always
 * followed by `close`, so the close handler is the one place a failed dial and
 * a dropped connection are treated the same — which is what they are.
 */
const openNodeWebSocket: OpenRelaySocket = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") handlers.onMessage(event.data);
  });
  socket.addEventListener("close", (event: CloseEvent) =>
    handlers.onClose(event.code, event.reason),
  );
  // Unhandled, an `error` event on a WebSocket is an unhandled rejection in
  // waiting. The close that follows carries everything the link acts on.
  socket.addEventListener("error", () => {});
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
};
