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
// **A refusal is a close code, and there is one rule per code** (#506 §7):
//
//  - `unlinked` (4001) — the relay forgot this deployment. Stop dialling; a
//    human has to pair it again or drop `relay` from the config.
//  - `protocol` (4002) — retry slowly. The fix is an operator upgrading the
//    relay, and that may be happening right now.
//  - `bad-signature` (4003) — stop. The key on the volume and the link disagree,
//    and no amount of retrying reconciles them.
//  - `token-spent` (4004) — stop. Mint another token.
//  - `replaced` (4005) — stop. Another process is dialling with this volume's
//    key, and two of them fighting over one link is worse than one of them
//    losing.
//
// Everything else — a dropped socket, a relay restart, a network that came back
// — is the ordinary case: back off with jitter and dial again, forever.
//
// **Silence is the third way a connection ends.** The relay pings and sends a
// visible `heartbeat` every twenty seconds; a minute with nothing inbound means
// the socket died without a close frame, and the link redials rather than
// holding a connection to a wall. That minute is the relay's dark threshold, on
// purpose: both sides give up on a connection at the same moment, so a console
// and a deployment never disagree about whether one exists.
//
// **The report goes up whole, on connect and on change** (#542, decided in
// #501). The link does not keep a copy: it reads `state/deployment.json`'s live
// model at the moment it sends, so what the relay receives is what the file
// says and never a stale duplicate of it. A push while the socket is down is
// dropped rather than queued — the next connection opens with the whole report
// anyway, and a queue would only deliver an older version of the same truth.
//
// Between reports the relay counts pongs, not messages: a deployment whose
// fleet is quiet sends nothing for hours, and that is not silence — it is a
// deployment with nothing to say (#541).
//
// **What comes the other way is a request, and it is answered at once** (#546).
// `doctor-run` is the first of them: the link asks the supervisor's doctor
// runner for a run and answers the receipt with which run the ask belongs to —
// started, joined, or refused. Not with what doctor found. A run takes up to
// five minutes and the answer to "did my press do anything" cannot, so the
// finding arrives the way every finding does, as the next report.
//
// `config-set` is the second (#503, #547): the link hands the patch to the
// bootstrapper's config-edit pen and sends that pen's receipt straight back,
// `written` or `refused`. It authors nothing — not the refusal, not the manual
// edit that rides with one. A receipt goes out for every ask, including the ones
// that went wrong here, because `undelivered` for an edit that was refused for a
// reason would send an operator looking for a network fault.
//
// **Nothing here is load-bearing for work.** A deployment with no relay, an
// unreachable relay, or a refused link supervises its fleet exactly as it
// always did. The link reports where it stands and never throws into the
// supervisor.

import {
  RELAY_CLOSE,
  RELAY_DARK_AFTER_MS,
  RELAY_DOCTOR_RUN,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
  relayMessageType,
  relaySpeaks,
  type RelayChallenge,
  type RelayConfigSet,
  type RelayDoctorRun,
  type RelayHello,
  type RelayMessageType,
  type RelayReceipt,
  type RelayReportMessage,
} from "../src/contracts/relay-protocol.ts";
import { jitteredBackoffMs } from "../src/backoff.ts";
import { instructionFor } from "../src/config-edit.ts";
import { TENANT_CONFIG_FILE as ROOT_CONFIG_FILE } from "./tenants.ts";
import type { ConfigEdit, EditReceipt } from "../src/contracts/config-edit.ts";
import type { DeploymentReport, RelayClose, RelayState } from "../src/contracts/deployment.ts";
import type { RelayStatus } from "./deployment-state.ts";
import type { DeploymentKey } from "./relay-key.ts";

/**
 * The first rung of the reconnect ladder. The retry after a close lands
 * uniformly inside five seconds, so a relay restart or a blip is back long
 * before the minute that would make this deployment dark (#507 §1).
 */
export const RECONNECT_FIRST_MS = 5_000;

/**
 * The ladder's top rung, and it repeats forever. Thirty seconds rather than a
 * minute because the dark threshold *is* a minute: a ceiling above it would
 * leave a deployment dark between knocks even after the relay came back. And
 * there is no last attempt — a relay down for an hour is worth a knock every
 * half-minute, and the deployment is the side with nothing better to do.
 */
export const RECONNECT_CAP_MS = 30_000;

/**
 * How long a `protocol` refusal waits. Long, and fixed: the fix is an operator
 * upgrading the relay, and the retry exists so that when they do, the fleet
 * comes back on its own rather than needing a restart each.
 */
