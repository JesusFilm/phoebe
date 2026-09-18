// Alerting end to end: a real relay, a real deployment socket, a real HTTP
// webhook, and the relay's own timers (#515, #524 §1).
//
// The rule is unit-tested in src/contracts/alerts.test.ts and the file and the
// sender in relay/alerts.test.ts. This one asks the operator's question: the
// deployment stops answering, and does something arrive?
//
// The dark debounce and the sweep interval are turned down to milliseconds.
// Everything else — the handshake, the heartbeat, the POST, `alerts.json` —
// runs exactly as it does in a container.

import { createServer, type Server } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { WebSocket as WsClient } from "ws";
import { RELAY_MESSAGES, RELAY_PROTOCOL } from "../src/contracts/relay-protocol.ts";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type { AlertBody, AlertMessage, RelayAlertFacts } from "../src/contracts/alerts.ts";
import { generateDeploymentKey, type DeploymentKey } from "../bootstrap/relay-key.ts";
import { ALERTS_FILENAME } from "./alerts.ts";
import type { GoogleIdentity, IdentityProvider } from "./oidc.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "./sessions.ts";
import { startRelay, type RunningRelay } from "./serve.ts";

const OPERATOR = "ada@example.test";
const ADA: GoogleIdentity = { sub: "sub-ada", email: OPERATOR, emailVerified: true };

const google: IdentityProvider = {
  authorizationUrl: (params) =>
    Promise.resolve(`https://accounts.google.test/auth?state=${encodeURIComponent(params.state)}`),
  verifyCallback: () => Promise.resolve(ADA),
};

/** The real ratio, in a blink: heartbeat 20 ms, dark 60 ms, alert at 150 ms. */
const HEARTBEAT_MS = 20;
const DARK_AFTER_MS = 60;
const ALERT_DARK_MS = 150;
const SWEEP_MS = 10;

