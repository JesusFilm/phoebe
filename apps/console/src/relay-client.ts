// The **relay client** — the one seam between the console's pages and the relay
// (#523 §"main is the relay client", map #497 §10).
//
// Every read the console makes goes through this interface and nothing calls
// `fetch` or constructs an `EventSource` anywhere else. That is the whole point:
// the same bundle runs in a browser against the relay's own origin and in the
// companion's renderer, where there is no cookie to send and no origin to fetch
// from, and main holds the device token instead (#523). The browser arm is here;
// the companion's arm is a second implementation of this same type, over the
// desktop bridge (#553).
//
// The interface carries the reads the fleet page makes and no more. A method
// added before a page needs it is a method nobody has run.

import { RELAY_EVENTS, RELAY_ROUTES } from "phoebe-agent/contracts";
import type {
  RelayConfigSetAnswer,
  RelayConfigSetRequest,
  DesktopBridge,
  RelayDeploymentDetail,
  RelayDeploymentRow,
  RelayEvent,
  RelayIdentity,
  RelayVersion,
  SecretReceiptDetail,
} from "phoebe-agent/contracts";

/**
 * One secret set or clear, as the console asks for it (#550). The envelope is
 * sealed in the page before this is built, and `by` is deliberately not here:
 * the relay stamps that from its own session, so a caller cannot choose whose
 * name lands in the deployment's ledger.
 */
export type SecretRequest = {
  fingerprint: string;
  tenant: string;
  key: string;
  action: "set" | "clear";
  /** The edit id, bound into the envelope's AAD before it was sealed. */
  id: string;
  /** The JSON of a sealed envelope. Absent on a clear — there is no value. */
  envelope?: string;
};

/**
 * What came back: the deployment's own word (`written` / `refused`), or the
 * relay's `undelivered` when the socket closed with the request in flight.
 */
export type SecretReceipt = {
  id: string;
  outcome: string;
  detail?: SecretReceiptDetail;
};

/**
 * How this arm signs in (#523 §2). Two shapes because the two arms sign in by
 * genuinely different means, and flattening them into one method with half its
 * arguments ignored would hide that from the page rather than from the reader.
 *
 * A browser follows a link: the relay is the origin that served the page, and
 * the sign-in ends with the relay setting a cookie on a navigation the page
 * does not survive. The companion has no origin and no cookie — main runs the
 * flow in the operator's own browser and comes back with a token — so there the
 * control is a form, and the relay's address is the one thing it has to ask for.
 */
export type RelaySignIn =
  /** A browser: the relay's own sign-in path, followed as a navigation. */
  | { kind: "navigate"; href: string }
  /** The companion: main opens the system browser and answers when it is done. */
  | {
      kind: "prompt";
      /** The relay the companion last held a token for, to fill the field with. */
      relay: string | null;
      /** Whether a sign-in here would survive a relaunch (#523 §5). */
      persisted: boolean;
      /** What to tell the operator about the two above, when there is something. */
      reason?: string;
      /** Run one sign-in. Resolves with whoever signed in. */
      start: (relayUrl: string) => Promise<RelayIdentity>;
    };

