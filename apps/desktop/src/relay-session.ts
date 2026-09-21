// Main as the relay client (#523 §1, #554).
//
// Everything the companion sends the relay leaves from here: the sign-in, the
// JSON reads the renderer asks for, the event stream, and the revoke on the way
// out. The renderer never learns the device token and never reaches the relay
// itself — it hands main a method and a path and gets an answer back, which is
// the bridge arm of the console's relay-client seam on the other side of the
// wire (relay-client.ts).
//
// **Why main and not the renderer.** The bundle is loaded from disk on a custom
// scheme, so it has no origin the relay would accept a cookie from, and a
// credential in a renderer is a credential in the same process as every page
// the console draws. Main has neither problem, and the cost — one IPC hop — is
// paid once per read.
//
// **Sign-in is three moves and a hop.** Main mints a PKCE verifier, opens the
// operator's own browser at the relay's `device/start`, and waits. Google
// happens in that browser, out of the app's reach, which is the point: Google
// refuses to sign anyone in inside an embedded webview. The relay comes back to
// `phoebe://auth?code=…`, the OS hands that URL to this process, and the code is
// spent for a token. Any app on the machine can register that scheme; only the
// one holding the verifier can spend the code.
//
// **A 401 is the end of a session, not a retry.** The relay has said this token
// is not one it knows — because someone revoked it, or because the volume it
// was written on is gone. Main drops it, the arm reads signed out, and the rail
// draws a sign-in control. Retrying would be a loop against a settled answer.
//
// Every edge — fetch, the browser, the clock, the keyring — is a parameter, so
// the whole of this file runs in a test with no Electron and no network.

import { createHash, randomBytes } from "node:crypto";
import { RELAY_ROUTES } from "phoebe-agent/contracts";
import type {
  RelayArmState,
  RelayDevice,
  RelayEvent,
  RelayPassthrough,
} from "phoebe-agent/contracts";
import { BridgeRefusal } from "./channels.ts";
import { createSseReader } from "./sse.ts";
import { NO_KEYRING_REASON, type StoredSession, type TokenVault } from "./vault.ts";

/** As much of `fetch` as this file uses. Structural, so `net.fetch` fits it. */
export type RelayFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
}>;

/**
 * How long an operator has between the browser opening and the code coming
 * back. Generously long, because what it covers is a person finding the right
 * Google account and typing a password — the relay's own sixty-second code TTL
 * starts only once that is done.
 */
export const SIGN_IN_WINDOW_MS = 5 * 60 * 1000;

/** The reconnect ladder for the event stream: full jitter, doubling to a cap. */
export const RECONNECT_FIRST_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;

export type RelaySessionOptions = {
  vault: TokenVault;
  fetch: RelayFetch;
  /** Hand a URL to the operator's own browser. */
  openExternal: (url: string) => void | Promise<void>;
  /** What this companion calls itself to the relay — see `companionName`. */
  deviceName: string;
  /** The relay's events, for main to forward to the renderer. */
  onEvent: (event: RelayEvent) => void;
  /** Fired whenever the arm's state changes, so a window can be told unasked. */
  onState?: (state: RelayArmState) => void;
  /** Injected so a test does not wait out a backoff. */
  delay?: (ms: number) => Promise<void>;
  /** How long a sign-in attempt stays open. */
  signInWindowMs?: number;
  warn?: (message: string) => void;
};

export type RelaySession = {
  /** The arm, as the renderer is allowed to see it. Never carries the token. */
  state: () => RelayArmState;
  /** Open the browser and resolve once the code has come back and been spent. */
  signIn: (relayUrl: string) => Promise<RelayArmState>;
  /** The OS handed the app a URL. True when it was an auth link this took. */
  deliver: (code: string) => boolean;
  /** One call on the relay's JSON API, on the renderer's behalf. */
  request: (passthrough: RelayPassthrough) => Promise<unknown>;
  /** Revoke on the relay, then forget locally. */
  signOut: () => Promise<void>;
  /** Stop the event stream. What quitting does. */
  close: () => void;
};

