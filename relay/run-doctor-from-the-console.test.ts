// Running doctor from the console, end to end (#546, decided in #507 §7 and
// §10): a signed-in person's POST, a real socket, the bootstrapper's own link
// and its own doctor runner, and the report that arrives afterwards.
//
// Nothing between the two ends is faked except the doctor child itself — a test
// that spawned `phoebe doctor --json` would be testing doctor, which has its own
// suite. What is under test is the path: the press reaches the deployment, the
// receipt names which run the press belongs to, and what that run found comes
// back the way every fact about a deployment does, as the next report.
//
// The relay answers no check anywhere in here. Every assertion about what doctor
// found reads the report the deployment pushed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { WebSocket as WsClient } from "ws";
import { DEPLOYMENT_SCHEMA } from "../src/contracts/deployment.ts";
import type { DeploymentReport } from "../src/contracts/deployment.ts";
import type { DoctorReport, DoctorSection } from "../src/contracts/doctor.ts";
import { RELAY_MESSAGES, RELAY_PROTOCOL } from "../src/contracts/relay-protocol.ts";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type {
  RelayDeploymentDetail,
  RelayDoctorRunAnswer,
  RelayDoctorRunResult,
} from "../src/contracts/relay-routes.ts";
import { createDoctorRunner, type DoctorRunResult } from "../bootstrap/doctor-runner.ts";
import { connectRelay, type RelayLink } from "../bootstrap/relay-link.ts";
import {
  forgetDeploymentKey,
  generateDeploymentKey,
  relayKeyPath,
  saveDeploymentKey,
} from "../bootstrap/relay-key.ts";
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

/** What one run comes back with here: two checks, one of them failing. */
const FOUND: DoctorReport = {
  checks: [
    { id: "config", state: "ok", detail: "phoebe.config.ts resolves" },
    { id: "labels", state: "fail", detail: "ready-for-agent is missing" },
  ],
  tenants: [],
  ok: false,
};