/** What the console can ask the relay for, whichever side of the seam it is on. */
export type RelayClient = {
  /**
   * The relay's package version and the console protocol it serves (#525 §4).
   * The one read with no session behind it, and the one every other read waits
   * on — see relay-version.ts.
   */
  version: () => Promise<RelayVersion>;
  /**
   * Who the session belongs to, or null when there is no session. Null rather
   * than a throw because "not signed in" is a page the console draws, not an
   * error it reports.
   */
  me: () => Promise<RelayIdentity | null>;
  /**
   * How to sign in from here, read fresh: the companion's answer carries the
   * relay it remembers and whether it can keep a token, and both move.
   */
  signIn: () => Promise<RelaySignIn>;
  /** Drop the session. The caller re-reads `me` afterwards. */
  signOut: () => Promise<void>;
  /**
   * Watch for the session ending without the page having asked for anything —
   * the companion's arm dropping its token on a 401 from the event stream.
   * Returns the unsubscribe.
   */
  watchSession: (onChange: (identity: RelayIdentity | null) => void) => () => void;
  /** Every deployment the relay knows, unsorted: the order is the console's. */
  deployments: () => Promise<RelayDeploymentRow[]>;

  /**
   * One deployment's row and its last report. The fleet page asks per row,
   * because `/api/deployments` answers rows only and a bar segment per pipeline
   * is a fact from the report.
   */
  deployment: (fingerprint: string) => Promise<RelayDeploymentDetail>;

  /**
   * Set one field of one deployment's root config (#503, #547). Answers the
   * deployment's own receipt — `written` or `refused` — or the relay's
   * `undelivered` when it never got there. All three are outcomes a page
   * renders, so none of them throws.
   *
   * What does throw is the relay refusing the request itself: a session that is
   * gone, a patch it will not carry, a deployment it has no link for. Those are
   * about this call rather than about the config, and the caller says so in
   * different words.
   *
   * The author is not a parameter. The relay stamps the signed-in address on
   * the way past, which is what makes the ledger's `by` the session's word.
   */
  setConfigField: (edit: RelayConfigSetRequest) => Promise<RelayConfigSetAnswer>;

  /**
   * Set or clear one tenant secret on a deployment (#550). The relay forwards
   * the envelope unopened and answers with whatever the deployment said.
   *
   * A relay refusal — no session, no such deployment, a malformed request — is a
   * {@link RelayRequestError}; a deployment refusal is a receipt with
   * `outcome: "refused"`, because that is an answer and not a failure.
   */
  setSecret: (request: SecretRequest) => Promise<SecretReceipt>;

  /**
   * Watch the relay's event stream. Returns the unsubscribe; calling it closes
   * the stream. Errors on the stream are not surfaced — the transport redials on
   * its own, and a page that missed an event catches up by re-reading.
   */
  events: (onEvent: (event: RelayEvent) => void) => () => void;
};

/** A relay answer the console did not ask for. `code` is the body's `error`. */
export class RelayRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`the relay answered ${status} ${code}`);
    this.name = "RelayRequestError";
    this.status = status;
    this.code = code;
  }
}

/** True when this error is the relay saying the session is gone. */
export function isNotSignedIn(error: unknown): boolean {
  return error instanceof RelayRequestError && error.status === 401;
}

/** The two globals the browser arm needs, injected so a test can stand them in. */
export type BrowserRelayClientOptions = {
  fetch?: typeof globalThis.fetch;
  /** `EventSource`'s constructor. Kept structural so a fake needs three members. */
  eventSource?: EventSourceLike;
};

/** As much of `EventSource` as this module touches. */
export type EventSourceLike = new (
  url: string,
  init?: { withCredentials?: boolean },
) => {
  addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close: () => void;
};

/**
 * The browser arm: the relay's own origin, the `__Host-` session cookie, and
 * `EventSource` (#522 §4).
 *
 * Paths are relative, with no origin in front of them, so the bundle talks to
 * whatever host served it. `credentials: "same-origin"` is the default for a
 * same-origin request and is written out because the cookie is the whole
 * authentication story here — a future edit that adds an absolute origin would
 * silently drop it.
 */
