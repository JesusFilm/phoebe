// Staying connected honestly, end to end: a real listener, real sockets, and
// the relay's own clock (#541).
//
// The pairing story is relay/deployments.test.ts. This one starts after the
// handshake and asks the questions an operator asks: is it still there, how
// long has it been gone, what happens to a request whose deployment left
// mid-flight, and what is left behind after a forget, a leave, and a re-pair.
//
// The heartbeat interval and the dark threshold are turned down to
// milliseconds here. They are the only things injected: everything else — the
// pings, the terminate, the close codes, the receipts — runs exactly as it does
// in a container.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { WebSocket as WsClient } from "ws";
import {
  RELAY_CLOSE,
  RELAY_DARK_AFTER_MS,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
  RELAY_UNDELIVERED,
} from "../src/contracts/relay-protocol.ts";
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
import { relayLeave } from "../bootstrap/relay-leave.ts";
import { createLinks } from "./links.ts";
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

/** A heartbeat every 20 ms and darkness at 60 ms: the real ratio, in a blink. */
const HEARTBEAT_MS = 20;
const DARK_AFTER_MS = 60;

/** Wait for `predicate`, or fail the test rather than hang the suite. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("staying connected honestly", () => {
  let dataDir: string;
  let volume: string;
  let relay: RunningRelay;
  /** Has `boot` bound one yet? Two of these tests rebind mid-test. */
  let bound = false;
  let origin: string;
  let url: string;
  const dialled: RelayLink[] = [];
  const sockets: WsClient[] = [];

  /**
   * Bind a relay. `darkAfterMs` is a parameter because two of these tests are
   * about the threshold itself and want the real minute, while the rest want
   * darkness to arrive before the test does.
   */
  async function boot(darkAfterMs = DARK_AFTER_MS): Promise<void> {
    if (bound) await relay.close();
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
      heartbeatMs: HEARTBEAT_MS,
      darkAfterMs,
      log: () => {},
      warn: () => {},
    });
    bound = true;
    origin = `http://127.0.0.1:${relay.port}`;
    url = `ws://127.0.0.1:${relay.port}/deployments`;
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-"));
    volume = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
    await boot();
  });

  afterEach(async () => {
    for (const link of dialled.splice(0)) link.stop();
    for (const socket of sockets.splice(0)) socket.terminate();
    if (bound) await relay.close();
    bound = false;
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
    return ((await response.json()) as { token: string }).token;
  }

  /** Dial as a deployment does, through the bootstrapper's own link. */
  function dial(opts: { key?: DeploymentKey | null; pairingToken?: string }): RelayStatus[] {
    const statuses: RelayStatus[] = [];
    dialled.push(
      connectRelay({
        url,
        name: "acme/widget",
        key: opts.key ?? null,
        ...(opts.pairingToken !== undefined ? { pairingToken: opts.pairingToken } : {}),
        mintKey: generateDeploymentKey,
        saveKey: (minted) => saveDeploymentKey(relayKeyPath(volume), minted),
        forgetKey: () => forgetDeploymentKey(relayKeyPath(volume)),
        onStatus: (status) => statuses.push(status),
      }),
    );
    return statuses;
  }

  /**
   * A deployment hand-rolled over `ws`, for the two things the real link will
   * not do: answer a receipt, and refuse to pong. `autoPong: false` is how a
   * half-open socket is staged without unplugging anything.
   */
  function rawDial(opts: { key: DeploymentKey; token?: string; autoPong?: boolean }): {
    socket: WsClient;
    frames: Array<Record<string, unknown>>;
    closed: Promise<number>;
  } {
    const socket = new WsClient(url, { autoPong: opts.autoPong ?? true });
    sockets.push(socket);
    const frames: Array<Record<string, unknown>> = [];
    const closed = new Promise<number>((resolve) => socket.on("close", resolve));
    socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      frames.push(frame);
      if (frame["type"] !== RELAY_MESSAGES.challenge) return;
      socket.send(
        JSON.stringify({
          type: RELAY_MESSAGES.hello,
          protocol: RELAY_PROTOCOL,
          publicKey: opts.key.publicKey,
          boxKey: opts.key.boxKey,
          name: "acme/widget",
          ...(opts.token !== undefined
            ? { pairingToken: opts.token }
            : { signature: opts.key.sign(frame["nonce"] as string) }),
        }),
      );
    });
    socket.on("error", () => {});
    return { socket, frames, closed };
  }

  const fingerprint = (): string => relay.deployments.connected()[0]!.link.fingerprint;
  const rowOf = (fp: string, now?: Date) =>
    relay.deployments.rows(now).find((row) => row.fingerprint === fp)!;

  describe("the heartbeat", () => {
    test("rides out on the relay's timer, visible to the deployment", async () => {
      const key = generateDeploymentKey();
      const deployment = rawDial({ key, token: await mint() });

      await until(
        () => deployment.frames.filter((f) => f["type"] === RELAY_MESSAGES.heartbeat).length >= 2,
        "two heartbeats",
      );

      expect(deployment.frames[0]!["type"]).toBe(RELAY_MESSAGES.challenge);
    });

    test("and a socket that answers nothing is dropped, not reported connected", async () => {
      const key = generateDeploymentKey();
      const deployment = rawDial({ key, token: await mint(), autoPong: false });
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      const fp = fingerprint();

      // Three missed pings. The far end is a wall; the relay stops believing in
      // it rather than holding a connection that does not exist.
      expect(await deployment.closed).toBe(1006);
      await until(() => relay.deployments.connected().length === 0, "the socket to be dropped");
      expect(rowOf(fp).state).not.toBe("connected");
    });
  });

  describe("disconnected, then dark", () => {
    test("a live deployment is connected, with a `since` and no count of seconds", async () => {
      dial({ pairingToken: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");

      const row = rowOf(fingerprint());

      expect(row).toMatchObject({
        state: "connected",
        disconnectedForSeconds: null,
        maybeReplaced: false,
      });
      expect(row.connectedSince).not.toBeNull();
    });

    test("a clean close is a fact with a duration before it is a state", async () => {
      await boot(RELAY_DARK_AFTER_MS);
      dial({ pairingToken: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      const fp = fingerprint();
      for (const link of dialled.splice(0)) link.stop();
      await until(() => relay.deployments.connected().length === 0, "the close");

      const row = rowOf(fp, new Date(Date.now() + 12_000));

      expect(row.state).toBe("disconnected");
      expect(row.disconnectedForSeconds).toBeGreaterThanOrEqual(12);
      expect(row.lastClose).not.toBeNull();
    });

    test("and darkness once the threshold passes, however it ended", async () => {
      await boot(RELAY_DARK_AFTER_MS);
      dial({ pairingToken: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      const fp = fingerprint();
      for (const link of dialled.splice(0)) link.stop();
      await until(() => relay.deployments.connected().length === 0, "the close");

      const row = rowOf(fp, new Date(Date.now() + 60_000));

      expect(row.state).toBe("dark");
      expect(row.disconnectedForSeconds).toBeNull();
    });
  });

  describe("requests in flight", () => {
    const doctorRun = (id: string) =>
      ({ type: RELAY_MESSAGES.doctorRun, id, by: OPERATOR }) as const;

    test("a deployment the relay does not hold is refused up front", async () => {
      const receipt = await relay.deployments.request("fp-nobody", doctorRun("req-1"));

      expect(receipt).toEqual({
        type: RELAY_MESSAGES.receipt,
        id: "req-1",
        outcome: RELAY_UNDELIVERED,
      });
    });

    test("a receipt from the deployment is what the caller gets", async () => {
      const key = generateDeploymentKey();
      const deployment = rawDial({ key, token: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      deployment.socket.on("message", (data: Buffer) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (frame["type"] !== RELAY_MESSAGES.doctorRun) return;
        deployment.socket.send(
          JSON.stringify({
            type: RELAY_MESSAGES.receipt,
            id: frame["id"],
            outcome: "ran",
            detail: { fails: 0 },
          }),
        );
      });

      const receipt = await relay.deployments.request(fingerprint(), doctorRun("req-2"));

      expect(receipt).toMatchObject({ id: "req-2", outcome: "ran", detail: { fails: 0 } });
    });

    test("one that was in flight when the socket closed comes back undelivered", async () => {
      const key = generateDeploymentKey();
      const deployment = rawDial({ key, token: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");

      // Nothing answers this one: the socket goes away while it is in flight.
      const pending = relay.deployments.request(fingerprint(), doctorRun("req-3"));
      deployment.socket.close();

      expect(await pending).toEqual({
        type: RELAY_MESSAGES.receipt,
        id: "req-3",
        outcome: RELAY_UNDELIVERED,
      });
    });

    test("and nothing is replayed to the connection that comes back", async () => {
      const key = generateDeploymentKey();
      const first = rawDial({ key, token: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      const pending = relay.deployments.request(fingerprint(), doctorRun("req-4"));
      first.socket.close();
      await pending;

      const second = rawDial({ key });
      await until(() => relay.deployments.connected().length === 1, "the reconnect");
      await until(
        () => second.frames.filter((f) => f["type"] === RELAY_MESSAGES.heartbeat).length >= 1,
        "a heartbeat on the new connection",
      );

      expect(second.frames.some((frame) => frame["type"] === RELAY_MESSAGES.doctorRun)).toBe(false);
    });
  });

  describe("forget", () => {
    test("deletes the link and turns the live connection away as `unlinked`", async () => {
      const statuses = dial({ pairingToken: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      const fp = fingerprint();

      const response = await fetch(`${origin}${RELAY_ROUTES.forget}`, {
        method: "POST",
        headers: { cookie: await session() },
        body: JSON.stringify({ fingerprint: fp }),
      });

      expect(response.status).toBe(200);
      await until(
        () => statuses[statuses.length - 1]?.state === "unpaired",
        "the deployment to stop dialling",
      );
      expect(statuses[statuses.length - 1]!.lastClose?.code).toBe(RELAY_CLOSE.unlinked);
      expect(createLinks(dataDir).all()).toEqual([]);
      expect(relay.deployments.rows()).toEqual([]);
    });

    test("and the key that was forgotten cannot dial its way back in", async () => {
      dial({ pairingToken: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      relay.deployments.forget(fingerprint());
      for (const link of dialled.splice(0)) link.stop();

      const statuses = dial({ key: readDeploymentKey(relayKeyPath(volume)) });

      await until(() => statuses[statuses.length - 1]?.state === "unpaired", "the refusal");
      expect(statuses[statuses.length - 1]!.lastClose?.code).toBe(RELAY_CLOSE.unlinked);
    });
  });

  describe("leave", () => {
    test("deletes the key on the deployment's own volume", async () => {
      dial({ pairingToken: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      for (const link of dialled.splice(0)) link.stop();

      const left = relayLeave({ dataBase: volume, log: () => {} });

      expect(left.deleted).toBe(true);
      expect(readDeploymentKey(relayKeyPath(volume))).toBeNull();
      // The relay's side is untouched: leave and forget are two halves.
      expect(createLinks(dataDir).all()).toHaveLength(1);
    });
  });

  describe("a re-paired deployment", () => {
    test("is a new record, and the old one stays dark and flagged", async () => {
      dial({ pairingToken: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the first pairing");
      const wiped = fingerprint();
      for (const link of dialled.splice(0)) link.stop();
      await until(() => relay.deployments.connected().length === 0, "the first socket to close");
      // `docker compose down -v`: the volume, and the key with it.
      forgetDeploymentKey(relayKeyPath(volume));

      dial({ pairingToken: await mint() });
      await until(() => relay.deployments.connected().length === 1, "the second pairing");

      const rows = relay.deployments.rows(new Date(Date.now() + 60_000));
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.fingerprint === wiped)).toMatchObject({
        state: "dark",
        maybeReplaced: true,
      });
      expect(rows.find((row) => row.fingerprint !== wiped)).toMatchObject({
        state: "connected",
        maybeReplaced: false,
      });
    });
  });
});