/** Wait for `predicate`, or fail the test rather than hang the suite. */
async function until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("run doctor from the console", () => {
  let dataDir: string;
  let volume: string;
  let relay: RunningRelay;
  let origin: string;
  let url: string;
  const dialled: RelayLink[] = [];
  const sockets: WsClient[] = [];
  /** Every doctor child this deployment was asked to spawn, unsettled. */
  let spawned: Array<(result: DoctorRunResult) => void>;
  /** The live report, as the deployment's model would hold it. */
  let report: DeploymentReport;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-doctor-"));
    volume = mkdtempSync(join(tmpdir(), "phoebe-deployment-doctor-"));
    spawned = [];
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
    for (const link of dialled.splice(0)) link.stop();
    for (const socket of sockets.splice(0)) socket.terminate();
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

  /** Mint a pairing token the way the console does. */
  async function mint(cookie: string): Promise<string> {
    const response = await fetch(`${origin}${RELAY_ROUTES.pairingTokens}`, {
      method: "POST",
      headers: { cookie },
    });
    return ((await response.json()) as { token: string }).token;
  }

  /**
   * One deployment: its own doctor runner, its own link, and the report the two
   * share. The child is the only thing injected — `spawned` is this test
   * standing in for a `phoebe doctor --json` that has not finished yet.
   */
  function boot(opts: { name: string; pairingToken: string }): void {
    const now = new Date().toISOString();
    report = {
      schema: DEPLOYMENT_SCHEMA,
      identity: { name: opts.name, arm: "solo" },
      doctor: { report: null, at: null, trigger: null, updatedAt: now },
      updatedAt: now,
    } as DeploymentReport;
    let link: RelayLink | null = null;
    const runner = createDoctorRunner({
      run: () => new Promise<DoctorRunResult>((resolve) => spawned.push(resolve)),
      onSection: (section) => {
        // What the live model does with a section: a new report object, then a
        // push down whatever socket there is (#542).
        report = {
          ...report,
          doctor: { ...section, updatedAt: new Date().toISOString() },
          updatedAt: new Date().toISOString(),
        };
        link?.push();
      },
      setTimer: () => ({ clear: () => {} }),
    });
    link = connectRelay({
      url,
      name: opts.name,
      key: null,
      pairingToken: opts.pairingToken,
      mintKey: generateDeploymentKey,
      saveKey: (minted) => saveDeploymentKey(relayKeyPath(volume), minted),
      forgetKey: () => forgetDeploymentKey(relayKeyPath(volume)),
      onStatus: () => {},
      report: () => report,
      onDoctorRun: (by) => {
        const ask = runner.request("request", by);
        void ask.result.catch(() => {});
        return {
          outcome: ask.outcome,
          ...(ask.detail !== undefined ? { detail: ask.detail } : {}),
        };
      },
    });
    dialled.push(link);
  }

  /**
   * A second link, paired and then gone: a deployment the relay knows and is not
   * holding a socket for. The `undelivered` half of the fleet press.
   */
  async function pairAndLeave(name: string, token: string): Promise<void> {
    const key = generateDeploymentKey();
    const socket = new WsClient(url);
    sockets.push(socket);
    socket.on("error", () => {});
    await new Promise<void>((resolve) => {
      socket.on("message", (data: Buffer) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (frame["type"] !== RELAY_MESSAGES.challenge) return;
        socket.send(
          JSON.stringify({
            type: RELAY_MESSAGES.hello,
            protocol: RELAY_PROTOCOL,
            publicKey: key.publicKey,
            name,
            pairingToken: token,
          }),
        );
        resolve();
      });
    });
    await until(() => relay.deployments.connected().length === 2, "both deployments connected");
    socket.close();
    await until(() => relay.deployments.connected().length === 1, "the stranger to leave");
  }

  /** Press the button: one deployment when named, the fleet when not. */
  async function press(
    cookie: string,
    fingerprint?: string,
  ): Promise<{ status: number; results: RelayDoctorRunResult[] }> {
    const response = await fetch(`${origin}${RELAY_ROUTES.doctorRun}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(fingerprint === undefined ? {} : { fingerprint }),
    });
    if (!response.ok) return { status: response.status, results: [] };
    const answer = (await response.json()) as RelayDoctorRunAnswer;
    return { status: response.status, results: answer.results };
  }

  /** The doctor section of the report the relay is holding, as a console reads it. */
  async function doctorAtTheRelay(cookie: string, fp: string): Promise<DoctorSection | null> {
    const response = await fetch(`${origin}${RELAY_ROUTES.deployments}/${fp}`, {
      headers: { cookie },
    });
    const detail = (await response.json()) as RelayDeploymentDetail;
    return (detail.report?.report as DeploymentReport | undefined)?.doctor ?? null;
  }

  const fingerprint = (): string => relay.deployments.connected()[0]!.link.fingerprint;

  test("the press reaches the deployment, and the receipt says a run started", async () => {
    const cookie = await session();
    boot({ name: "acme/widget", pairingToken: await mint(cookie) });
    await until(() => relay.deployments.connected().length === 1, "the pairing");

    const { results } = await press(cookie, fingerprint());

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: "acme/widget",
      state: "connected",
      outcome: "started",
    });
    expect(spawned).toHaveLength(1);
  });

  test("a run in flight is visible at the relay before it has found anything", async () => {
    const cookie = await session();
    boot({ name: "acme/widget", pairingToken: await mint(cookie) });
    await until(() => relay.deployments.connected().length === 1, "the pairing");
    const fp = fingerprint();

    await press(cookie, fp);

    await until(async () => {
      const doctor = await doctorAtTheRelay(cookie, fp);
      return doctor?.running !== undefined;
    }, "the running marker in the report");
    const doctor = await doctorAtTheRelay(cookie, fp);
    expect(doctor?.running?.trigger).toBe("request");
    expect(doctor?.report).toBeNull();
  });

  test("and what the run found arrives as the next report, not in the receipt", async () => {
    const cookie = await session();
    boot({ name: "acme/widget", pairingToken: await mint(cookie) });
    await until(() => relay.deployments.connected().length === 1, "the pairing");
    const fp = fingerprint();

    const { results } = await press(cookie, fp);
    // The receipt is about the ask. Not one check rides in it.
    expect(JSON.stringify(results)).not.toContain("labels");

    spawned[0]!({ outcome: "ok", report: FOUND });

    await until(async () => {
      const doctor = await doctorAtTheRelay(cookie, fp);
      return doctor?.report !== null && doctor?.report !== undefined;
    }, "the report carrying what doctor found");
    const doctor = await doctorAtTheRelay(cookie, fp);
    expect(doctor?.report).toEqual(FOUND);
    expect(doctor?.trigger).toBe("request");
    expect(doctor?.by).toBe(OPERATOR);
  });

  test("a second press while that run is in flight joins it rather than doubling it", async () => {
    const cookie = await session();
    boot({ name: "acme/widget", pairingToken: await mint(cookie) });
    await until(() => relay.deployments.connected().length === 1, "the pairing");
    const fp = fingerprint();

    const first = await press(cookie, fp);
    const second = await press(cookie, fp);

    expect(first.results[0]?.outcome).toBe("started");
    expect(second.results[0]?.outcome).toBe("joined");
    // One tenant's API budget spent, not two: doctor is a read of the same world.
    expect(spawned).toHaveLength(1);
  });

  test("the fleet press reports per deployment: started here, undelivered there", async () => {
    const cookie = await session();
    boot({ name: "acme/widget", pairingToken: await mint(cookie) });
    await until(() => relay.deployments.connected().length === 1, "the pairing");
    await pairAndLeave("acme/gone", await mint(cookie));

    const { results } = await press(cookie);

    expect(results).toHaveLength(2);
    const byName = new Map(results.map((result) => [result.name, result.outcome]));
    expect(byName.get("acme/widget")).toBe("started");
    // Refused up front, with no timer and nothing queued (#506 §8).
    expect(byName.get("acme/gone")).toBe("undelivered");
    expect(spawned).toHaveLength(1);
  });

  test("a deployment the relay does not know is a 404, and no session is a 401", async () => {
    const cookie = await session();
    boot({ name: "acme/widget", pairingToken: await mint(cookie) });
    await until(() => relay.deployments.connected().length === 1, "the pairing");

    expect((await press(cookie, "A".repeat(32))).status).toBe(404);

    const unauthenticated = await fetch(`${origin}${RELAY_ROUTES.doctorRun}`, {
      method: "POST",
      body: "{}",
    });

    expect(unauthenticated.status).toBe(401);
    expect(spawned).toHaveLength(0);
  });

  test("a fingerprint that is not a string is refused, not read as the fleet", async () => {
    const cookie = await session();
    boot({ name: "acme/widget", pairingToken: await mint(cookie) });
    await until(() => relay.deployments.connected().length === 1, "the pairing");

    const response = await fetch(`${origin}${RELAY_ROUTES.doctorRun}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: 7 }),
    });

    expect(response.status).toBe(400);
    // The fleet-wide press is a body with no fingerprint in it, not a body with
    // a broken one: asking everybody because one field was mistyped is the worst
    // reading of an ambiguous request.
    expect(spawned).toHaveLength(0);
  });
});
