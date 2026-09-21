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
  RelayDeploymentDetail,
  RelayDeploymentRow,
  RelayDoctorRunAnswer,
  RelayDoctorRunResult,
  RelayEvent,
  RelayIdentity,
  RelayPairingToken,
  RelayPerson,
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

/** What the console can ask the relay for, whichever side of the seam it is on. */
export type RelayClient = {
  /**
   * Who the session belongs to, or null when there is no session. Null rather
   * than a throw because "not signed in" is a page the console draws, not an
   * error it reports.
   */
  me: () => Promise<RelayIdentity | null>;
  /** Drop the session. The caller re-reads `me` afterwards. */
  signOut: () => Promise<void>;
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
   * Ask one deployment to run doctor, or every deployment when no fingerprint is
   * given (#546). Answers one result per deployment asked, whichever it was, so
   * a page renders the two the same way.
   *
   * What the run finds is not here. It arrives as the next report on the event
   * stream, which is the same path every other fact about a deployment takes.
   */
  runDoctor: (fingerprint?: string) => Promise<RelayDoctorRunResult[]>;

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
  /** Everyone who may sign in, as the People page lists them (#505 §6). */
  people: () => Promise<RelayPerson[]>;
  /**
   * Add one person by address. The refusals — a malformed address, an address
   * already on the list — arrive as a `RelayRequestError` whose `code` the page
   * turns into a sentence.
   */
  addPerson: (email: string) => Promise<RelayPerson>;
  /**
   * Remove one person, and with them their sessions. Answers how many sessions
   * ended, because "they are signed out now" is the half of a removal an
   * operator cannot otherwise see.
   */
  removePerson: (email: string) => Promise<{ sessionsEnded: number }>;
  /**
   * Mint one pairing token. The string comes back once and the relay keeps only
   * its expiry, so a caller that loses it mints another.
   */
  mintPairingToken: () => Promise<RelayPairingToken>;
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

  /**
   * A verb. `body` is omitted rather than sent as `{}` when there is nothing to
   * say, which is what the mint is: a POST whose whole content is that it
   * happened.
   */
  async function post<T>(path: string, body?: unknown): Promise<T> {
    const response = await call(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new RelayRequestError(response.status, await errorCode(response));
    return (await response.json()) as T;
  }

  return {
    async me() {
      try {
        return await get<RelayIdentity>(RELAY_ROUTES.me);
      } catch (error) {
        if (isNotSignedIn(error)) return null;
        throw error;
      }
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

    async people() {
      const body = await get<{ people: RelayPerson[] }>(RELAY_ROUTES.people);
      return body.people;
    },

    async addPerson(email) {
      const body = await post<{ person: RelayPerson }>(RELAY_ROUTES.people, { email });
      return body.person;
    },

    async removePerson(email) {
      const body = await post<{ sessionsEnded: number }>(RELAY_ROUTES.removePerson, { email });
      return { sessionsEnded: body.sessionsEnded };
    },

    mintPairingToken() {
      return post<RelayPairingToken>(RELAY_ROUTES.pairingTokens);
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

    async runDoctor(fingerprint) {
      const response = await call(RELAY_ROUTES.doctorRun, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        // An empty object, not an empty body: no fingerprint is what asks the
        // whole fleet, and the relay reads that from the JSON it parses.
        body: JSON.stringify(fingerprint === undefined ? {} : { fingerprint }),
      });
      if (!response.ok) throw new RelayRequestError(response.status, await errorCode(response));
      return ((await response.json()) as RelayDoctorRunAnswer).results;
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
