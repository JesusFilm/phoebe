// The People page's half of the relay, end to end (#505 §6, #548): a real
// listener, real cookies, two people signing in through a fake Google.
//
// The story these tests tell is one sitting at the console. Ada claims an
// unclaimed relay by signing in, adds Grace, Grace signs in and gets a session,
// Ada removes her — and Grace's console goes dead in her hand rather than
// staying live until she reloads. That last step is the whole reason removal is
// a verb here and not a line in a file an operator edits.
//
// Two things the relay refuses and this file pins: removing yourself, and
// removing what `ALLOWED_EMAILS` holds. Neither is a permission — there are no
// roles — and both would leave the UI lying about a list it cannot change.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { RELAY_DEPLOYMENTS_PATH } from "../src/contracts/relay-protocol.ts";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type { RelayPairingToken, RelayPerson } from "../src/contracts/relay-routes.ts";
import type { GoogleIdentity, IdentityProvider } from "./oidc.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "./sessions.ts";
import { startRelay, type RunningRelay } from "./serve.ts";

const ADA_EMAIL = "ada@example.test";
const GRACE_EMAIL = "grace@example.test";
const ADA: GoogleIdentity = { sub: "sub-ada", email: ADA_EMAIL, emailVerified: true };
const GRACE: GoogleIdentity = { sub: "sub-grace", email: GRACE_EMAIL, emailVerified: true };

/** A Google that says whoever the test last put in front of it. */
function fakeGoogle(who: () => GoogleIdentity): IdentityProvider {
  return {
    authorizationUrl: (params) =>
      Promise.resolve(
        `https://accounts.google.test/auth?state=${encodeURIComponent(params.state)}`,
      ),
    verifyCallback: () => Promise.resolve(who()),
  };
}

describe("the People page's relay", () => {
  let dataDir: string;
  let relay: RunningRelay | null = null;
  let origin: string;
  let atTheDoor: GoogleIdentity = ADA;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-people-"));
    atTheDoor = ADA;
    relay = await startRelay({
      env: {
        host: "localhost",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedEmails: [],
        alertWebhook: null,
      },
      dataDir,
      port: 0,
      identity: fakeGoogle(() => atTheDoor),
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

  /** Walk the whole sign-in flow as `who`, and hand back their cookie header. */
  async function signIn(who: GoogleIdentity): Promise<string> {
    atTheDoor = who;
    const started = await fetch(`${origin}${RELAY_ROUTES.signIn}`, { redirect: "manual" });
    const preAuth = started.headers
      .getSetCookie()
      .find((header) => header.startsWith(`${PRE_AUTH_COOKIE}=`))!;
    const finished = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: { cookie: preAuth.split(";")[0]! },
    });
    const session = finished.headers
      .getSetCookie()
      .find((header) => header.startsWith(`${SESSION_COOKIE}=`));
    if (session === undefined) throw new Error(`${who.email} was refused at the door`);
    return session.split(";")[0]!;
  }

  function people(cookie: string): Promise<Response> {
    return fetch(`${origin}${RELAY_ROUTES.people}`, { headers: { cookie } });
  }

  async function listed(cookie: string): Promise<RelayPerson[]> {
    const body = (await (await people(cookie)).json()) as { people: RelayPerson[] };
    return body.people;
  }

  function add(cookie: string, email: unknown): Promise<Response> {
    return fetch(`${origin}${RELAY_ROUTES.people}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  function remove(cookie: string, email: string): Promise<Response> {
    return fetch(`${origin}${RELAY_ROUTES.removePerson}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  test("the list is behind the session, like everything else", async () => {
    expect((await fetch(`${origin}${RELAY_ROUTES.people}`)).status).toBe(401);
    expect((await add("", "grace@example.test")).status).toBe(401);
    expect((await remove("", "grace@example.test")).status).toBe(401);
  });

  test("the person who claimed the relay is on it, marked as themselves", async () => {
    const ada = await signIn(ADA);

    expect(await listed(ada)).toEqual([
      {
        email: "ada@example.test",
        addedBy: "bootstrap",
        addedAt: expect.any(String),
        fromEnvironment: false,
        signedIn: true,
        self: true,
      },
    ]);
  });

  test("adding by email lets that person in, and their login fills the rest in", async () => {
    const ada = await signIn(ADA);

    const added = await add(ada, "Grace@Example.test");

    expect(added.status).toBe(201);
    // Lowercased on the way in, and no `sub` until Grace herself turns up.
    expect(await listed(ada)).toContainEqual(
      expect.objectContaining({ email: "grace@example.test", addedBy: ADA_EMAIL, signedIn: false }),
    );

    const grace = await signIn(GRACE);

    expect((await people(grace)).status).toBe(200);
    expect(await listed(grace)).toContainEqual(
      expect.objectContaining({ email: "grace@example.test", signedIn: true, self: true }),
    );
  });

  test("everyone on the list can edit the list: there are no roles", async () => {
    const ada = await signIn(ADA);
    await add(ada, GRACE_EMAIL);
    const grace = await signIn(GRACE);

    expect((await add(grace, "alan@example.test")).status).toBe(201);
    expect((await remove(grace, "alan@example.test")).status).toBe(200);
  });

  test("a second add of the same address is a refusal, not a silent success", async () => {
    const ada = await signIn(ADA);
    await add(ada, GRACE_EMAIL);

    const again = await add(ada, GRACE_EMAIL);

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already-listed" });
    expect(await listed(ada)).toHaveLength(2);
  });

  test("a body with no address, and one with nonsense in it, say different things", async () => {
    const ada = await signIn(ADA);

    expect(await (await add(ada, undefined)).json()).toEqual({ error: "no-email" });
    expect(await (await add(ada, "not an address")).json()).toEqual({ error: "bad-email" });
  });

  test("removing someone ends the sessions they are holding", async () => {
    const ada = await signIn(ADA);
    await add(ada, GRACE_EMAIL);
    const grace = await signIn(GRACE);
    expect((await people(grace)).status).toBe(200);

    const removed = await remove(ada, GRACE_EMAIL);

    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      removed: { email: GRACE_EMAIL },
      sessionsEnded: 1,
    });
    // Grace's console is dead in her hand, not at her next reload.
    expect((await people(grace)).status).toBe(401);
  });

  test("and the door is shut behind them", async () => {
    const ada = await signIn(ADA);
    await add(ada, GRACE_EMAIL);
    await signIn(GRACE);
    await remove(ada, GRACE_EMAIL);

    await expect(signIn(GRACE)).rejects.toThrow(/refused at the door/);
  });

  test("you cannot remove yourself, however you name yourself", async () => {
    const ada = await signIn(ADA);

    const refused = await remove(ada, "ADA@example.test");

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "cannot-remove-yourself" });
    expect((await people(ada)).status).toBe(200);
  });

  test("an address nobody holds is a 404 rather than a shrug", async () => {
    const ada = await signIn(ADA);

    const missing = await remove(ada, "nobody@example.test");

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no-such-person" });
  });

  test("minting says the token once, and says where to point the deployment", async () => {
    const ada = await signIn(ADA);

    const response = await fetch(`${origin}${RELAY_ROUTES.pairingTokens}`, {
      method: "POST",
      headers: { cookie: ada },
    });

    expect(response.status).toBe(201);
    const minted = (await response.json()) as RelayPairingToken;
    expect(minted.token).toEqual(expect.any(String));
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now());
    // The relay's own address, as `relay.url` wants it: a WebSocket URL on the
    // deployments path, not the console's origin.
    expect(minted.relayUrl).toBe(`ws://localhost${RELAY_DEPLOYMENTS_PATH}`);
  });
});

