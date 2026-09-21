// Pair and connect, end to end: a real listener, a real WebSocket, the real
// deployment-side link, and a token minted through the console's own route.
//
// The only thing stubbed is Google, because the only thing on the far side of
// it is the network. Everything the story turns on — minting a token behind the
// session, the relay's opening challenge, the key the deployment generated, the
// signature on every later connect, and each refusal that closes the socket —
// runs for real against a bound port.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { RELAY_CLOSE, RELAY_MESSAGES } from "../src/contracts/relay-protocol.ts";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import { connectRelay, type RelayLink } from "../bootstrap/relay-link.ts";
import type { RelayStatus } from "../bootstrap/deployment-state.ts";
import {
  forgetDeploymentKey,
  generateDeploymentKey,
  readDeploymentKey,
  relayKeyPath,
  saveDeploymentKey,
  type DeploymentKey,
} from "../bootstrap/relay-key.ts";
import { createLinks } from "./links.ts";
import type { GoogleIdentity, IdentityProvider } from "./oidc.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "./sessions.ts";
import { startRelay, type RunningRelay } from "./serve.ts";

const ADA: GoogleIdentity = { sub: "sub-ada", email: "ada@example.test", emailVerified: true };

const google: IdentityProvider = {
  authorizationUrl: (params) =>
    Promise.resolve(`https://accounts.google.test/auth?state=${encodeURIComponent(params.state)}`),
  verifyCallback: () => Promise.resolve(ADA),
};