export function createBrowserRelayClient(options: BrowserRelayClientOptions = {}): RelayClient {
  const call = options.fetch ?? globalThis.fetch.bind(globalThis);
  const Stream = options.eventSource ?? (globalThis.EventSource as unknown as EventSourceLike);

  async function get<T>(path: string): Promise<T> {
    const response = await call(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new RelayRequestError(response.status, await errorCode(response));
    return (await response.json()) as T;
  }

  return {
    version() {
      return get<RelayVersion>(RELAY_ROUTES.version);
    },

    async me() {
      try {
        return await get<RelayIdentity>(RELAY_ROUTES.me);
      } catch (error) {
        if (isNotSignedIn(error)) return null;
        throw error;
      }
    },

    signIn() {
      return Promise.resolve({ kind: "navigate", href: RELAY_ROUTES.signIn });
    },

    // A cookie cannot go away under a page that has not asked for anything: the
    // relay only ever withdraws one on a response, and a response is something
    // the page requested. So there is nothing to watch, and the unsubscribe is
    // the whole of this arm's answer.
    watchSession() {
      return () => {};
    },

    async signOut() {
      const response = await call(RELAY_ROUTES.signOut, {
        method: "POST",
        credentials: "same-origin",
      });
      // 401 is success as far as the caller is concerned: the session it asked
      // to be rid of is already gone.
      if (!response.ok && response.status !== 401) {
        throw new RelayRequestError(response.status, await errorCode(response));
      }
    },

    async deployments() {
      const body = await get<{ deployments: RelayDeploymentRow[] }>(RELAY_ROUTES.deployments);
      return body.deployments;
    },

    deployment(fingerprint) {
      return get<RelayDeploymentDetail>(
        `${RELAY_ROUTES.deployments}/${encodeURIComponent(fingerprint)}`,
      );
    },

    async setConfigField(edit) {
      const response = await call(RELAY_ROUTES.configSet, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(edit),
      });
      if (!response.ok) throw new RelayRequestError(response.status, await errorCode(response));
      return (await response.json()) as RelayConfigSetAnswer;
    },

    async setSecret(request) {
      const response = await call(RELAY_ROUTES.secrets, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new RelayRequestError(response.status, await errorCode(response));
      return (await response.json()) as SecretReceipt;
    },

    events(onEvent) {
      const stream = new Stream(RELAY_ROUTES.events, { withCredentials: true });
      // One listener per event name, because the relay writes the name into SSE's
      // `event:` field rather than into the payload (relay-events.ts).
      for (const name of Object.values(RELAY_EVENTS)) {
        stream.addEventListener(name, (message) => {
          const event = parseEvent(message.data);
          if (event !== null) onEvent(event);
        });
      }
      return () => stream.close();
    },
  };
}

/**
 * The body's `error` field, or the status's own name. The relay answers every
 * refusal under `/api` as `{ error }`; a proxy in front of it may not, and a
 * caller branching on the code should not have to care which one spoke.
 */
async function errorCode(response: { json: () => Promise<unknown> }): Promise<string> {
  try {
    const body = await response.json();
    const code = (body as { error?: unknown }).error;
    return typeof code === "string" ? code : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * One SSE payload as an event, or null when it does not parse. Null rather than
 * a throw: a malformed frame is one frame, and dropping it keeps the stream
 * alive for the next one, which is exactly what a reader that re-reads on
 * reconnect can afford.
 */
function parseEvent(data: string): RelayEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" && type in RELAY_EVENTS ? (parsed as RelayEvent) : null;
}

/**
 * The companion's arm: main holds the device token and makes every call, and
 * this side only names routes (#527 §9). No cookie, no `EventSource` and no
 * origin to fetch from — the bundle was loaded from disk.
 *
 * The two arms answer the same way on purpose. A bridge call refused
 * `signed-out` becomes the 401 the browser arm would have been given, so
 * `isNotSignedIn` reads both and the pages above never branch on the surface.
 */
export function createBridgeRelayClient(bridge: DesktopBridge): RelayClient {
  async function get<T>(path: string): Promise<T> {
    try {
      return (await bridge.relay.request({ method: "GET", path })) as T;
    } catch (error) {
      throw asRelayError(error);
    }
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    try {
      return await bridge.relay.request({ method: "POST", path, body });
    } catch (error) {
      throw asRelayError(error);
    }
  }

  return {
    version() {
      return get<RelayVersion>(RELAY_ROUTES.version);
    },

    async me() {
      return (await bridge.relay.state()).person;
    },

    async signIn() {
      const state = await bridge.relay.state();
      return {
        kind: "prompt",
        relay: state.url,
        persisted: state.persisted,
        ...(state.reason === undefined ? {} : { reason: state.reason }),
        start: async (relayUrl: string) => {
          const signedIn = await bridge.relay.signIn({ url: relayUrl });
          if (signedIn.person === null) throw new Error("the sign-in did not complete");
          return signedIn.person;
        },
      };
    },

    watchSession(onChange) {
      return bridge.relay.watch((state) => onChange(state.person));
    },

    signOut() {
      return bridge.relay.signOut();
    },

    async deployments() {
      const body = await get<{ deployments: RelayDeploymentRow[] }>(RELAY_ROUTES.deployments);
      return body.deployments;
    },

    deployment(fingerprint) {
      return get<RelayDeploymentDetail>(
        `${RELAY_ROUTES.deployments}/${encodeURIComponent(fingerprint)}`,
      );
    },

    // The two writes go over the same passthrough the reads do, so the console
    // bundle is one bundle: what changes between the arms is how the request
    // travels, never what a page sends (#523 §3, #547, #550).
    async setConfigField(edit) {
      return (await post(RELAY_ROUTES.configSet, edit)) as RelayConfigSetAnswer;
    },

    async setSecret(request) {
      return (await post(RELAY_ROUTES.secrets, request)) as SecretReceipt;
    },

    events(onEvent) {
      return bridge.relay.events(onEvent);
    },
  };
}

/**
 * A bridge refusal in the relay's own terms where there is one. Only
 * `signed-out` maps: the rest of the bridge's codes (#527 §16) are local-arm
 * facts, and dressing one up as an HTTP status would lose what it said.
 */
function asRelayError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "signed-out" ? new RelayRequestError(401, "signed-out") : error;
}