export const PROTOCOL_RETRY_MS = 5 * 60_000;

/**
 * The delay before retry `attempt` (0-based) — the engine's own backoff rule
 * (`src/backoff.ts`), asked for the async, jittered, never-terminal reading of
 * itself.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  return jitteredBackoffMs(attempt, {
    firstMs: RECONNECT_FIRST_MS,
    capMs: RECONNECT_CAP_MS,
    random,
  });
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

/** Which of the link's two timers is being set. */
export type RelayTimer = "retry" | "silence";

/**
 * What the deployment answers a `doctor-run` with (#546): which run the ask
 * belongs to, and a sentence when that is `refused`. The words are the rail's
 * own (`RELAY_DOCTOR_RUN`); this link does not invent one.
 */
export type DoctorRunAnswer = {
  outcome: (typeof RELAY_DOCTOR_RUN)[keyof typeof RELAY_DOCTOR_RUN];
  detail?: string;
};

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
  /**
   * The report as it stands right now, or null before there is one (#542). Read
   * at the moment of every send rather than handed over, so a link that has been
   * reconnecting for a minute comes back with today's report and not the one it
   * was holding when the socket died.
   */
  report?: () => DeploymentReport | null;
  /**
   * A person pressed **Run doctor** in a console (#546). The answer is the
   * receipt, and it is written now rather than when the run ends: doctor holds
   * itself to five minutes, and a console waiting that long for one button is a
   * console an operator reloads. What the run found goes up as the next report.
   *
   * Absent means this link was built without a doctor behind it — a test, or a
   * deployment whose supervisor has none — and the ask is refused in those words
   * rather than dropped, so nobody is left watching a receipt that never comes.
   */
  onDoctorRun?: (by: string) => DoctorRunAnswer;
  /**
   * A person changed one config field in a console (#503, #547). Answers the
   * receipt the pen produced — written, or refused with the manual edit — and
   * the link sends it back verbatim.
   *
   * Absent means this link was built without a pen behind it, which is a test
   * or a deployment whose root config is not mounted read-write at all. The ask
   * is refused in those words rather than dropped, so nobody is left watching a
   * receipt that never comes.
   */
  onConfigSet?: (edit: ConfigEdit) => Promise<EditReceipt>;
  /**
   * Answer one `id`-bearing request from the relay (#550). Absent means this
   * deployment answers none: every request is then refused by return, which is
   * the honest answer and keeps the console from waiting on a receipt that was
   * never coming.
   *
   * A throw is a refusal with the thrown message — a handler is not required to
   * turn its own faults into outcomes, and a request left unanswered would hold
   * a console open until the socket closed.
   */
  onRequest?: (request: InboundRequest) => Promise<RequestAnswer>;
  /** The deployment key's fingerprint, once there is one to report. */
  onPaired?: (key: DeploymentKey) => void;
  /** Operator-facing lines. Defaults to stdout through the caller. */
  log?: (message: string) => void;
  warn?: (message: string) => void;
  open?: OpenRelaySocket;
  now?: () => number;
  /**
   * The two timers this module owns, named so a test can tell them apart: the
   * `retry` that dials again, and the `silence` that gives up on a connection
   * nothing is arriving on.
   */
  setTimer?: (fn: () => void, ms: number, kind: RelayTimer) => unknown;
  clearTimer?: (handle: unknown) => void;
  protocol?: number;
  random?: () => number;
};

/**
 * One inbound request, checked as far as the transport can check it: the type is
 * one the rail declares and there is an `id` to answer under. Every field past
 * that belongs to the verb — a secret's tenant, key and envelope are the secret
 * handler's to validate (bootstrap/secret-delivery.ts), and a link that tried
 * would be a second place to keep each verb's shape.
 */
export type InboundRequest = {
  type: RelayMessageType;
  /** The request id. The receipt carries it back, and it is the edit's own id. */
  id: string;
  /** The frame as it arrived. */
  frame: Record<string, unknown>;
};

/** What a verb answers with. The outcome is its own word (#506 §8). */
export type RequestAnswer = { outcome: string; detail?: unknown };