/** Wait for `predicate`, or fail the test rather than hang the suite. */
async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("alerting", () => {
  let dataDir: string;
  let relay: RunningRelay;
  let origin: string;
  let url: string;
  let hook: Server;
  let hookUrl: string;
  /** Every body the webhook actually received, in order. */
  let posted: AlertBody[];
  const sockets: WsClient[] = [];

  /** An HTTP server standing in for a chat product's incoming webhook. */
  async function startWebhook(): Promise<void> {
    posted = [];
    hook = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as AlertBody);
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
    const address = hook.address();
    if (address === null || typeof address === "string")
      throw new Error("the webhook did not bind");
    hookUrl = `http://127.0.0.1:${address.port}/incoming`;
  }

  async function boot(alertWebhook: string | null): Promise<void> {
    relay = await startRelay({
      env: {
        host: "localhost",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedEmails: [],
        alertWebhook,
      },
      dataDir,
      port: 0,
      identity: google,
      heartbeatMs: HEARTBEAT_MS,
      darkAfterMs: DARK_AFTER_MS,
      alertDarkAfterMs: ALERT_DARK_MS,
      alertSweepMs: SWEEP_MS,
      log: () => {},
      warn: () => {},
    });
    origin = `http://127.0.0.1:${relay.port}`;
    url = `ws://127.0.0.1:${relay.port}/deployments`;
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-alerting-"));
    await startWebhook();
    await boot(hookUrl);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await relay.close();
    await new Promise<void>((resolve) => hook.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
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

  async function mint(cookie: string): Promise<string> {
    const response = await fetch(`${origin}${RELAY_ROUTES.pairingTokens}`, {
      method: "POST",
      headers: { cookie },
    });
    return ((await response.json()) as { token: string }).token;
  }

  /**
   * Pair a deployment and hold the socket open. `autoPong: false` stages a
   * half-open connection — the relay's own heartbeat drops it, and everything
   * after that is darkness arriving on its own.
   */
  function dial(opts: { key: DeploymentKey; token?: string; autoPong?: boolean }): WsClient {
    const socket = new WsClient(url, { autoPong: opts.autoPong ?? true });
    sockets.push(socket);
    socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (frame["type"] !== RELAY_MESSAGES.challenge) return;
      socket.send(
        JSON.stringify({
          type: RELAY_MESSAGES.hello,
          protocol: RELAY_PROTOCOL,
          publicKey: opts.key.publicKey,
          name: "acme-site",
          ...(opts.token !== undefined
            ? { pairingToken: opts.token }
            : { signature: opts.key.sign(frame["nonce"] as string) }),
        }),
      );
    });
    socket.on("error", () => {});
    return socket;
  }

  /** Pair one deployment and wait until the relay is holding it. */
  async function pair(): Promise<{ key: DeploymentKey; fingerprint: string; socket: WsClient }> {
    const key = generateDeploymentKey();
    const token = await mint(await session());
    const socket = dial({ key, token, autoPong: false });
    const fingerprint = await until(
      () => relay.deployments.connected()[0]?.link.fingerprint,
      "the handshake to complete",
    );
    return { key, fingerprint, socket };
  }

  function alertsFile(): unknown {
    const path = join(dataDir, ALERTS_FILENAME);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null;
  }

  const raised = (condition: string): AlertMessage | undefined =>
    posted.find(
      (body): body is AlertMessage =>
        body.kind === "alert" && body.condition === condition && body.state === "raised",
    );
  const cleared = (condition: string): AlertMessage | undefined =>
    posted.find(
      (body): body is AlertMessage =>
        body.kind === "alert" && body.condition === condition && body.state === "cleared",
    );

  test("a deployment that stops answering raises dark on the webhook", async () => {
    const { fingerprint } = await pair();

    const body = await until(() => raised("dark"), "the dark alert to be posted");

    expect(body).toMatchObject({
      schema: 1,
      kind: "alert",
      condition: "dark",
      state: "raised",
      deployment: { name: "acme-site", keyFingerprint: fingerprint },
      url: `http://localhost/#/d/${fingerprint}`,
    });
    expect(body.text).toContain("acme-site: dark");
    // Recorded after the attempt, so the next sweep says nothing (#515 §12).
    expect(alertsFile()).toMatchObject({
      deployments: { [fingerprint]: { dark: { state: "raised" } } },
    });
  });

  test("it is one message per edge, not one per sweep", async () => {
    await pair();
    await until(() => raised("dark"), "the dark alert to be posted");
    // Several sweeps' worth of silence.
    await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 8));

    expect(posted.filter((body) => body.kind === "alert")).toHaveLength(1);
  });

  test("the deployment coming back clears it", async () => {
    const { key } = await pair();
    await until(() => raised("dark"), "the dark alert to be posted");

    dial({ key });

    const body = await until(() => cleared("dark"), "the clear to be posted");
    expect(body.text).toContain("no longer dark");
  });

  test("a relay holding no links sweeps and says nothing", async () => {
    // A minted token nobody spent writes no link, so there is nothing to have
    // an opinion about — and the sweep that finds nothing writes no file. (The
    // `unseen` state itself is a link with no handshake behind it, which the
    // rule's own tests cover.)
    await mint(await session());
    await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 8));

    expect(posted).toEqual([]);
    expect(alertsFile()).toBe(null);
  });

  test("a restart never re-fires what is still true", async () => {
    const { fingerprint } = await pair();
    await until(() => raised("dark"), "the dark alert to be posted");

    for (const socket of sockets.splice(0)) socket.terminate();
    await relay.close();
    posted = [];
    await boot(hookUrl);
    await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 8));

    expect(posted).toEqual([]);
    expect(alertsFile()).toMatchObject({
      deployments: { [fingerprint]: { dark: { state: "raised" } } },
    });
  });

  test("forgetting a deployment drops its entries and sends no clear", async () => {
    const { fingerprint } = await pair();
    await until(() => raised("dark"), "the dark alert to be posted");
    posted = [];

    const response = await fetch(`${origin}${RELAY_ROUTES.forget}`, {
      method: "POST",
      headers: { cookie: await session(), "content-type": "application/json" },
      body: JSON.stringify({ fingerprint }),
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 8));
    expect(posted).toEqual([]);
    expect(alertsFile()).toEqual({ deployments: {} });
  });

  test("the fleet read carries what the connection panel shows", async () => {
    const { fingerprint } = await pair();
    await until(() => raised("dark"), "the dark alert to be posted");

    const response = await fetch(`${origin}${RELAY_ROUTES.deployments}`, {
      headers: { cookie: await session() },
    });
    const { alerts } = (await response.json()) as { alerts: RelayAlertFacts };

    expect(alerts.webhook).toBe(true);
    expect(alerts.last[fingerprint]).toMatchObject({
      condition: "dark",
      state: "raised",
      pipeline: null,
    });
  });

  test("the test alert is behind the session and reaches the webhook", async () => {
    expect((await fetch(`${origin}${RELAY_ROUTES.testAlert}`, { method: "POST" })).status).toBe(
      401,
    );

    const response = await fetch(`${origin}${RELAY_ROUTES.testAlert}`, {
      method: "POST",
      headers: { cookie: await session() },
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ sinks: 1 });
    expect(posted[0]).toMatchObject({ kind: "test", by: OPERATOR });
  });

  describe("with no RELAY_ALERT_WEBHOOK", () => {
    beforeEach(async () => {
      await relay.close();
      await boot(null);
    });

    test("the relay still evaluates edges and still keeps alerts.json", async () => {
      const { fingerprint } = await pair();

      await until(
        () => (alertsFile() === null ? undefined : alertsFile()),
        "alerts.json to be written",
      );

      expect(alertsFile()).toMatchObject({
        deployments: { [fingerprint]: { dark: { state: "raised" } } },
      });
      expect(posted).toEqual([]);
    });

    test("and says so on the fleet read", async () => {
      const response = await fetch(`${origin}${RELAY_ROUTES.deployments}`, {
        headers: { cookie: await session() },
      });

      expect(((await response.json()) as { alerts: RelayAlertFacts }).alerts.webhook).toBe(false);
    });

    test("the test alert answers honestly that nothing took it", async () => {
      const response = await fetch(`${origin}${RELAY_ROUTES.testAlert}`, {
        method: "POST",
        headers: { cookie: await session() },
      });

      expect(await response.json()).toEqual({ sinks: 0 });
    });
  });
});
