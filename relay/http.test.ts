// The door, end to end: a real listener, real cookies, a fake Google.
//
// The identity provider is the only thing stubbed, because the only thing on
// the far side of it is the network. Everything the relay is responsible for —
// the state/nonce/PKCE triple, the pre-auth cookie's single use, the
// `email_verified` gate, the allowlist decision, the session cookie, and the
// 401 on the way in — runs for real against a bound port.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { CONSOLE_PROTOCOL } from "../src/contracts/console-protocol.ts";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type { RelayEnv } from "./env.ts";
import { SIGNED_IN_LANDING } from "./http.ts";
import {
  pkceChallenge,
  type AuthParams,
  type GoogleIdentity,
  type IdentityProvider,
} from "./oidc.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "./sessions.ts";
import { startRelay, type RunningRelay } from "./serve.ts";

const ADA: GoogleIdentity = { sub: "sub-ada", email: "Ada@example.test", emailVerified: true };

type Recorder = {
  authorizationUrl: Omit<AuthParams, "codeVerifier"> | null;
  verifyCallback: { expectedState: string; expectedNonce: string; codeVerifier: string } | null;
};

/** A Google that says whatever the test needs it to say. */
function fakeGoogle(result: GoogleIdentity | Error): {
  provider: IdentityProvider;
  seen: Recorder;
} {
  const seen: Recorder = { authorizationUrl: null, verifyCallback: null };
  return {
    seen,
    provider: {
      authorizationUrl(params) {
        seen.authorizationUrl = params;
        return Promise.resolve(
          `https://accounts.google.test/o/oauth2/v2/auth?state=${encodeURIComponent(params.state)}`,
        );
      },
      verifyCallback({ expectedState, expectedNonce, codeVerifier }) {
        seen.verifyCallback = { expectedState, expectedNonce, codeVerifier };
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
  };
}

function env(overrides: Partial<RelayEnv> = {}): RelayEnv {
  return {
    host: "localhost",
    clientId: "client-id",
    clientSecret: "client-secret",
    allowedEmails: [],
    ...overrides,
  };
}

describe("the relay's door", () => {
  let dataDir: string;
  let relay: RunningRelay | null = null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-"));
  });

  afterEach(async () => {
    await relay?.close();
    relay = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function serve(
    identity: IdentityProvider,
    overrides: Partial<RelayEnv> = {},
  ): Promise<string> {
    relay = await startRelay({
      env: env(overrides),
      dataDir,
      port: 0,
      identity,
      log: () => {},
      warn: () => {},
    });
    return `http://127.0.0.1:${relay.port}`;
  }

  /** The `Set-Cookie` value for `name`, or null. */
  function cookie(response: Response, name: string): string | null {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const [cookieName, ...rest] = pair!.split("=");
      if (cookieName === name) return decodeURIComponent(rest.join("="));
    }
    return null;
  }

  /** Walk the whole flow and hand back the session cookie value. */
  async function signIn(origin: string): Promise<Response> {
    const started = await fetch(`${origin}${RELAY_ROUTES.signIn}`, { redirect: "manual" });
    const preAuth = cookie(started, PRE_AUTH_COOKIE);
    return await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: { cookie: `${PRE_AUTH_COOKIE}=${encodeURIComponent(preAuth ?? "")}` },
    });
  }

  test("sign-in redirects to Google with state, nonce and a PKCE challenge", async () => {
    const { provider, seen } = fakeGoogle(ADA);
    const origin = await serve(provider);

    const response = await fetch(`${origin}${RELAY_ROUTES.signIn}`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("accounts.google.test");
    expect(seen.authorizationUrl?.state).toEqual(expect.any(String));
    expect(seen.authorizationUrl?.nonce).toEqual(expect.any(String));
    expect(seen.authorizationUrl?.codeChallenge).toEqual(expect.any(String));
    expect(cookie(response, PRE_AUTH_COOKIE)).toEqual(expect.any(String));
  });

  test("the callback is checked against the very values the redirect carried", async () => {
    const { provider, seen } = fakeGoogle(ADA);
    const origin = await serve(provider);

    await signIn(origin);

    expect(seen.verifyCallback?.expectedState).toBe(seen.authorizationUrl?.state);
    expect(seen.verifyCallback?.expectedNonce).toBe(seen.authorizationUrl?.nonce);
    // The verifier never left the relay; only its hash went to Google.
    expect(pkceChallenge(seen.verifyCallback!.codeVerifier)).toBe(
      seen.authorizationUrl?.codeChallenge,
    );
  });

  test("a first verified login seeds the allowlist and gets a session", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);

    const response = await signIn(origin);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED_IN_LANDING);
    expect(cookie(response, SESSION_COOKIE)).toEqual(expect.any(String));
    // The pre-auth cookie is withdrawn on the way out.
    expect(cookie(response, PRE_AUTH_COOKIE)).toBe("");
  });

  test("a signed-in, allowlisted person gets JSON from the authenticated route", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);
    const session = cookie(await signIn(origin), SESSION_COOKIE);

    const response = await fetch(`${origin}${RELAY_ROUTES.me}`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session ?? "")}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ sub: "sub-ada", email: "ada@example.test" });
  });

  test("no cookie is 401", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);

    const response = await fetch(`${origin}${RELAY_ROUTES.me}`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not-signed-in" });
  });

  test("a made-up cookie is 401, not a session", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);

    const response = await fetch(`${origin}${RELAY_ROUTES.me}`, {
      headers: { cookie: `${SESSION_COOKIE}=guessed` },
    });

    expect(response.status).toBe(401);
  });

  test("someone off the allowlist is refused with 403 and no session", async () => {
    const { provider } = fakeGoogle({
      sub: "sub-eve",
      email: "eve@example.test",
      emailVerified: true,
    });
    const origin = await serve(provider, { allowedEmails: ["ada@example.test"] });

    const response = await signIn(origin);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("eve@example.test");
    expect(cookie(response, SESSION_COOKIE)).toBeNull();
  });

  test("an unverified email is refused even when the address is on the list", async () => {
    const { provider } = fakeGoogle({ ...ADA, emailVerified: false });
    const origin = await serve(provider, { allowedEmails: ["ada@example.test"] });

    const response = await signIn(origin);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("verified email");
  });

  test("a callback whose checks fail is 400, and Google's reason stays out of the body", async () => {
    const { provider } = fakeGoogle(new Error("state mismatch: expected abc, got def"));
    const origin = await serve(provider);

    const response = await signIn(origin);

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("state mismatch");
  });

  test("a callback with no pre-auth cookie is 400", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);

    const response = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
    });

    expect(response.status).toBe(400);
  });

  test("a pre-auth cookie cannot be replayed", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);
    const started = await fetch(`${origin}${RELAY_ROUTES.signIn}`, { redirect: "manual" });
    const header = `${PRE_AUTH_COOKIE}=${encodeURIComponent(cookie(started, PRE_AUTH_COOKIE) ?? "")}`;

    const first = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: { cookie: header },
    });
    const replay = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: { cookie: header },
    });

    expect(first.status).toBe(302);
    expect(replay.status).toBe(400);
  });

  test("signing out ends the session", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);
    const session = cookie(await signIn(origin), SESSION_COOKIE);
    const header = { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session ?? "")}` };

    const signedOut = await fetch(`${origin}${RELAY_ROUTES.signOut}`, {
      method: "POST",
      headers: header,
    });

    expect(signedOut.status).toBe(204);
    expect((await fetch(`${origin}${RELAY_ROUTES.me}`, { headers: header })).status).toBe(401);
  });

  test("an unknown path is 404 JSON, not an HTML page", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);

    const response = await fetch(`${origin}/nope`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("the authenticated read is never cached", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);

    const response = await fetch(`${origin}${RELAY_ROUTES.me}`);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("the fleet read is behind the session, and empty on a relay with no links", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);

    expect((await fetch(`${origin}${RELAY_ROUTES.deployments}`)).status).toBe(401);

    const session = cookie(await signIn(origin), SESSION_COOKIE);
    const response = await fetch(`${origin}${RELAY_ROUTES.deployments}`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session ?? "")}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deployments: [] });
  });

  test("forgetting is behind the session too", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);

    const response = await fetch(`${origin}${RELAY_ROUTES.forget}`, {
      method: "POST",
      body: JSON.stringify({ fingerprint: "fp-anything" }),
    });

    expect(response.status).toBe(401);
  });

  test("forgetting a deployment this relay never knew is 404", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);
    const session = cookie(await signIn(origin), SESSION_COOKIE);

    const response = await fetch(`${origin}${RELAY_ROUTES.forget}`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session ?? "")}` },
      body: JSON.stringify({ fingerprint: "fp-nobody" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no-such-deployment" });
  });

  test("and a forget with no fingerprint is a 400 rather than a guess", async () => {
    const { provider } = fakeGoogle(ADA);
    const origin = await serve(provider);
    const session = cookie(await signIn(origin), SESSION_COOKIE);

    const response = await fetch(`${origin}${RELAY_ROUTES.forget}`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session ?? "")}` },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no-fingerprint" });
  });
});

describe("the console the relay serves", () => {
  let dataDir: string;
  let consoleDir: string;
  let relay: RunningRelay | null = null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-"));
    consoleDir = mkdtempSync(join(tmpdir(), "phoebe-console-"));
    writeFileSync(join(consoleDir, "index.html"), "<!doctype html><title>Phoebe console</title>\n");
  });

  afterEach(async () => {
    await relay?.close();
    relay = null;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(consoleDir, { recursive: true, force: true });
  });

  async function serveWithConsole(): Promise<string> {
    relay = await startRelay({
      env: env(),
      dataDir,
      consoleDir,
      port: 0,
      identity: fakeGoogle(ADA).provider,
      log: () => {},
      warn: () => {},
    });
    return `http://127.0.0.1:${relay.port}`;
  }

  test("a browser at the root gets the console, signed in or not", async () => {
    // The bundle has to be reachable without a session: the sign-in control is
    // part of it, and the reads behind it answer 401 on their own.
    const response = await fetch(`${await serveWithConsole()}/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Phoebe console");
  });

  test("a completed sign-in lands on the console rather than on a JSON read", async () => {
    const origin = await serveWithConsole();

    const started = await fetch(`${origin}${RELAY_ROUTES.signIn}`, { redirect: "manual" });
    const [pair] = (started.headers.getSetCookie()[0] ?? "").split(";");
    const finished = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: { cookie: pair ?? "" },
    });

    expect(finished.headers.get("location")).toBe(SIGNED_IN_LANDING);
    expect(SIGNED_IN_LANDING).not.toBe(RELAY_ROUTES.me);
  });

  test("the API still refuses an unknown path in JSON rather than serving a page", async () => {
    const origin = await serveWithConsole();

    const response = await fetch(`${origin}${RELAY_ROUTES.deployments}/not-a-fingerprint`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no-such-route" });
  });
});

describe("the version handshake", () => {
  let dataDir: string;
  let relay: RunningRelay | null = null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-"));
  });

  afterEach(async () => {
    await relay?.close();
    relay = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function serveVersion(version?: string): Promise<string> {
    relay = await startRelay({
      env: env(),
      dataDir,
      port: 0,
      identity: fakeGoogle(ADA).provider,
      ...(version !== undefined ? { version } : {}),
      log: () => {},
      warn: () => {},
    });
    return `http://127.0.0.1:${relay.port}`;
  }

  test("answers the package version and the console protocol, with no session", async () => {
    const response = await fetch(`${await serveVersion("9.9.9")}${RELAY_ROUTES.version}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: "9.9.9", console: CONSOLE_PROTOCOL });
  });

  test("a cookie is neither sent nor asked for — this is the read that precedes one", async () => {
    // The whole point of the route (#525 §4): a companion too new for this relay
    // learns so before it has anywhere to put a session. A 401 here would make
    // the refusal unreachable in exactly the case it exists for.
    const response = await fetch(`${await serveVersion()}${RELAY_ROUTES.version}`, {
      headers: { cookie: "" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("reports the relay's real version when nobody passed one", async () => {
    const response = await fetch(`${await serveVersion()}${RELAY_ROUTES.version}`);

    // The relay versions with the bootstrapper, so this is the root package's.
    expect(((await response.json()) as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("the answer is not cached — a relay is upgraded under an open window", async () => {
    const response = await fetch(`${await serveVersion()}${RELAY_ROUTES.version}`);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("only GET; a POST to it falls through to the JSON 404", async () => {
    const response = await fetch(`${await serveVersion()}${RELAY_ROUTES.version}`, {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no-such-route" });
  });
});
