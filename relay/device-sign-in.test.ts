// The companion's sign-in, end to end against a bound port (#523 §2, #554).
//
// The same harness the browser's door runs under: a real listener, a real
// volume, and a fake Google, because the only thing on the far side of that seam
// is the network. What is new here is the shape of the trip — no cookie goes
// out, the landing is a custom scheme, and what comes back is a bearer.
//
// The cases worth a test are the ones a mistake would be silent in: a code that
// works twice, a code spent without the verifier that started it, a bearer that
// opens the same doors a cookie does, and a revoke that actually ends it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { COMPANION_AUTH_URL, RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type { RelayDevice } from "../src/contracts/relay-routes.ts";
import type { RelayEnv } from "./env.ts";
import { pkceChallenge, type GoogleIdentity, type IdentityProvider } from "./oidc.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "./sessions.ts";
import { startRelay, type RunningRelay } from "./serve.ts";

const ADA: GoogleIdentity = { sub: "sub-ada", email: "ada@example.test", emailVerified: true };
const VERIFIER = "companion-verifier-that-is-forty-three-chars";

/** A Google that always says Ada. */
function fakeGoogle(who: GoogleIdentity = ADA): IdentityProvider {
  return {
    authorizationUrl: (params) =>
      Promise.resolve(`https://accounts.google.test/auth?state=${params.state}`),
    verifyCallback: () => Promise.resolve(who),
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

describe("a companion signing in", () => {
  let dataDir: string;
  let relay: RunningRelay | null = null;
  let origin: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-device-"));
    relay = await startRelay({
      env: env(),
      dataDir,
      port: 0,
      identity: fakeGoogle(),
      log: () => {},
      warn: () => {},
    });
    origin = `http://127.0.0.1:${relay.port}`;
  });

  afterEach(async () => {
    await relay?.close();
    relay = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The `Set-Cookie` value for `name`, or null. */
  function cookie(response: Response, name: string): string | null {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const [cookieName, ...rest] = pair!.split("=");
      if (cookieName === name) return decodeURIComponent(rest.join("="));
    }
    return null;
  }

  /** Walk the browser half of the flow and hand back the one-time code. */
  async function codeFor(verifier = VERIFIER, name = "ada-mbp (macOS)"): Promise<string> {
    const start = new URL(RELAY_ROUTES.deviceStart, origin);
    start.searchParams.set("challenge", pkceChallenge(verifier));
    start.searchParams.set("name", name);
    const started = await fetch(start, { redirect: "manual" });
    const preAuth = cookie(started, PRE_AUTH_COOKIE);
    const landed = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: { cookie: `${PRE_AUTH_COOKIE}=${encodeURIComponent(preAuth ?? "")}` },
    });
    return new URL(landed.headers.get("location") ?? "").searchParams.get("code") ?? "";
  }

  /** Spend a code. */
  function exchange(code: string, verifier = VERIFIER): Promise<Response> {
    return fetch(`${origin}${RELAY_ROUTES.deviceExchange}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier }),
    });
  }

  /** The whole flow, ending in a working bearer. */
  async function signIn(name?: string): Promise<{ token: string; device: RelayDevice }> {
    const response = await exchange(await codeFor(VERIFIER, name));
    return (await response.json()) as { token: string; device: RelayDevice };
  }

  test("the start is the same Google flow, and the landing is the custom scheme", async () => {
    const start = new URL(RELAY_ROUTES.deviceStart, origin);
    start.searchParams.set("challenge", pkceChallenge(VERIFIER));
    start.searchParams.set("name", "ada-mbp");

    const started = await fetch(start, { redirect: "manual" });
    const preAuth = cookie(started, PRE_AUTH_COOKIE);
    const landed = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: { cookie: `${PRE_AUTH_COOKIE}=${encodeURIComponent(preAuth ?? "")}` },
    });

    expect(started.headers.get("location")).toContain("accounts.google.test");
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toContain(`${COMPANION_AUTH_URL}?code=`);
    // No session cookie: a companion is not a browser and gets no session row.
    expect(cookie(landed, SESSION_COOKIE)).toBeNull();
  });

  test("a start with no PKCE challenge is refused before Google is involved", async () => {
    const response = await fetch(`${origin}${RELAY_ROUTES.deviceStart}`, { redirect: "manual" });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("PKCE challenge");
  });

  test("the code buys a device token, and the token is not what the relay stored", async () => {
    const response = await exchange(await codeFor());
    const body = (await response.json()) as { token: string; device: RelayDevice };

    expect(response.status).toBe(201);
    expect(body.token).toEqual(expect.any(String));
    expect(body.device).toMatchObject({
      sub: "sub-ada",
      email: "ada@example.test",
      name: "ada-mbp (macOS)",
      lastSeenAt: null,
    });
  });

  test("the code is single use", async () => {
    const code = await codeFor();
    await exchange(code);

    const second = await exchange(code);

    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "bad-code" });
  });

  test("a code spent without the verifier that started it is refused", async () => {
    // This is the whole of what makes the scheme hop safe: any app on the
    // machine can register `phoebe://` and be handed the code, and only the one
    // that started the flow holds the verifier (#523 §2).
    const response = await exchange(await codeFor(), "some-other-verifier-forty-three-characters");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad-code" });
  });

  test("the bearer opens the same doors the cookie does", async () => {
    const { token } = await signIn();
    const headers = { authorization: `Bearer ${token}` };

    const me = await fetch(`${origin}${RELAY_ROUTES.me}`, { headers });
    const fleet = await fetch(`${origin}${RELAY_ROUTES.deployments}`, { headers });

    expect(await me.json()).toEqual({ sub: "sub-ada", email: "ada@example.test" });
    expect(fleet.status).toBe(200);
  });

  test("a made-up bearer is 401, not a session", async () => {
    const response = await fetch(`${origin}${RELAY_ROUTES.me}`, {
      headers: { authorization: "Bearer guessed" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not-signed-in" });
  });

  test("a device is listed with who it belongs to and when it was last seen", async () => {
    const { token, device } = await signIn();

    const response = await fetch(`${origin}${RELAY_ROUTES.devices}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { devices: RelayDevice[] };

    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ id: device.id, email: "ada@example.test" });
    // Reading the list carried the bearer, so the device has now been seen.
    expect(body.devices[0]?.lastSeenAt).toEqual(expect.any(String));
    expect(body.devices[0]).not.toHaveProperty("tokenHash");
  });

  test("the device list is behind the door like every other read", async () => {
    expect((await fetch(`${origin}${RELAY_ROUTES.devices}`)).status).toBe(401);
  });

  test("revoke ends the token, and it is the last thing that token can do", async () => {
    const { token } = await signIn();
    const headers = { authorization: `Bearer ${token}` };

    const revoked = await fetch(`${origin}${RELAY_ROUTES.deviceRevoke}`, {
      method: "POST",
      headers,
    });
    const after = await fetch(`${origin}${RELAY_ROUTES.me}`, { headers });

    expect(revoked.status).toBe(204);
    expect(after.status).toBe(401);
  });

  test("removing by id revokes one device from the console", async () => {
    const mine = await signIn("ada-mbp");
    const other = await signIn("ada-desktop");

    const removed = await fetch(`${origin}${RELAY_ROUTES.deviceRemove}`, {
      method: "POST",
      headers: { authorization: `Bearer ${mine.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: other.device.id }),
    });

    expect(await removed.json()).toEqual({ removed: 1 });
    expect(
      (
        await fetch(`${origin}${RELAY_ROUTES.me}`, {
          headers: { authorization: `Bearer ${other.token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("removing by sub takes every device that person signed in — what removing them does", async () => {
    const first = await signIn("ada-mbp");
    const second = await signIn("ada-desktop");

    const removed = await fetch(`${origin}${RELAY_ROUTES.deviceRemove}`, {
      method: "POST",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sub: "sub-ada" }),
    });

    expect(await removed.json()).toEqual({ removed: 2 });
    expect(
      (
        await fetch(`${origin}${RELAY_ROUTES.me}`, {
          headers: { authorization: `Bearer ${second.token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("a remove naming nothing the relay holds is a 404, not a quiet success", async () => {
    const { token } = await signIn();

    const response = await fetch(`${origin}${RELAY_ROUTES.deviceRemove}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "never-issued" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no-such-device" });
  });

  test("the token survives a relay restart, which is why it is on the volume", async () => {
    const { token } = await signIn();
    await relay?.close();
    relay = await startRelay({
      env: env(),
      dataDir,
      port: 0,
      identity: fakeGoogle(),
      log: () => {},
      warn: () => {},
    });

    const response = await fetch(`http://127.0.0.1:${relay.port}${RELAY_ROUTES.me}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
  });

  test("someone off the allowlist gets no code and therefore no token", async () => {
    await relay?.close();
    relay = await startRelay({
      env: env({ allowedEmails: ["ada@example.test"] }),
      dataDir,
      port: 0,
      identity: fakeGoogle({ sub: "sub-eve", email: "eve@example.test", emailVerified: true }),
      log: () => {},
      warn: () => {},
    });
    origin = `http://127.0.0.1:${relay.port}`;

    const start = new URL(RELAY_ROUTES.deviceStart, origin);
    start.searchParams.set("challenge", pkceChallenge(VERIFIER));
    const started = await fetch(start, { redirect: "manual" });
    const landed = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: {
        cookie: `${PRE_AUTH_COOKIE}=${encodeURIComponent(cookie(started, PRE_AUTH_COOKIE) ?? "")}`,
      },
    });

    expect(landed.status).toBe(403);
    expect(landed.headers.get("location")).toBeNull();
  });
});