export function createRelaySession(options: RelaySessionOptions): RelaySession {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const sleep = options.delay ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const window = options.signInWindowMs ?? SIGN_IN_WINDOW_MS;

  let session: StoredSession | null = options.vault.read();
  let reason: string | null = null;
  let pending: Pending | null = null;
  let stream: AbortController | null = null;
  let closed = false;

  if (session !== null) watch(session);
  if (!options.vault.persists) reason = NO_KEYRING_REASON;

  function announce(): void {
    options.onState?.(current());
  }

  function current(): RelayArmState {
    return {
      url: session?.url ?? null,
      person: session?.person ?? null,
      persisted: options.vault.persists && session !== null,
      ...(reason === null ? {} : { reason }),
    };
  }

  /** Take a session on: remember it, write it down if we can, start watching. */
  function adopt(next: StoredSession): void {
    session = next;
    reason = options.vault.persists ? null : NO_KEYRING_REASON;
    options.vault.write(next);
    watch(next);
    announce();
  }

  /** Let a session go. `why` is what the rail says about it, when there is one. */
  function release(why: string | null): void {
    session = null;
    reason = why ?? (options.vault.persists ? null : NO_KEYRING_REASON);
    options.vault.clear();
    stream?.abort();
    stream = null;
    announce();
  }

  async function call(
    live: StoredSession,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await options.fetch(live.url + path, {
      method,
      headers: {
        authorization: `Bearer ${live.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      release("This relay no longer accepts this companion's sign-in. Sign in again.");
      throw new BridgeRefusal({
        code: "signed-out",
        message: "the relay no longer accepts this companion's sign-in",
      });
    }
    if (!response.ok) {
      throw new BridgeRefusal({
        code: "refused",
        message: `the relay answered ${response.status} ${await errorCode(response)}`,
      });
    }
    // 204 is what revoke and sign-out answer; there is no body to read.
    return response.status === 204 ? undefined : await response.json();
  }

  /**
   * One SSE connection per signed-in relay, redialled for as long as this
   * session is the current one. The loop ends on a 401 — a revoked token will
   * not become valid by being offered again — and on any other failure it waits
   * out the ladder and tries once more, because a relay behind a restarting
   * proxy is the ordinary case.
   */
  function watch(watched: StoredSession): void {
    stream?.abort();
    const control = new AbortController();
    stream = control;
    void (async () => {
      let attempt = 0;
      while (!closed && !control.signal.aborted) {
        try {
          const response = await options.fetch(watched.url + RELAY_ROUTES.events, {
            headers: {
              authorization: `Bearer ${watched.token}`,
              accept: "text/event-stream",
            },
            signal: control.signal,
          });
          if (response.status === 401) {
            release("This relay no longer accepts this companion's sign-in. Sign in again.");
            return;
          }
          if (!response.ok || response.body === null) {
            throw new Error(`the relay answered ${response.status} on the event stream`);
          }
          attempt = 0;
          await pump(response.body, options.onEvent);
        } catch (error) {
          if (control.signal.aborted) return;
          warn(`[phoebe] the relay's event stream dropped: ${messageOf(error)}`);
        }
        if (closed || control.signal.aborted) return;
        await sleep(reconnectDelayMs(attempt++));
      }
    })();
  }

  return {
    state: current,

    async signIn(relayUrl) {
      const origin = relayOrigin(relayUrl);
      if (origin === null) {
        throw new BridgeRefusal({
          code: "refused",
          message: `${relayUrl} is not a relay address`,
          instruction: "A relay address looks like https://relay.example.com",
        });
      }
      // Changing relays revokes the old token first, best effort: the operator
      // asked to stop using that relay, and a token left behind is one more row
      // on someone's People page that nobody will ever recognise (#523 §4).
      if (session !== null && session.url !== origin) await revoke(session);
      pending?.abandon("This sign-in was replaced by another.");

      const verifier = randomBytes(32).toString("base64url");
      const start = new URL(RELAY_ROUTES.deviceStart, `${origin}/`);
      start.searchParams.set("challenge", pkceChallenge(verifier));
      start.searchParams.set("name", options.deviceName);

      const attempt = openAttempt(origin, verifier, window, () => {
        if (pending?.verifier === verifier) pending = null;
      });
      pending = attempt;
      try {
        await options.openExternal(start.href);
      } catch (error) {
        // Abandoning rejects `attempt.settled`, which the line below never gets
        // to await — so it is marked handled here rather than surfacing as an
        // unhandled rejection in main.
        void attempt.settled.catch(() => {});
        attempt.abandon(`The companion could not open a browser: ${messageOf(error)}`);
        throw new BridgeRefusal({
          code: "refused",
          message: `could not open a browser for sign-in: ${messageOf(error)}`,
          instruction: `Open ${start.href} by hand to sign in.`,
        });
      }
      return await attempt.settled;
    },

    deliver(code) {
      const attempt = pending;
      if (attempt === null) return false;
      pending = null;
      void (async () => {
        try {
          const result = (await postJson(options.fetch, attempt.url + RELAY_ROUTES.deviceExchange, {
            code,
            verifier: attempt.verifier,
          })) as { token?: unknown; device?: unknown };
          const device = result.device as RelayDevice | undefined;
          if (typeof result.token !== "string" || device === undefined) {
            throw new Error("the relay's exchange answered no token");
          }
          adopt({
            url: attempt.url,
            token: result.token,
            person: { sub: device.sub, email: device.email },
          });
          attempt.finish(current());
        } catch (error) {
          attempt.abandon(`The sign-in could not be completed: ${messageOf(error)}`);
        }
      })();
      return true;
    },

    async request(passthrough) {
      const live = session;
      if (live === null) {
        throw new BridgeRefusal({
          code: "signed-out",
          message: "the companion is not signed in to a relay",
        });
      }
      // The path is the renderer's, so it is checked before it is joined to an
      // origin: a renderer that could send an absolute URL could aim the device
      // token at any host it liked.
      if (!passthrough.path.startsWith("/")) {
        throw new BridgeRefusal({
          code: "refused",
          message: `${passthrough.path} is not a path on the relay`,
        });
      }
      return await call(live, passthrough.method, passthrough.path, passthrough.body);
    },

    async signOut() {
      const live = session;
      release(null);
      if (live !== null) await revoke(live);
    },

    close() {
      closed = true;
      pending?.abandon("The companion is closing.");
      stream?.abort();
      stream = null;
    },
  };

  /**
   * Tell the relay to forget this token. Best effort by design: the local copy
   * is already gone by the time this runs, so a relay that is unreachable costs
   * a stale row on the People page and not a companion that is still signed in.
   */
  async function revoke(live: StoredSession): Promise<void> {
    try {
      await options.fetch(live.url + RELAY_ROUTES.deviceRevoke, {
        method: "POST",
        headers: { authorization: `Bearer ${live.token}` },
      });
    } catch (error) {
      warn(`[phoebe] could not revoke the device token: ${messageOf(error)}`);
    }
  }

  /** One sign-in attempt, with the timer that gives up on it. */
  function openAttempt(
    url: string,
    verifier: string,
    windowMs: number,
    onSettle: () => void,
  ): Pending {
    let finish!: (state: RelayArmState) => void;
    let fail!: (error: Error) => void;
    const settled = new Promise<RelayArmState>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    let done = false;
    const timer = setTimeout(() => {
      attempt.abandon("The sign-in did not come back. Try again.");
    }, windowMs);
    timer.unref?.();
    const settle = (act: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      onSettle();
      act();
    };
    const attempt: Pending = {
      url,
      verifier,
      settled,
      finish: (state) => settle(() => finish(state)),
      abandon: (message) => settle(() => fail(new BridgeRefusal({ code: "refused", message }))),
    };
    return attempt;
  }
}

