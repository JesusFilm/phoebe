// The relay never derives pipeline state (#542, decided in #501), and never
// answers a doctor check (#546, decided in #507 §8).
//
// Derivation lives in the deployment: `src/pipeline-listing.ts` is the one owner
// of what a pipeline is doing and whether it is wedged, the bootstrapper writes
// its answer into the report, and every reader renders that answer. A relay that
// recomputed any of it would be a second opinion — and the day the two disagree,
// an operator is looking at a console and a `phoebe status` that contradict each
// other with no way to tell which is lying.
//
// Two tests, because the rule has two halves. One reads the relay's own source
// and refuses the imports that would make derivation possible. The other sends a
// report the relay could not possibly understand and checks that it comes back
// out of the JSON exactly as it went in.

import { readdirSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { WebSocket as WsClient } from "ws";
import { RELAY_MESSAGES, RELAY_PROTOCOL } from "../src/contracts/relay-protocol.ts";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type { RelayDeploymentDetail } from "../src/contracts/relay-routes.ts";
import { generateDeploymentKey } from "../bootstrap/relay-key.ts";
import type { GoogleIdentity, IdentityProvider } from "./oidc.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "./sessions.ts";
import { startRelay, type RunningRelay } from "./serve.ts";

/**
 * The modules that hold a deployment's own derivation, and the helpers inside
 * them. Naming any of these from the relay is the mistake this test exists to
 * make loud, whether it is a value import or a type one: a relay that knows the
 * report's shape is a relay one refactor away from reading it.
 */
const OFF_LIMITS = [
  "src/pipeline-listing.ts",
  "src/contracts/deployment.ts",
  // The edit receipt is the deployment's answer about the deployment's own file
  // (#503). The relay carries one verbatim and reads no field of it, so naming
  // the shape would be the first step towards policing the word (#547).
  "src/contracts/config-edit.ts",
  "src/contracts/pipeline-state.ts",
  "src/contracts/status-snapshot.ts",
  // The relay answers none of doctor's checks (#507 §8, #546). It carries a
  // `doctor-run` down a socket and repeats the receipt; a relay that knew what a
  // check looked like would be a relay one refactor away from answering one.
  "src/contracts/doctor.ts",
  "src/doctor.ts",
  "src/unit-event.ts",
];

/** Derivation by name: if one of these appears in the relay, something is deriving. */
const DERIVERS = [
  "pipelineState",
  "wedgedVerdict",
  "DeploymentReport",
  "StatusSnapshot",
  "EditReceipt",
  "DoctorReport",
  "DoctorCheck",
];

const ADA: GoogleIdentity = { sub: "sub-ada", email: "ada@example.test", emailVerified: true };
const google: IdentityProvider = {
  authorizationUrl: (params) =>
    Promise.resolve(`https://accounts.google.test/auth?state=${encodeURIComponent(params.state)}`),
  verifyCallback: () => Promise.resolve(ADA),
};

/**
 * A report from a deployment this relay has never met: a schema integer it does
 * not know, sections it has never heard of, and — deliberately — a pipeline cell
 * whose `state` and `wedged` are nonsense. A relay that derives would overwrite
 * them; a relay that stores and forwards hands them back untouched.
 */
const FROM_THE_FUTURE = {
  schema: 99,
  identity: { name: "the-fleet", arm: "solo" },
  fleet: {
    cells: [
      { id: "acme#work", state: "spelunking", wedged: { wedged: "perhaps", why: ["who knows"] } },
    ],
    updatedAt: "2027-01-01T00:00:00.000Z",
  },
  somethingThisRelayHasNeverHeardOf: { nested: [1, { deep: true }] },
};

describe("the relay never derives pipeline state", () => {
  test("and its source cannot: nothing in it names the deployment's own model", () => {
    const relayDir = import.meta.dirname;
    const sources = readdirSync(relayDir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const source = readFileSync(join(relayDir, name), "utf8");
      // Comments are where this rule is explained, so they are not evidence of
      // breaking it. Strip them before looking.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const forbidden of OFF_LIMITS) {
        expect(code, `${name} reaches for ${forbidden}`).not.toContain(forbidden);
      }
      for (const deriver of DERIVERS) {
        expect(code, `${name} names ${deriver}`).not.toContain(deriver);
      }
    }
  });

  describe("a report it cannot understand", () => {
    let dataDir: string;
    let relay: RunningRelay;
    let origin: string;
    const sockets: WsClient[] = [];

    beforeEach(async () => {
      dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-opaque-"));
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
    });

    afterEach(async () => {
      for (const socket of sockets.splice(0)) socket.terminate();
      await relay.close();
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

    test("is stored and served back exactly as it arrived", async () => {
      const cookie = await session();
      const minted = await fetch(`${origin}${RELAY_ROUTES.pairingTokens}`, {
        method: "POST",
        headers: { cookie },
      });
      const { token } = (await minted.json()) as { token: string };
      const key = generateDeploymentKey();

      const socket = new WsClient(`ws://127.0.0.1:${relay.port}/deployments`);
      sockets.push(socket);
      socket.on("error", () => {});
      const pushed = new Promise<void>((resolve) => {
        socket.on("message", (data: Buffer) => {
          const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
          if (frame["type"] !== RELAY_MESSAGES.challenge) return;
          socket.send(
            JSON.stringify({
              type: RELAY_MESSAGES.hello,
              protocol: RELAY_PROTOCOL,
              publicKey: key.publicKey,
              boxKey: key.boxKey,
              name: "the-fleet",
              pairingToken: token,
            }),
          );
          socket.send(
            JSON.stringify({
              type: RELAY_MESSAGES.report,
              schema: FROM_THE_FUTURE.schema,
              report: FROM_THE_FUTURE,
            }),
          );
          resolve();
        });
      });
      await pushed;

      const deadline = Date.now() + 5_000;
      let detail: RelayDeploymentDetail;
      do {
        if (Date.now() > deadline) throw new Error("the report never arrived");
        await new Promise((resolve) => setTimeout(resolve, 5));
        const response = await fetch(`${origin}${RELAY_ROUTES.deployments}/${key.fingerprint}`, {
          headers: { cookie },
        });
        detail = (await response.json()) as RelayDeploymentDetail;
      } while (detail.report === null);

      expect(detail.report.schema).toBe(99);
      expect(detail.report.report).toEqual(FROM_THE_FUTURE);
    });
  });
});