export type RelayLink = {
  /**
   * The report moved: push it, if there is a connection to push it down. A
   * no-op otherwise, and a no-op when the report has not changed since the last
   * push — the model hands over a new object each time it writes one, and that
   * is what "changed" means here.
   */
  push: () => void;
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
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
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
  /** Drop the live connection's own timer. Set by each dial, called by `stop`. */
  let abandon: (() => void) | null = null;
  /** Has this connection finished its hello? Nothing is pushed before it has. */
  let ready = false;
  /**
   * The report this connection has already been given. Identity, not equality:
   * the live model builds a new object for every write and keeps the old one
   * otherwise, so `===` is exactly the question "is this the same report".
   * Cleared with each dial, which is what makes every connection open with the
   * whole report whether or not it has changed since the last one.
   */
  let pushed: DeploymentReport | null = null;

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
    return { push: () => {}, stop: () => {} };
  }

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    report("reconnecting", new Date(now() + delayMs).toISOString());
    timer = setTimer(
      () => {
        timer = null;
        dial();
      },
      delayMs,
      "retry",
    );
  };

  /**
   * Send the report the model holds, unless this connection already has it.
   * Failure is silence on purpose: a send onto a socket that died between the
   * check and the write is the close that is already on its way, and the whole
   * report goes up again on the connection after it.
   */
  const pushReport = (): void => {
    if (!ready || socket === null) return;
    const current = deps.report?.() ?? null;
    if (current === null || current === pushed) return;
    const message: RelayReportMessage = {
      type: RELAY_MESSAGES.report,
      schema: current.schema,
      report: current,
    };
    try {
      socket.send(JSON.stringify(message));
      pushed = current;
    } catch (error) {
      warn(
        `[phoebe] relay: could not push the report — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Answer one `config-set` (#547). The receipt is the pen's own; the only two
   * this function writes itself are for a deployment with no pen and for a pen
   * that threw, and both carry the manual edit for the same reason every other
   * refusal does — the operator is left able to make the change by hand.
   */
  const setConfig = async (
    on: RelaySocket | null,
    message: RelayConfigSet | null,
  ): Promise<void> => {
    if (on === null || message === null) return;
    const edit: ConfigEdit = {
      id: message.id,
      path: message.path,
      value: message.value as ConfigEdit["value"],
      fingerprint: message.fingerprint,
      by: message.by,
    };
    let answer: EditReceipt;
    if (deps.onConfigSet === undefined) {
      answer = refusal(
        edit,
        "this deployment holds no pen — its root config is not mounted read-write",
        new Date(now()).toISOString(),
      );
    } else {
      try {
        answer = await deps.onConfigSet(edit);
      } catch (error) {
        answer = refusal(
          edit,
          error instanceof Error ? error.message : String(error),
          new Date(now()).toISOString(),
        );
      }
    }
    log(`[phoebe] relay: ${message.by} set ${message.path} — ${answer.state}.`);
    const receipt: RelayReceipt = {
      type: RELAY_MESSAGES.receipt,
      id: message.id,
      outcome: answer.state,
      detail: answer,
    };
    try {
      on.send(JSON.stringify(receipt));
    } catch (error) {
      // The socket died between the ask and the answer. The relay settles its
      // own request `undelivered` on the close, so there is nothing to retry —
      // and the edit either landed on disk or did not, whatever this send did.
      warn(
        `[phoebe] relay: could not answer the config edit — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Answer one `doctor-run` (#546). The receipt goes out whatever happened —
   * including when there is no doctor to run and when asking for one threw —
   * because the console is holding a request open on it and the relay's only
   * other way to settle that request is the socket closing.
   */
  const runDoctor = (on: RelaySocket | null, message: RelayDoctorRun | null): void => {
    if (on === null || message === null) return;
    let answer: DoctorRunAnswer;
    if (deps.onDoctorRun === undefined) {
      answer = { outcome: RELAY_DOCTOR_RUN.refused, detail: "this deployment runs no doctor" };
    } else {
      try {
        answer = deps.onDoctorRun(message.by);
      } catch (error) {
        answer = {
          outcome: RELAY_DOCTOR_RUN.refused,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    log(`[phoebe] relay: ${message.by} asked for a doctor run — ${answer.outcome}.`);
    const receipt: RelayReceipt = {
      type: RELAY_MESSAGES.receipt,
      id: message.id,
      outcome: answer.outcome,
      ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
    };
    try {
      on.send(JSON.stringify(receipt));
    } catch (error) {
      // The socket died between the ask and the answer. The relay settles its
      // own request `undelivered` on the close, so there is nothing to retry.
      warn(
        `[phoebe] relay: could not answer the doctor run — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Answer one inbound request, or refuse it. Every path here ends in exactly
   * one receipt: a request with no handler, a handler that threw and a handler
   * that answered all leave the console with a word rather than a wait.
   *
   * A frame this build does not recognise is dropped in silence — it has no
   * `id` to answer under, and a relay newer than this deployment is allowed to
   * say things it has not heard of.
   */
  function answerRequest(
    type: RelayMessageType | null,
    frame: unknown,
    socketNow: RelaySocket | null,
  ): void {
    if (type === null || !REQUEST_TYPES.has(type)) return;
    if (typeof frame !== "object" || frame === null) return;
    const body = frame as Record<string, unknown>;
    const id = body["id"];
    if (typeof id !== "string" || id.length === 0) return;

    const send = (answer: RequestAnswer): void => {
      const receipt: RelayReceipt = {
        type: RELAY_MESSAGES.receipt,
        id,
        outcome: answer.outcome,
        ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
      };
      try {
        socketNow?.send(JSON.stringify(receipt));
      } catch (error) {
        // The socket died between the answer and the write. The relay settles
        // its own pending request as `undelivered` when that happens, so the
        // console is not left waiting — there is nothing to do but say so.
        warn(`[phoebe] relay: could not send the receipt for ${id} — ${messageOf(error)}`);
      }
    };

    const handler = deps.onRequest;
    if (handler === undefined) {
      send({ outcome: "refused", detail: `this deployment does not answer ${type}` });
      return;
    }
    handler({ type, id, frame: body }).then(send, (error: unknown) =>
      send({ outcome: "refused", detail: messageOf(error) }),
    );
  }

  function dial(): void {
    if (stopped) return;
    let answered = false;
    ready = false;
    pushed = null;
    /** One connection ends once, whichever of the two ways it ends. */
    let ended = false;
    let silence: unknown = null;
    let current: RelaySocket | null = null;

    /**
     * The end of one connection, from a close frame or from the silence timer.
     * Either way it is the same event, and the retry rulebook is applied here
     * once: the terminal codes stop the link, `protocol` waits for an operator,
     * and everything else is the ordinary case and backs off.
     */
    const end = (code: number, reason: string): void => {
      if (ended) return;
      ended = true;
      ready = false;
      if (silence !== null) clearTimer(silence);
      silence = null;
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
    };

    /**
     * Something arrived, so the connection is alive for another minute. The
     * relay heartbeats every twenty seconds; three missed beats and this
     * deployment stops believing in a socket that has stopped saying anything.
     *
     * A half-open connection is the case this exists for — no close frame ever
     * arrives, so without a timer the link would wait forever on a socket that
     * died with the network it rode. The deployment cannot ping its way out of
     * that: Node's built-in client pongs on its own and offers no way to send a
     * ping or to see one arrive (#500), which is why the relay sends a visible
     * `heartbeat` beside every ping.
     */
    const heard = (): void => {
      if (silence !== null) clearTimer(silence);
      silence = setTimer(
        () => {
          silence = null;
          warn(
            `[phoebe] relay: nothing from ${deps.url} for ` +
              `${Math.round(RELAY_DARK_AFTER_MS / 1000)}s — redialling.`,
          );
          current?.close();
          end(1006, "no heartbeat");
        },
        RELAY_DARK_AFTER_MS,
        "silence",
      );
    };

    abandon = () => {
      ended = true;
      if (silence !== null) clearTimer(silence);
      silence = null;
    };

    current = open(deps.url, {
      onOpen: () => {
        // Deliberately silent about who it is: the relay speaks first, and a
        // deployment that announced itself before the challenge would be
        // telling a stranger its public key for nothing. The clock starts here
        // all the same — a relay that accepts the socket and never challenges
        // is silence like any other.
        heard();
      },

      onMessage: (data) => {
        heard();
        const frame = parseFrame(data);
        if (relayMessageType(frame) === RELAY_MESSAGES.configSet) {
          // Only after the hello: a `config-set` before the handshake is an
          // unidentified socket asking for a write to this deployment's config.
          if (ready) void setConfig(current, parseConfigSet(frame));
          return;
        }
        if (relayMessageType(frame) === RELAY_MESSAGES.doctorRun) {
          // Only after the hello: a `doctor-run` before the handshake is a relay
          // asking an unidentified socket to spend a tenant's API budget.
          if (ready) runDoctor(current, parseDoctorRun(frame));
          return;
        }
        const type = relayMessageType(frame);
        if (type !== RELAY_MESSAGES.challenge) {
          // Anything else on an admitted connection is a request or a
          // heartbeat. The heartbeat's whole payload is having arrived, which
          // `heard()` above has already taken.
          answerRequest(type, frame, current);
          return;
        }
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
          boxKey: key.boxKey,
          name: deps.name,
          ...(paired ? { signature: key.sign(challenge.nonce) } : { pairingToken: token ?? "" }),
        };
        current?.send(JSON.stringify(hello));
        // A key file written before box keys existed grew one when it was read
        // (#549). The hello has now committed to it under a signature, so it has
        // to be the key on the volume before the next boot mints a different
        // one and the relay's record goes stale.
        if (paired && !key.boxKeyOnVolume) {
          deps.saveKey(key);
          key = { ...key, boxKeyOnVolume: true };
          log(
            "[phoebe] relay: added a box key to state/relay-key — this deployment can now be " +
              "sent secrets from the console. The signing key, and the link, are unchanged.",
          );
        }
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
        ready = true;
        report("connected", null);
        // The whole report, on every connection, before anything asks for it
        // (#501). The status above will usually have moved the model and pushed
        // it already; this is what makes "on connect" true rather than lucky.
        pushReport();
      },

      onClose: (code, reason) => {
        end(code, reason);
      },
    });
    socket = current;
  }

  report("reconnecting", new Date(now()).toISOString());
  dial();

  return {
    push: pushReport,

    stop: () => {
      stopped = true;
      ready = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      abandon?.();
      abandon = null;
      socket?.close();
      socket = null;
    },
  };
}

/**
 * A `doctor-run` with the two fields the deployment reads, or null. A relay
 * that sent one without an `id` would be asking for a receipt it could not
 * match, and one without a `by` would be asking on nobody's behalf — the report
 * records who asked, so there is no such thing as an anonymous ask.
 */
export function parseDoctorRun(frame: unknown): RelayDoctorRun | null {
  if (relayMessageType(frame) !== RELAY_MESSAGES.doctorRun) return null;
  const message = frame as Partial<RelayDoctorRun>;
  if (typeof message.id !== "string" || message.id.length === 0) return null;
  if (typeof message.by !== "string" || message.by.length === 0) return null;
  return { type: RELAY_MESSAGES.doctorRun, id: message.id, by: message.by };
}

/**
 * The two refusals this link writes itself: an edit with no pen behind it, and a
 * pen that threw where it was supposed to answer. Both carry the manual edit,
 * because every refusal does (#503) — a console that got a reason code and no
 * instruction would have to work out for itself what the operator should type.
 *
 * `unwritable` for both: from the operator's side the file was not written and
 * the mount is the first thing to look at, which is what that reason's
 * instruction says.
 */
function refusal(edit: ConfigEdit, why: string, at: string): EditReceipt {
  // Naming the file by its name and not its path: the pen is the thing that
  // knows where the root config is mounted, and these are the two refusals
  // written without one.
  const file = ROOT_CONFIG_FILE;
  return {
    id: edit.id,
    state: "refused",
    file,
    path: edit.path,
    reason: "unwritable",
    why,
    instruction: instructionFor({ file, path: edit.path, value: edit.value, reason: "unwritable" }),
    at,
    ...(edit.by !== undefined ? { by: edit.by } : {}),
  };
}

/**
 * A `config-set` with the fields the deployment reads, or null. Every one of
 * them is required: without an `id` the relay is asking for a receipt it cannot
 * match, without a `fingerprint` the edit was composed blind and there is no
 * merge here to recover from one, and without a `by` it is an ask on nobody's
 * behalf — the ledger records who asked, so there is no anonymous edit.
 *
 * A value that is not a literal is refused here rather than carried: a leaf is a
 * literal, and an object arriving under one would be spliced into a file as
 * `[object Object]`.
 */
export function parseConfigSet(frame: unknown): RelayConfigSet | null {
  if (relayMessageType(frame) !== RELAY_MESSAGES.configSet) return null;
  const message = frame as Partial<RelayConfigSet>;
  if (typeof message.id !== "string" || message.id.length === 0) return null;
  if (typeof message.path !== "string" || message.path.length === 0) return null;
  if (typeof message.fingerprint !== "string" || message.fingerprint.length === 0) return null;
  if (typeof message.by !== "string" || message.by.length === 0) return null;
  const value = message.value;
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) return null;
  return {
    type: RELAY_MESSAGES.configSet,
    id: message.id,
    path: message.path,
    value,
    fingerprint: message.fingerprint,
    by: message.by,
  };
}

/**
 * The message types the generic handler answers (#506 §8, #550). `config-set`
 * and `doctor-run` are not here: each has a handler of its own above, because
 * its receipt is the pen's or the doctor runner's, and both are dispatched
 * before this set is consulted.
 */
const REQUEST_TYPES: ReadonlySet<RelayMessageType> = new Set([RELAY_MESSAGES.secretSet]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