/**
 * The delay before redial `attempt` (0-based): full jitter under a ceiling that
 * doubles from `RECONNECT_FIRST_MS` and stops at `RECONNECT_CAP_MS`. The same
 * rule the deployment's own relay transport redials on (#500) — stated again
 * here rather than imported, because `src/backoff.ts` is engine code and this
 * package's only edge onto the engine is the pure `contracts` subpath.
 */
export function reconnectDelayMs(attempt: number): number {
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_FIRST_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

type Pending = {
  url: string;
  verifier: string;
  settled: Promise<RelayArmState>;
  finish: (state: RelayArmState) => void;
  abandon: (message: string) => void;
};

/**
 * What this companion calls itself on the relay's People page: the machine's
 * name and the OS it runs, which together are what an operator looking at a
 * list of devices can actually recognise (#523 glossary).
 */
export function companionName(hostname: string, platform: string): string {
  const os = OS_NAMES[platform] ?? platform;
  const machine = hostname.trim().replace(/\.local$/, "");
  return machine === "" ? `a ${os} companion` : `${machine} (${os})`;
}

const OS_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/**
 * The origin of a relay address, or null when the string is not one. Only
 * `http` and `https` — a relay reached over anything else is not a relay, and
 * this is the one place an operator's typing becomes a URL the token is sent to.
 */
export function relayOrigin(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.origin;
}

/** RFC 7636 S256, the half of PKCE that leaves this process. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Read one event stream to its end, handing whole relay events out as they land. */
async function pump(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: RelayEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const read = createSseReader((frame) => {
    const event = parseEvent(frame.data);
    if (event !== null) onEvent(event);
  });
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    read(decoder.decode(value, { stream: true }));
  }
}

/**
 * One SSE payload as a relay event, or null. Null rather than a throw: a frame
 * that does not parse is one frame, and the stream is worth keeping for the
 * next one — a reader that missed an event catches up by re-reading.
 */
function parseEvent(data: string): RelayEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return typeof (parsed as { type?: unknown }).type === "string" ? (parsed as RelayEvent) : null;
}

/** The exchange, which carries no bearer: the code and the verifier are the proof. */
async function postJson(call: RelayFetch, url: string, body: unknown): Promise<unknown> {
  const response = await call(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`the relay answered ${response.status} ${await errorCode(response)}`);
  return await response.json();
}

/** The body's `error` field, or a stand-in when whatever answered did not say. */
async function errorCode(response: { json: () => Promise<unknown> }): Promise<string> {
  try {
    const code = (await response.json()) as { error?: unknown };
    return typeof code.error === "string" ? code.error : "unreadable";
  } catch {
    return "unreadable";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
