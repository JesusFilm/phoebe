// Reports over the relay, end to end (#542): a real listener, real sockets, a
// real deployment model, and a browser's two reads plus its event stream.
//
// The deployment side is wired exactly as `phoebe boot` wires it — `prepareRelay`
// for the identity and the link, `createDeploymentState` for the report, and the
// model's own change signal as the cue to push. Nothing about the report is
// staged: what goes up the socket is what the live model wrote, and what comes
// back out of the JSON is what a console would render.
//
// The heartbeat interval and the dark threshold are turned down to milliseconds.
// They are the only things injected.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import { RELAY_EVENTS } from "../src/contracts/relay-events.ts";
import type { RelayDeploymentDetail, RelayDeploymentRow } from "../src/contracts/relay-routes.ts";
import type { DeploymentReport } from "../src/contracts/deployment.ts";
import { createDeploymentState, type DeploymentState } from "../bootstrap/deployment-state.ts";
import { prepareRelay, type PreparedRelay } from "../bootstrap/relay-boot.ts";
import type { SupervisedPipeline } from "../bootstrap/pipelines.ts";
import type { GoogleIdentity, IdentityProvider } from "./oidc.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "./sessions.ts";
import { REPORTS_DIRNAME } from "./reports.ts";
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

/** One supervised pipeline, enough of one for the fleet section to have a cell. */
function pipelineOf(name: string): SupervisedPipeline {
  return {
    id: `acme#${name}`,
    tenant: {
      id: "acme",
      slug: "acme/widget",
      dir: "acme",
      configPath: "acme/phoebe.config.ts",
      envPath: "acme/.env",
      gitIdentity: null,
    },
    pipeline: {
      name,
      disabled: false,
      priority: 0,
      concurrency: 1,
      needsClone: true,
      env: [],
      fingerprint: "fp",
    },
    enumerated: true,
    siblingEnv: [],
  };
}

