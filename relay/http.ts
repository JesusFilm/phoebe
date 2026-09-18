// The relay's HTTP surface: the sign-in flow, the reads and verbs behind it, and
// the console's own build (#538, #540, #541, #542, #543, #551).
//
// What a signed-in person can ask for is who they are, a pairing token for a new
// deployment, the fleet as the socket endpoint knows it — with what the relay
// last alerted about each link — one deployment with the last report it pushed,
// the stream those reports arrive on, the forgetting of one deployment, one
// field of one deployment's config set, the setting of one tenant secret —
// which the relay carries sealed and stamps with who asked, without ever being
// able to read it (#550) — and one test alert. The console's pages sit on
// exactly these answers, and the relay hands the pages out too — the bundle is
// in the same package (console-assets.ts).
//
// **A verb that travels to a deployment is a courier's job** (#503, #547, #550).
// The relay stamps the signed-in address onto the edit — that is the one field
// it authors, and it authors it because a browser must not be able to name
// someone else as the editor — sends the patch down the rail, and hands the
// receipt back exactly as it came. It does not read the receipt, judge it, or
// translate its word, so a deployment newer than its relay is quoted rather than
// summarized.
//
// **The API is matched first, and a path under it never falls through to a page.**
// Every route below is tried before the console sees the request, and the console
// only ever answers with a file it has. So `/api/anything-else` is still the JSON
// 404 it always was, which is what a browser fetching JSON can branch on.
//
// **Two reads and one stream, and the stream is not a third read.** Every event
// on `/api/events` has a `GET` behind it that answers the same question in full,
// so a page that missed one refetches rather than resyncs. That is what keeps
// the stream from becoming a second, worse copy of the state on the volume.
//
// **Two carriers, one door.** Who is asking is read from a `__Host-` cookie or
// from an `Authorization: Bearer` — a browser has the first and a companion has
// the second (#523 §1, #554). Every route behind the door goes through `caller`
// and none of them knows which one it got, because nothing a signed-in person
// may ask for depends on what they are holding.
//
// The shape every route follows is set here: paths come from contracts, and
// anything behind the door answers an unknown caller with 401 rather than a
// redirect. A browser fetching JSON wants a status code it can branch on, not
// an HTML login page delivered with a 200.
//
// **One route under `/api` has no door on it**, and it is the first one tried:
// `/api/version`. A companion too new for this relay has to be able to find that
// out before it has a session to find it out with (#525 §4, console-protocol.ts).

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { CONSOLE_PROTOCOL } from "../src/contracts/console-protocol.ts";
import type { RelayVersion } from "../src/contracts/console-protocol.ts";
import {
  RELAY_HEARTBEAT_MS,
  RELAY_MESSAGES,
  RELAY_UNDELIVERED,
  type RelayReceipt,
  type RelayRequest,
  type RelaySecretSet,
} from "../src/contracts/relay-protocol.ts";
import { COMPANION_AUTH_URL, RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type {
  DeviceExchangeResult,
  RelayConfigSetAnswer,
  RelayConfigSetRequest,
  RelayDeploymentDetail,
  RelayDeploymentRow,
  RelayIdentity,
} from "../src/contracts/relay-routes.ts";
import type { RelayAlertFacts } from "../src/contracts/alerts.ts";
import type { RelayEvent } from "../src/contracts/relay-events.ts";
import { isFingerprint } from "../src/ed25519.ts";
import type { Allowlist } from "./allowlist.ts";
import { bearerToken, type DeviceCodes, type Devices } from "./devices.ts";
import type { ConsoleAssets } from "./console-assets.ts";
import type { RelayEvents } from "./events.ts";
import type { Reports } from "./reports.ts";
import type { Link, PairingTokens } from "./links.ts";
import { newAuthParams, type IdentityProvider } from "./oidc.ts";
import {
  clearCookie,
  parseCookies,
  PRE_AUTH_COOKIE,
  PRE_AUTH_TTL_MS,
  SESSION_COOKIE,
  setCookie,
  type DeviceIntent,
  type SessionStore,
} from "./sessions.ts";

/**
 * Where a completed sign-in lands: the console, which reads `/api/me` itself and
 * draws the fleet (#543). A relay whose package carries no console build answers
 * this path with a sentence saying so rather than a blank page.
 */
export const SIGNED_IN_LANDING: string = "/";

export type RelayHandlerOptions = {
  allowlist: Allowlist;
  /** The in-memory token registry a mint draws from (#540). */
  tokens: PairingTokens;
  /**
   * The fleet, as the socket endpoint knows it (#541). A thunk because the
   * endpoint needs the HTTP server this handler is being built for, so the two
   * cannot both be constructed first.
   */
  fleet: () => {
    rows: (now?: Date) => RelayDeploymentRow[];
    forget: (fingerprint: string) => Link | null;
    /**
     * Carry one `id`-bearing request to a deployment and wait for its receipt
     * (#547, #550). Answers `undelivered` rather than queueing when there is no
     * live socket.
     */
    request: (fingerprint: string, message: RelayRequest) => Promise<RelayReceipt>;
  };
  /** The reports on the volume — the per-deployment read's other half (#542). */
  reports: Reports;
  /** The stream every page watches. */
  events: RelayEvents;
  /** The console's build, or an assets handler pointed at a test's directory. */
  console: ConsoleAssets;
  /**
   * Alerting, as the connection panel reads it and as the test button drives it
   * (#515 §13). Always present: a relay with no webhook still evaluates edges,
   * so "is one configured" is a fact to state and not a reason to omit a route.
   */
  alerts: {
    facts: () => RelayAlertFacts;
    test: (by: string) => Promise<{ sinks: number }>;
  };
  sessions: SessionStore;
  /** The companions signed in to this relay, on the volume (#554). */
  devices: Devices;
  /** The one-time codes in flight between the callback and an exchange. */
  deviceCodes: DeviceCodes;
  identity: IdentityProvider;
  /**
   * The relay's own package version, for `/api/version` (#525 §4). Passed in
   * rather than read here, so that answering a request never touches a disk for
   * a value that was settled when the process started (version.ts).
   */
  version: string;
  /** The origin requests arrive on, used only to parse a request's own URL. */
  publicOrigin: string;
  /** Injected so tests do not race a clock. */
  clock?: () => Date;
  /**
   * How often an idle event stream writes a comment to prove it is alive.
   * A parameter only so a test need not wait twenty seconds for one.
   */
  keepAliveMs?: number;
  /** Where the relay's own complaints go. Defaults to stderr. */
  warn?: (message: string) => void;
};

export type RelayHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void> | void;

/**
 * Build the request handler. Everything it touches is passed in, so the whole
 * sign-in flow — state, nonce, PKCE, the allowlist decision, the cookies — is
 * exercised in a test with a fake identity provider and a temp directory.
 */
export function createRelayHandler(options: RelayHandlerOptions): RelayHandler {
  const clock = options.clock ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  return async function handle(request, response) {
    const url = new URL(request.url ?? "/", options.publicOrigin);
    const method = request.method ?? "GET";

    // First, and with no session read in front of it. See the header.
    if (method === "GET" && url.pathname === RELAY_ROUTES.version) {
      const body: RelayVersion = { version: options.version, console: CONSOLE_PROTOCOL };
      return json(response, 200, body);
    }
    if (method === "GET" && url.pathname === RELAY_ROUTES.signIn) {
      return await startSignIn(response);
    }
    if (method === "GET" && url.pathname === RELAY_ROUTES.callback) {
      return await finishSignIn(request, response, url);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.signOut) {
      return signOut(request, response);
    }
    if (method === "GET" && url.pathname === RELAY_ROUTES.deviceStart) {
      return await startDeviceSignIn(response, url);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.deviceExchange) {
      return await exchangeDeviceCode(request, response);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.deviceRevoke) {
      return revokeDevice(request, response);
    }
    if (method === "GET" && url.pathname === RELAY_ROUTES.devices) {
      return listDevices(request, response);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.deviceRemove) {
      return await removeDevices(request, response);
    }
    if (method === "GET" && url.pathname === RELAY_ROUTES.me) {
      return me(request, response);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.pairingTokens) {
      return mintPairingToken(request, response);
    }
    if (method === "GET" && url.pathname === RELAY_ROUTES.deployments) {
      return listDeployments(request, response);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.testAlert) {
      return await sendTestAlert(request, response);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.forget) {
      return await forgetDeployment(request, response);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.configSet) {
      return await setConfigField(request, response);
    }
    if (method === "GET" && url.pathname === RELAY_ROUTES.events) {
      return streamEvents(request, response);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.secrets) {
      return await setSecret(request, response);
    }
    const fingerprint = deploymentIn(url.pathname);
    if (method === "GET" && fingerprint !== null) {
      return showDeployment(request, response, fingerprint);
    }
    // The console's build, last: every route above has already refused this path,
    // and the console answers only for a file it holds. `HEAD` comes along because
    // a browser and a proxy both send them for an asset.
    if (
      (method === "GET" || method === "HEAD") &&
      (await options.console.serve(url.pathname, response))
    ) {
      return;
    }
    json(response, 404, { error: "no-such-route" });
  };

  /**
   * Mint the per-sign-in secrets, park them, and send the browser to Google.
   * `device` is the companion's ask, carried in the pre-auth entry so the one
   * callback below knows which of the two landings this sign-in wants.
   */
  async function startSignIn(response: ServerResponse, device?: DeviceIntent): Promise<void> {
    const params = newAuthParams();
    const id = options.sessions.startPreAuth(
      {
        state: params.state,
        nonce: params.nonce,
        codeVerifier: params.codeVerifier,
        ...(device === undefined ? {} : { device }),
      },
      clock().getTime(),
    );
    let location: string;
    try {
      location = await options.identity.authorizationUrl({
        state: params.state,
        nonce: params.nonce,
        codeChallenge: params.codeChallenge,
      });
    } catch (error) {
      // Discovery is the first outbound call the relay ever makes; when it
      // fails the operator needs to know it was Google, not their cookie.
      warn(`[phoebe:relay] could not reach Google: ${messageOf(error)}`);
      text(response, 502, "Could not reach Google to start sign-in. Try again.");
      return;
    }
    response.setHeader("Set-Cookie", [
      setCookie(PRE_AUTH_COOKIE, id, Math.floor(PRE_AUTH_TTL_MS / 1000)),
    ]);
    redirect(response, location);
  }

  /**
   * Google's redirect back. Four gates, in order, each with its own refusal:
   * the pre-auth entry, the flow's own checks (state, nonce, PKCE, ID-token
   * claims — `openid-client`'s job), `email_verified`, and the allowlist.
   */
  async function finishSignIn(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const cookies = parseCookies(request.headers.cookie);
    const preAuth = options.sessions.takePreAuth(cookies.get(PRE_AUTH_COOKIE), clock().getTime());
    if (preAuth === null) {
      text(
        response,
        400,
        "This sign-in has expired or was not started here. Go back and sign in again.",
      );
      return;
    }

    let identity;
    try {
      identity = await options.identity.verifyCallback({
        currentUrl: url,
        expectedState: preAuth.state,
        expectedNonce: preAuth.nonce,
        codeVerifier: preAuth.codeVerifier,
      });
    } catch (error) {
      warn(`[phoebe:relay] sign-in rejected: ${messageOf(error)}`);
      text(response, 400, "Google's sign-in response did not check out. Try again.");
      return;
    }

    // Google's own wording: `email_verified` false means it took no steps to
    // confirm the address, so the address is not evidence of anything and the
    // allowlist has nothing to match.
    if (identity.email === undefined || !identity.emailVerified) {
      text(response, 403, "Sign-in needs a Google account with a verified email address.");
      return;
    }

    const admission = options.allowlist.admit(
      { sub: identity.sub, email: identity.email },
      clock(),
    );
    if (admission.kind === "refused") {
      text(response, 403, `${identity.email} is not on this relay's allowlist.`);
      return;
    }
    if (admission.kind === "seeded") {
      warn(`[phoebe:relay] allowlist seeded by first sign-in: ${admission.entry.email}`);
    }

    // A companion gets no cookie and no session row. It gets a one-time code on
    // the custom scheme, and the PKCE challenge it started with is what will
    // let exactly one process spend it (#523 §2).
    if (preAuth.device !== undefined) {
      const code = options.deviceCodes.mint(
        {
          sub: identity.sub,
          email: admission.entry.email,
          name: preAuth.device.name,
          challenge: preAuth.device.challenge,
        },
        clock().getTime(),
      );
      response.setHeader("Set-Cookie", [clearCookie(PRE_AUTH_COOKIE)]);
      redirect(response, `${COMPANION_AUTH_URL}?code=${encodeURIComponent(code)}`);
      return;
    }

    const id = options.sessions.open(
      { sub: identity.sub, email: admission.entry.email },
      clock().getTime(),
    );
    response.setHeader("Set-Cookie", [clearCookie(PRE_AUTH_COOKIE), setCookie(SESSION_COOKIE, id)]);
    redirect(response, SIGNED_IN_LANDING);
  }

  /**
   * A companion's sign-in starts here (#523 §2). It is the same Google flow the
   * browser's does — the only new things are the PKCE challenge it will be
   * asked to prove later, and the name the device will be recorded under.
   *
   * The challenge is checked for shape up front: it is the S256 of a verifier,
   * so it is 43 characters of base64url and anything else is a caller that has
   * not read the contract. Refusing here is cheaper than minting a code nobody
   * can spend.
   */
  async function startDeviceSignIn(response: ServerResponse, url: URL): Promise<void> {
    const challenge = url.searchParams.get("challenge") ?? "";
    if (!isS256Challenge(challenge)) {
      text(response, 400, "This sign-in link is missing its PKCE challenge.");
      return;
    }
    await startSignIn(response, { challenge, name: url.searchParams.get("name") ?? "" });
  }

  /**
   * Spend the one-time code for a device token (#523 §3). No cookie is involved
   * and none would survive the trip: this request comes from the companion's
   * main process, which never had one.
   *
   * Every refusal is the same 400 with the same code. The caller cannot tell an
   * expired code from a spent one from a verifier that does not match, and it
   * has no use for the difference — the only recovery from any of them is to
   * start again.
   */
  async function exchangeDeviceCode(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(request)) as { code?: unknown; verifier?: unknown };
    const grant = options.deviceCodes.spend(
      typeof body.code === "string" ? body.code : undefined,
      typeof body.verifier === "string" ? body.verifier : undefined,
      clock().getTime(),
    );
    if (grant === null) {
      json(response, 400, { error: "bad-code" });
      return;
    }
    const issued = options.devices.issue(
      { sub: grant.sub, email: grant.email },
      grant.name,
      clock(),
    );
    warn(`[phoebe:relay] ${grant.email} signed in a companion: ${issued.device.name}`);
    const result: DeviceExchangeResult = issued;
    json(response, 201, result);
  }

  /**
   * A companion signing out. It revokes the bearer it carries and nothing else,
   * which is why it needs no session lookup and answers 204 either way: the
   * caller asked for that token to stop working, and after this it has.
   */
  function revokeDevice(request: IncomingMessage, response: ServerResponse): void {
    options.devices.revoke(bearerToken(request.headers.authorization));
    response.writeHead(204).end();
  }

  /** Every companion signed in to this relay. The People page groups them (#523 §4). */
  function listDevices(request: IncomingMessage, response: ServerResponse): void {
    if (caller(request) === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    json(response, 200, { devices: options.devices.list() });
  }

  /**
   * Revoke devices: one by `id`, or every one of a person's by `sub` — which is
   * what removing them from the allowlist has to do, since an allowlist they
   * are off does not get consulted again by a bearer they already hold.
   *
   * No self-check. A person revoking their own companion from the console is
   * doing a reasonable thing, and the console they are doing it from is a
   * browser session this does not touch.
   */
  async function removeDevices(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const who = caller(request);
    if (who === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const body = (await readJsonBody(request)) as { id?: unknown; sub?: unknown };
    const selector =
      typeof body.id === "string" && body.id !== ""
        ? { id: body.id }
        : typeof body.sub === "string" && body.sub !== ""
          ? { sub: body.sub }
          : null;
    if (selector === null) {
      json(response, 400, { error: "no-device" });
      return;
    }
    const removed = options.devices.remove(selector);
    if (removed === 0) {
      json(response, 404, { error: "no-such-device" });
      return;
    }
    warn(`[phoebe:relay] ${who.email} revoked ${removed} device(s)`);
    json(response, 200, { removed });
  }

  /**
   * Drop the session. POST, not GET, so a link cannot sign someone out, and
   * `SameSite=Lax` keeps the cookie off a cross-site POST, which is the whole
   * CSRF defence this route needs.
   */
  function signOut(request: IncomingMessage, response: ServerResponse): void {
    options.sessions.close(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    response.setHeader("Set-Cookie", [clearCookie(SESSION_COOKIE)]);
    response.writeHead(204).end();
  }

  /**
   * Mint one pairing token (#540). POST, behind the session, and the only time
   * the token's characters exist outside the operator's clipboard: the relay
   * keeps the string only until it is spent, and answers this request with it
   * once. A caller who loses it mints another — they cost nothing and expire on
   * their own.
   */
  function mintPairingToken(request: IncomingMessage, response: ServerResponse): void {
    const who = caller(request);
    if (who === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const minted = options.tokens.mint(who.email, clock());
    warn(`[phoebe:relay] ${who.email} minted a pairing token`);
    json(response, 201, minted);
  }

  /**
   * The authenticated read: who is asking. The one route whose answer is the
   * credential itself working, which is what makes it the read a companion runs
   * straight after an exchange and a browser runs on every page load.
   */
  function me(request: IncomingMessage, response: ServerResponse): void {
    const who = caller(request);
    if (who === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    json(response, 200, who);
  }

  /**
   * Who is asking, whichever carrier they used (#523 §3). The cookie is tried
   * first because a browser is the common case and its lookup touches no disk;
   * the bearer is a read of `devices.json` and a stamp of `lastSeenAt`, which is
   * the only write any read on this handler does.
   */
  function caller(request: IncomingMessage): RelayIdentity | null {
    const session = options.sessions.get(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    if (session !== null) return { sub: session.sub, email: session.email };
    const device = options.devices.authenticate(
      bearerToken(request.headers.authorization),
      clock(),
    );
    return device === null ? null : { sub: device.sub, email: device.email };
  }

  /**
   * The fleet, as facts rather than a score (#507 §9): one row per link, each
   * carrying where the relay holds it. Sorting and wording are the console's;
   * this route's job is to state what is true at the moment it is asked.
   */
  function listDeployments(request: IncomingMessage, response: ServerResponse): void {
    if (caller(request) === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    json(response, 200, {
      deployments: options.fleet().rows(clock()),
      alerts: options.alerts.facts(),
    });
  }

  /**
   * **Send test alert** (#515 §13): a `{ kind: "test" }` body to every sink, so
   * an operator can tell a working webhook from a healthy fleet. Fleet-wide and
   * bodiless — the question is about the channel, not about a deployment — and
   * it answers with how many sinks took it, which is the only honest report
   * available when delivery is one attempt with no retry.
   */
  async function sendTestAlert(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = options.sessions.get(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    if (session === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const sent = await options.alerts.test(session.email);
    warn(`[phoebe:relay] ${session.email} sent a test alert to ${sent.sinks} sink(s)`);
    json(response, 202, sent);
  }

  /**
   * One deployment: the row the fleet read would have shown, and the last
   * report it pushed (#542). Two sources side by side, never merged — the
   * relay's connection facts are the relay's, and the report is the
   * deployment's own derivation, carried through unread.
   *
   * A deployment with no report yet is a 200 with `report: null`, not a 404.
   * The link exists, the console has a row to draw, and "paired but has not
   * reported" is a state an operator needs to see rather than a missing page.
   */
  function showDeployment(
    request: IncomingMessage,
    response: ServerResponse,
    fingerprint: string,
  ): void {
    if (caller(request) === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const row = options
      .fleet()
      .rows(clock())
      .find((candidate) => candidate.fingerprint === fingerprint);
    if (row === undefined) {
      json(response, 404, { error: "no-such-deployment" });
      return;
    }
    const detail: RelayDeploymentDetail = {
      deployment: row,
      report: options.reports.find(fingerprint),
    };
    json(response, 200, detail);
  }

  /**
   * The event stream (#506 §10). One connection per open console, held until the
   * browser goes away, carrying reports and connection changes as they happen.
   *
   * Three things make it survive the trip. The stream starts with a comment, so
   * a proxy sees bytes immediately rather than buffering a response it thinks
   * has not started. A comment goes out on the heartbeat's cadence for the same
   * reason, and it is what keeps an idle stream from being reaped as dead. And
   * `X-Accel-Buffering: no` tells the buffering proxies that read it not to,
   * because a buffered event stream is a stream that arrives all at once,
   * minutes late, which is worse than no stream.
   */
  function streamEvents(request: IncomingMessage, response: ServerResponse): void {
    if (caller(request) === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(": watching\n\n");

    const unsubscribe = options.events.subscribe((event: RelayEvent) => {
      // A throw here is how the hub learns this browser is gone: it drops the
      // listener rather than carrying a dead response into the next event.
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    let beat: ReturnType<typeof setInterval> | null = null;
    const close = (): void => {
      if (beat !== null) clearInterval(beat);
      beat = null;
      unsubscribe();
    };
    beat = setInterval(() => {
      // A session that expired, or a device that was revoked mid-stream, does
      // not get to keep reading the fleet. The stream ends, and the reader's
      // reconnect lands on the 401 its next request would have got anyway.
      if (caller(request) === null) {
        close();
        response.end();
        return;
      }
      response.write(": beat\n\n");
    }, options.keepAliveMs ?? RELAY_HEARTBEAT_MS);
    beat.unref?.();

    request.on("close", close);
    response.on("close", close);
  }

  /**
   * Set or clear one tenant secret on a deployment (#550, decided in #504).
   *
   * **The relay's whole job here is carrying and stamping.** The envelope came
   * out of a browser sealed to the deployment's box key; this route forwards the
   * string without parsing it, and could not open it if it tried — the private
   * half is on the deployment's volume and has never been anywhere else. What
   * the relay adds is `by`, read from its own session: the person a deployment
   * records in its secret ledger is the person Google signed in, never a field a
   * caller supplied.
   *
   * **The id is the relay's too.** It is the ledger entry's id on the
   * deployment and the `editId` the browser bound into the envelope's AAD, so
   * the console has to have it before it seals — which is why a caller sends
   * one and the relay uses it as given. A caller that omits it gets one, which
   * only a `clear` can make use of: a set sealed against a different id will
   * not open.
   *
   * The answer is whatever came back: `written`, `refused`, or
   * `undelivered`. The relay adds no verdict of its own, because it has none —
   * it never learns whether what it carried was a secret at all.
   */
  async function setSecret(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = options.sessions.get(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    if (session === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const body = (await readJsonBody(request)) as {
      fingerprint?: unknown;
      tenant?: unknown;
      key?: unknown;
      action?: unknown;
      envelope?: unknown;
      id?: unknown;
    };
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
    if (!isFingerprint(fingerprint)) {
      json(response, 400, { error: "no-fingerprint" });
      return;
    }
    const tenant = typeof body.tenant === "string" ? body.tenant : "";
    const key = typeof body.key === "string" ? body.key : "";
    if (tenant === "" || key === "") {
      json(response, 400, { error: "no-tenant-or-key" });
      return;
    }
    const action = body.action === "clear" ? "clear" : "set";
    const envelope = typeof body.envelope === "string" ? body.envelope : "";
    if (action === "set" && envelope === "") {
      json(response, 400, { error: "no-envelope" });
      return;
    }
    const row = options
      .fleet()
      .rows(clock())
      .find((candidate) => candidate.fingerprint === fingerprint);
    if (row === undefined) {
      json(response, 404, { error: "no-such-deployment" });
      return;
    }

    const message: RelaySecretSet = {
      type: RELAY_MESSAGES.secretSet,
      id: typeof body.id === "string" && body.id.length > 0 ? body.id : randomUUID(),
      tenant,
      key,
      action,
      ...(action === "set" ? { envelope } : {}),
      by: session.email,
    };
    // The key's name is logged and its value is not, because the relay does not
    // have its value and this is the line that proves it.
    warn(
      `[phoebe:relay] ${session.email} asked ${row.name} (${fingerprint}) to ${action} ` +
        `${key} for ${tenant} (edit ${message.id})`,
    );
    const receipt = await options.fleet().request(fingerprint, message);
    json(response, 200, {
      id: receipt.id,
      outcome: receipt.outcome,
      ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
    });
  }

  /**
   * **Forget** one deployment (#505 §4). The link goes, the live connection is
   * closed with `unlinked`, and the deployment stops dialling — three effects
   * of one deletion, because the link is the only thing that admitted it.
   *
   * A fingerprint the relay does not know is a 404 rather than a silent 200: an
   * operator forgetting the wrong deployment wants to hear about it, and the
   * answer "there was nothing there" is the useful one either way.
   */
  async function forgetDeployment(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const who = caller(request);
    if (who === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const body = await readJsonBody(request);
    const fingerprint = (body as { fingerprint?: unknown }).fingerprint;
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      json(response, 400, { error: "no-fingerprint" });
      return;
    }
    const link = options.fleet().forget(fingerprint);
    if (link === null) {
      json(response, 404, { error: "no-such-deployment" });
      return;
    }
    warn(`[phoebe:relay] ${who.email} forgot ${link.name} (${link.fingerprint})`);
    json(response, 200, { forgotten: { fingerprint: link.fingerprint, name: link.name } });
  }

  /**
   * One field of one deployment's root config, as a person asked for it (#503,
   * #547).
   *
   * The body is checked to the letter before anything leaves this process. A
   * value that is not a literal, a missing config fingerprint, a path that is not
   * a string: each is a 400 rather than a patch sent on to be refused at the far
   * end, because the deployment's refusals are about its file and these are about
   * this request.
   *
   * The one field the relay writes is `by`. It is the session's address and never
   * the body's — a console that could name the editor would be able to sign
   * somebody else's name to an edit in the ledger.
   *
   * A deployment the relay has no link for is a 404, the same as the read on
   * `/api/deployments/<fingerprint>`. One the relay knows but cannot reach is a
   * 200 carrying `undelivered`: the ask was well formed and the answer is that it
   * did not arrive, which is a fact about the deployment rather than about the
   * request.
   */
  async function setConfigField(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = options.sessions.get(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    if (session === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const edit = readConfigSet(await readJsonBody(request));
    if (edit === null) {
      json(response, 400, { error: "malformed-edit" });
      return;
    }
    const known = options
      .fleet()
      .rows(clock())
      .some((row) => row.fingerprint === edit.fingerprint);
    if (!known) {
      json(response, 404, { error: "no-such-deployment" });
      return;
    }
    const receipt = await options.fleet().request(edit.fingerprint, {
      type: RELAY_MESSAGES.configSet,
      id: edit.id,
      path: edit.path,
      value: edit.value,
      fingerprint: edit.configFingerprint,
      by: session.email,
    });
    warn(
      `[phoebe:relay] ${session.email} set ${edit.path} on ${edit.fingerprint} — ` +
        `${receipt.outcome}`,
    );
    const answer: RelayConfigSetAnswer =
      receipt.outcome === RELAY_UNDELIVERED
        ? { outcome: RELAY_UNDELIVERED }
        : { outcome: receipt.outcome, receipt: receipt.detail };
    json(response, 200, answer);
  }
}

/**
 * Whether a string is the S256 of a PKCE verifier: 43 characters of base64url,
 * which is what a 256-bit digest encodes to with no padding (RFC 7636).
 */
export function isS256Challenge(challenge: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

/**
 * The fingerprint in `/api/deployments/<fingerprint>`, or null when the path is
 * not that (#542).
 *
 * The check is the fingerprint's own shape — 32 characters of base64url, what
 * `fingerprintOf` produces — and it is a security boundary, not a nicety: the
 * relay names a file after this string, so a path segment that is not exactly a
 * fingerprint must never reach the volume. It also keeps `/api/deployments/forget`
 * from ever reading as a deployment named "forget".
 */
export function deploymentIn(pathname: string): string | null {
  const prefix = `${RELAY_ROUTES.deployments}/`;
  if (!pathname.startsWith(prefix)) return null;
  let fingerprint: string;
  try {
    fingerprint = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    // A percent sign followed by nothing is not a fingerprint either.
    return null;
  }
  return isFingerprint(fingerprint) ? fingerprint : null;
}

/**
 * One request body as JSON, or `{}` for anything that is not. Capped, because
 * this endpoint is behind a session but the body arrives before the relay has
 * decided anything and an unbounded read is an unbounded allocation.
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const limit = 64 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) return {};
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return {};
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      // Nothing the relay says about a session belongs in a cache.
      "cache-control": "no-store",
    })
    .end(payload);
}

/**
 * Plain text, not JSON, for the sign-in refusals: those land in a person's
 * browser as the visible end of a redirect from Google, and a sentence is what
 * they can act on. Everything under `/api` stays JSON.
 */
function text(response: ServerResponse, status: number, body: string): void {
  const payload = `${body}\n`;
  response
    .writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    })
    .end(payload);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" }).end();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One config-set body, or null when it is not one (#547).
 *
 * Strict about every field, and about the value most of all: a leaf is a
 * literal, so an object or an array arriving under `value` is a malformed
 * request rather than something to splice into a file. `undefined` is not a
 * literal either — JSON cannot carry it, and a body that omitted the field
 * would otherwise read as "set this to nothing".
 *
 * `by` is deliberately not read. The relay stamps the session's address, so a
 * body that carried one is ignored rather than refused: the field a caller
 * cannot influence is better than a field a caller learns to leave out.
 */
export function readConfigSet(body: unknown): RelayConfigSetRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Partial<RelayConfigSetRequest>;
  const strings = [
    candidate.fingerprint,
    candidate.id,
    candidate.path,
    candidate.configFingerprint,
  ];
  if (strings.some((field) => typeof field !== "string" || field.length === 0)) return null;
  if (!isFingerprint(candidate.fingerprint as string)) return null;
  const value = candidate.value;
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) return null;
  return {
    fingerprint: candidate.fingerprint as string,
    id: candidate.id as string,
    path: candidate.path as string,
    value: value as RelayConfigSetRequest["value"],
    configFingerprint: candidate.configFingerprint as string,
  };
}