describe("what ALLOWED_EMAILS holds", () => {
  let dataDir: string;
  let relay: RunningRelay | null = null;
  let origin: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-people-env-"));
    relay = await startRelay({
      env: {
        host: "localhost",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedEmails: [ADA_EMAIL, "ops@example.test"],
        alertWebhook: null,
      },
      dataDir,
      port: 0,
      identity: fakeGoogle(() => ADA),
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

  async function session(): Promise<string> {
    const started = await fetch(`${origin}${RELAY_ROUTES.signIn}`, { redirect: "manual" });
    const preAuth = started.headers
      .getSetCookie()
      .find((header) => header.startsWith(`${PRE_AUTH_COOKIE}=`))!;
    const finished = await fetch(`${origin}${RELAY_ROUTES.callback}?code=xyz`, {
      redirect: "manual",
      headers: { cookie: preAuth.split(";")[0]! },
    });
    return finished.headers
      .getSetCookie()
      .find((header) => header.startsWith(`${SESSION_COOKIE}=`))!
      .split(";")[0]!;
  }

  test("its entries say where they came from", async () => {
    const cookie = await session();

    const body = (await (
      await fetch(`${origin}${RELAY_ROUTES.people}`, { headers: { cookie } })
    ).json()) as { people: RelayPerson[] };

    expect(body.people).toEqual([
      expect.objectContaining({ email: ADA_EMAIL, fromEnvironment: true, self: true }),
      expect.objectContaining({ email: "ops@example.test", fromEnvironment: true, self: false }),
    ]);
  });

  test("and the UI cannot remove one: the way out is the variable", async () => {
    const cookie = await session();

    const refused = await fetch(`${origin}${RELAY_ROUTES.removePerson}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "ops@example.test" }),
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "from-environment" });
  });
});