/** Wait for `predicate`, or fail the test rather than hang the suite. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pair and connect", () => {
  let dataDir: string;
  let volume: string;
  let relay: RunningRelay;
  let origin: string;
  let url: string;
  const links: RelayLink[] = [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-"));
    volume = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
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
      identity: google,
      log: () => {},
      warn: () => {},
    });
    origin = `http://127.0.0.1:${relay.port}`;
    url = `ws://127.0.0.1:${relay.port}/deployments`;
  });

  afterEach(async () => {
    for (const link of links.splice(0)) link.stop();
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(volume, { recursive: true, force: true });
  });

  /** Sign in as Ada and hand back her session cookie header. */
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

  /** Mint a pairing token the way the console will. */
  async function mint(): Promise<string> {
    const response = await fetch(`${origin}${RELAY_ROUTES.pairingTokens}`, {
      method: "POST",
      headers: { cookie: await session() },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  }

  /** Dial as a deployment would, reporting into `statuses`. */
  function dial(opts: {
    key?: DeploymentKey | null;
    pairingToken?: string;
    protocol?: number;
    statuses?: RelayStatus[];
  }): RelayStatus[] {
    const statuses = opts.statuses ?? [];
    const link = connectRelay({
      url,
      name: "acme/widget",
      key: opts.key ?? null,
      ...(opts.pairingToken !== undefined ? { pairingToken: opts.pairingToken } : {}),
      ...(opts.protocol !== undefined ? { protocol: opts.protocol } : {}),
      mintKey: generateDeploymentKey,
      saveKey: (minted) => saveDeploymentKey(relayKeyPath(volume), minted),
      forgetKey: () => forgetDeploymentKey(relayKeyPath(volume)),
      onStatus: (status) => statuses.push(status),
    });
    links.push(link);
    return statuses;
  }

  const state = (statuses: RelayStatus[]): string | undefined =>
    statuses[statuses.length - 1]?.state;

  test("an operator mints a token, the deployment pairs, and the relay lists it", async () => {
    const statuses = dial({ pairingToken: await mint() });
    await until(() => relay.deployments.connected().length === 1, "the deployment to connect");

    const connected = relay.deployments.connected()[0]!;
    const onDisk = readDeploymentKey(relayKeyPath(volume))!;
    expect(connected.link.name).toBe("acme/widget");
    expect(connected.link.fingerprint).toBe(onDisk.fingerprint);
    expect(createLinks(dataDir).find(onDisk.publicKey)?.pairedBy).toBe(ADA.email);
    // Both public halves land on the link in one step, from the one hello that
    // carried them (#549): the signing key the fingerprint names, and the box
    // key a console seals a secret to.
    expect(createLinks(dataDir).find(onDisk.publicKey)?.boxKey).toBe(onDisk.boxKey);
    expect(relay.deployments.rows()[0]?.boxKey).toBe(onDisk.boxKey);
    expect(state(statuses)).toBe("connected");
  });

  test("the key it paired with is the key it connects with the next time", async () => {
    dial({ pairingToken: await mint() });
    await until(() => relay.deployments.connected().length === 1, "the first pairing");
    for (const link of links.splice(0)) link.stop();
    await until(() => relay.deployments.connected().length === 0, "the first socket to close");

    const statuses = dial({ key: readDeploymentKey(relayKeyPath(volume)) });
    await until(() => relay.deployments.connected().length === 1, "the reconnect");
    expect(state(statuses)).toBe("connected");
    expect(createLinks(dataDir).all()).toHaveLength(1);
  });

  test("a spent token is refused, and the deployment stops dialling", async () => {
    const token = await mint();
    dial({ pairingToken: token });
    await until(() => relay.deployments.connected().length === 1, "the first pairing");

    const statuses = dial({ pairingToken: token });
    await until(() => state(statuses) === "unpaired", "the refusal");
    expect(statuses[statuses.length - 1]!.lastClose?.code).toBe(RELAY_CLOSE.tokenSpent);
  });

  test("a mistyped token leaves no key behind, so the next boot can pair", async () => {
    const statuses = dial({ pairingToken: "never-minted" });
    await until(() => state(statuses) === "unpaired", "the refusal");
    expect(readDeploymentKey(relayKeyPath(volume))).toBeNull();

    const second = dial({ pairingToken: await mint() });
    await until(() => relay.deployments.connected().length === 1, "the retry to pair");
    expect(state(second)).toBe("connected");
  });

  test("a key the relay never paired is unlinked, not merely unknown", async () => {
    const statuses = dial({ key: generateDeploymentKey() });
    await until(() => state(statuses) === "unpaired", "the refusal");
    expect(statuses[statuses.length - 1]!.lastClose?.code).toBe(RELAY_CLOSE.unlinked);
    expect(relay.deployments.connected()).toEqual([]);
  });

  test("a deployment above the relay's protocol is told to upgrade the relay", async () => {
    const statuses = dial({ pairingToken: await mint(), protocol: 99 });
    await until(
      () => statuses[statuses.length - 1]?.lastClose?.code === RELAY_CLOSE.protocol,
      "the protocol refusal",
    );
    expect(state(statuses)).toBe("reconnecting");
  });

  test("a second connection from the same key replaces the first", async () => {
    dial({ pairingToken: await mint() });
    await until(() => relay.deployments.connected().length === 1, "the first pairing");
    const first = relay.deployments.connected()[0]!.socket;

    dial({ key: readDeploymentKey(relayKeyPath(volume)) });
    await until(() => first.readyState !== first.OPEN, "the older socket to be displaced");
    expect(relay.deployments.connected()).toHaveLength(1);
  });

  test("a signature over someone else's nonce does not get in", async () => {
    // Pair honestly, then present the right key with a signature over a nonce
    // the relay never issued — a replayed hello.
    dial({ pairingToken: await mint() });
    await until(() => relay.deployments.connected().length === 1, "the first pairing");
    const key = readDeploymentKey(relayKeyPath(volume))!;
    const stale = Buffer.from("a nonce from another connection").toString("base64url");

    const closed = await new Promise<number>((resolve) => {
      const socket = new WebSocket(url);
      socket.addEventListener("message", () => {
        socket.send(
          JSON.stringify({
            type: RELAY_MESSAGES.hello,
            protocol: 1,
            publicKey: key.publicKey,
            boxKey: key.boxKey,
            name: "acme/widget",
            signature: key.sign(stale),
          }),
        );
      });
      socket.addEventListener("close", (event) => resolve(event.code));
      socket.addEventListener("error", () => {});
    });
    expect(closed).toBe(RELAY_CLOSE.badSignature);
  });

  test("the mint route is behind the session — a stranger gets no tokens", async () => {
    const response = await fetch(`${origin}${RELAY_ROUTES.pairingTokens}`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});