describe("reports over the relay", () => {
  let dataDir: string;
  let volume: string;
  let relay: RunningRelay;
  let bound = false;
  let origin: string;
  const deployments: PreparedRelay[] = [];

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
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-"));
    volume = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
    await boot();
  });

  afterEach(async () => {
    for (const deployment of deployments.splice(0)) deployment.stop();
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

  /**
   * A deployment, wired as boot wires one: the relay owns the identity, the
   * model owns the report, and a written report is the cue to push.
   */
  function deploy(pairingToken: string): DeploymentState {
    const prepared = prepareRelay({
      rootConfig: { relay: { url: `ws://127.0.0.1:${relay.port}/deployments`, name: "the-fleet" } },
      defaultName: "acme/widget",
      arm: "solo",
      dataBase: volume,
      env: { PHOEBE_RELAY_TOKEN: pairingToken },
    });
    deployments.push(prepared);
    const state = createDeploymentState({
      identity: prepared.identity,
      dataBase: volume,
      crashLoop: () => ({ lastGoodSha: "good", failingSha: null, failureCount: 0 }),
      slots: () => ({ capacity: 2, inUse: 0, waiting: 0, overGranted: 0, floorBudget: 1 }),
      armOf: () => "pat",
      rootConfig: () => ({ path: join(volume, "phoebe.config.ts"), fingerprint: null }),
      onReport: () => prepared.push(),
    });
    prepared.start(state);
    return state;
  }

  const fingerprint = (): string => relay.deployments.connected()[0]!.link.fingerprint;

  /** Wait for the handshake, then for the first report, and name the deployment. */
  async function reporting(): Promise<string> {
    await until(() => relay.deployments.connected().length === 1, "the pairing");
    const fp = fingerprint();
    await until(() => held(fp) !== null, "the first report");
    return fp;
  }

  /** What the relay holds for one deployment, as a browser reads it. */
  async function detailOf(fp: string, cookie: string): Promise<RelayDeploymentDetail> {
    const response = await fetch(`${origin}${RELAY_ROUTES.deployments}/${fp}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RelayDeploymentDetail;
  }

  /** The report the relay is holding, or null while it holds none. */
  function held(fp: string): DeploymentReport | null {
    try {
      const stored = JSON.parse(
        readFileSync(join(dataDir, REPORTS_DIRNAME, `${fp}.json`), "utf8"),
      ) as { report: DeploymentReport };
      return stored.report;
    } catch {
      return null;
    }
  }

  describe("the push", () => {
    test("a deployment hands over its whole report on connect", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);

      const fp = await reporting();

      const report = held(fp)!;
      expect(report.identity.name).toBe("the-fleet");
      expect(report.fleet.cells.map((cell) => cell.id)).toEqual(["acme#work"]);
      expect(report.relay.configured).toBe(true);
    });

    test("and a fresh one whenever a section moves", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      const fp = await reporting();

      state.notePipelines([pipelineOf("work"), pipelineOf("review")]);

      await until(() => (held(fp)?.fleet.cells.length ?? 0) === 2, "the second pipeline to arrive");
    });

    test("a report that has not moved is not pushed again", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      const fp = await reporting();
      const first = held(fp)!.updatedAt;

      // The model is asked to publish repeatedly with nothing changed. It writes
      // nothing, so there is nothing to push, so the relay's copy stands.
      for (let i = 0; i < 5; i++) state.publish();
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 2));

      expect(held(fp)!.updatedAt).toBe(first);
    });
  });

  describe("what the relay keeps", () => {
    test("the latest report only, at `reports/<fingerprint>.json`", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      const fp = await reporting();

      state.notePipelines([pipelineOf("work"), pipelineOf("review")]);
      await until(() => (held(fp)?.fleet.cells.length ?? 0) === 2, "the second report");

      expect(readdirSync(join(dataDir, REPORTS_DIRNAME))).toEqual([`${fp}.json`]);
    });

    test("and keeps it across a restart — last-known and dark, never unseen", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      const fp = await reporting();
      for (const deployment of deployments.splice(0)) deployment.stop();

      // A relay that came back on the same volume, with nobody dialled in yet.
      await boot();
      await new Promise((resolve) => setTimeout(resolve, DARK_AFTER_MS * 2));
      const detail = await detailOf(fp, await session());

      expect(detail.report?.report).toEqual(state.latest());
      expect(detail.deployment.state).toBe("dark");
    });

    test("forgetting a deployment takes its report with it", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      const fp = await reporting();

      const response = await fetch(`${origin}${RELAY_ROUTES.forget}`, {
        method: "POST",
        headers: { cookie: await session(), "content-type": "application/json" },
        body: JSON.stringify({ fingerprint: fp }),
      });

      expect(response.status).toBe(200);
      expect(held(fp)).toBeNull();
    });
  });

  describe("the JSON a console reads", () => {
    test("the fleet and one deployment are both behind the session", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      const fp = await reporting();

      const fleet = await fetch(`${origin}${RELAY_ROUTES.deployments}`);
      const one = await fetch(`${origin}${RELAY_ROUTES.deployments}/${fp}`);

      expect(fleet.status).toBe(401);
      expect(one.status).toBe(401);
    });

    test("one deployment answers the relay's own facts beside the report", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      const fp = await reporting();

      const detail = await detailOf(fp, await session());

      // The relay's half: where it holds the deployment, from its own clock.
      expect(detail.deployment).toMatchObject({
        fingerprint: fp,
        name: "the-fleet",
        state: "connected",
        pairedBy: OPERATOR,
      });
      expect(detail.deployment.connectedSince).not.toBeNull();
      // The deployment's half: the report, whole, as the model wrote it.
      expect(detail.report).toMatchObject({ fingerprint: fp, schema: state.latest()!.schema });
      expect(detail.report?.report).toEqual(state.latest());
    });

    test("the fleet read still lists every link, connected or not", async () => {
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      await until(() => relay.deployments.connected().length === 1, "the pairing");

      const response = await fetch(`${origin}${RELAY_ROUTES.deployments}`, {
        headers: { cookie: await session() },
      });
      const { deployments: rows } = (await response.json()) as {
        deployments: RelayDeploymentRow[];
      };

      expect(rows.map((row) => row.fingerprint)).toEqual([fingerprint()]);
    });

    test("a paired deployment that has never reported answers with no report", async () => {
      // A link, and nothing behind it: the row exists, the report does not.
      const token = await mint();
      const cookie = await session();
      deploy(token);
      await until(() => relay.deployments.connected().length === 1, "the pairing");
      const fp = fingerprint();
      const reports = join(dataDir, REPORTS_DIRNAME);
      rmSync(reports, { recursive: true, force: true });

      expect((await detailOf(fp, cookie)).report).toBeNull();
    });

    test("a fingerprint the relay does not know is a 404, not an empty row", async () => {
      const response = await fetch(`${origin}${RELAY_ROUTES.deployments}/${"z".repeat(32)}`, {
        headers: { cookie: await session() },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "no-such-deployment" });
    });

    test("a path that is not a fingerprint is not a deployment read at all", async () => {
      const cookie = await session();

      const traversal = await fetch(
        `${origin}${RELAY_ROUTES.deployments}/${encodeURIComponent("../allowlist")}`,
        { headers: { cookie } },
      );

      expect(traversal.status).toBe(404);
      expect(await traversal.json()).toEqual({ error: "no-such-route" });
    });
  });

  describe("the event stream", () => {
    type Seen = { name: string; data: Record<string, unknown> };

    /**
     * Open the stream and read it the way a browser does. The open is awaited
     * before anything is provoked: the relay subscribes this response before it
     * answers the request, so a caller holding the answer is a caller the next
     * event reaches.
     */
    async function watch(cookie: string): Promise<{
      until: (enough: (events: Seen[]) => boolean) => Promise<Seen[]>;
    }> {
      const response = await fetch(`${origin}${RELAY_ROUTES.events}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const events: Seen[] = [];
      let buffer = "";
      return {
        async until(enough) {
          const deadline = Date.now() + 5_000;
          while (!enough(events)) {
            if (Date.now() > deadline) throw new Error(`timed out; saw ${JSON.stringify(events)}`);
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const name = /^event: (.+)$/m.exec(frame)?.[1];
              const data = /^data: (.+)$/m.exec(frame)?.[1];
              if (name === undefined || data === undefined) continue;
              events.push({ name, data: JSON.parse(data) as Record<string, unknown> });
            }
          }
          await reader.cancel();
          return events;
        },
      };
    }

    test("is behind the session like every other read", async () => {
      const response = await fetch(`${origin}${RELAY_ROUTES.events}`);

      expect(response.status).toBe(401);
    });

    test("carries the connection and the report that follows it", async () => {
      const cookie = await session();
      const token = await mint();
      const stream = await watch(cookie);

      const state = deploy(token);
      state.notePipelines([pipelineOf("work")]);
      const events = await stream.until((seen) =>
        seen.some((event) => event.name === RELAY_EVENTS.report),
      );

      const connected = events.find((event) => event.name === RELAY_EVENTS.connected)!;
      expect((connected.data["deployment"] as RelayDeploymentRow).name).toBe("the-fleet");
      const report = events.find((event) => event.name === RELAY_EVENTS.report)!;
      expect(report.data["report"]).toEqual(state.latest());
      expect(report.data["schema"]).toBe(state.latest()!.schema);
    });

    test("and says `disconnected`, then `dark`, as one silence lasts", async () => {
      const cookie = await session();
      const state = deploy(await mint());
      state.notePipelines([pipelineOf("work")]);
      await reporting();
      const stream = await watch(cookie);

      // The deployment goes away, and stays away past the threshold.
      for (const deployment of deployments.splice(0)) deployment.stop();
      const events = await stream.until((seen) =>
        seen.some((event) => event.name === RELAY_EVENTS.dark),
      );

      // Two words for one silence, and each said once: the sweep that notices
      // darkness announces a state, not a tick.
      expect(events.map((event) => event.name)).toEqual([
        RELAY_EVENTS.disconnected,
        RELAY_EVENTS.dark,
      ]);
    });
  });
});
