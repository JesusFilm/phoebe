// The relay's HTTP surface: the sign-in flow, and the reads and verbs behind it
// (#538, #540, #541, #551).
//
// There are no pages here yet. What a signed-in person can ask for is who they
// are, a pairing token for a new deployment, the fleet as the socket endpoint
// knows it — with what the relay last alerted about each link — the forgetting
// of one deployment, and one test alert. The console's pages sit on exactly
// these answers.
//
// The shape every route follows is set here: paths come from contracts, the
// session is read from a `__Host-` cookie, and anything behind the door answers
// an unknown caller with 401 rather than a redirect. A browser fetching JSON
// wants a status code it can branch on, not an HTML login page delivered with
// a 200.

import type { IncomingMessage, ServerResponse } from "node:http";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type { RelayDeploymentRow, RelayIdentity } from "../src/contracts/relay-routes.ts";
import type { RelayAlertFacts } from "../src/contracts/alerts.ts";
import type { Allowlist } from "./allowlist.ts";
import type { Link, PairingTokens } from "./links.ts";
import { newAuthParams, type IdentityProvider } from "./oidc.ts";
import {
  clearCookie,
  parseCookies,
  PRE_AUTH_COOKIE,
  PRE_AUTH_TTL_MS,
  SESSION_COOKIE,
  setCookie,
  type SessionStore,
} from "./sessions.ts";

/**
 * Where a completed sign-in lands. The console's own page takes this over when
 * there is one; today the honest destination is the proof that the session
 * works.
 */
export const SIGNED_IN_LANDING: string = RELAY_ROUTES.me;

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
  };
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
  identity: IdentityProvider;
  /** The origin requests arrive on, used only to parse a request's own URL. */
  publicOrigin: string;
  /** Injected so tests do not race a clock. */
  clock?: () => Date;
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

    if (method === "GET" && url.pathname === RELAY_ROUTES.signIn) {
      return await startSignIn(response);
    }
    if (method === "GET" && url.pathname === RELAY_ROUTES.callback) {
      return await finishSignIn(request, response, url);
    }
    if (method === "POST" && url.pathname === RELAY_ROUTES.signOut) {
      return signOut(request, response);
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
    json(response, 404, { error: "no-such-route" });
  };

  /** Mint the per-sign-in secrets, park them, and send the browser to Google. */
  async function startSignIn(response: ServerResponse): Promise<void> {
    const params = newAuthParams();
    const id = options.sessions.startPreAuth(
      { state: params.state, nonce: params.nonce, codeVerifier: params.codeVerifier },
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

    const id = options.sessions.open(
      { sub: identity.sub, email: admission.entry.email },
      clock().getTime(),
    );
    response.setHeader("Set-Cookie", [clearCookie(PRE_AUTH_COOKIE), setCookie(SESSION_COOKIE, id)]);
    redirect(response, SIGNED_IN_LANDING);
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
    const session = options.sessions.get(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    if (session === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const minted = options.tokens.mint(session.email, clock());
    warn(`[phoebe:relay] ${session.email} minted a pairing token`);
    json(response, 201, minted);
  }

  /** The authenticated read: who the cookie belongs to. */
  function me(request: IncomingMessage, response: ServerResponse): void {
    const session = options.sessions.get(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    if (session === null) {
      json(response, 401, { error: "not-signed-in" });
      return;
    }
    const identity: RelayIdentity = { sub: session.sub, email: session.email };
    json(response, 200, identity);
  }

  /**
   * The fleet, as facts rather than a score (#507 §9): one row per link, each
   * carrying where the relay holds it. Sorting and wording are the console's;
   * this route's job is to state what is true at the moment it is asked.
   */
  function listDeployments(request: IncomingMessage, response: ServerResponse): void {
    const session = options.sessions.get(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    if (session === null) {
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
    const session = options.sessions.get(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    if (session === null) {
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
    warn(`[phoebe:relay] ${session.email} forgot ${link.name} (${link.fingerprint})`);
    json(response, 200, { forgotten: { fingerprint: link.fingerprint, name: link.name } });
  }
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
