// A config edit from the console, end to end (#503, #547): a real relay, a real
// socket, the bootstrapper's own pen, and a real `phoebe.config.ts` on disk that
// comes out of it changed.
//
// The deployment side is wired the way `phoebe boot` wires it — `prepareRelay`
// for the identity and the link, `createConfigEditor` for the pen, the model for
// the report — so nothing about the path is staged. The edit goes in as a POST a
// browser could make, and what comes back is the deployment's own receipt.
//
// What each test is really asserting is one of the acceptance criteria of #547:
// the fingerprint the page loaded travels and a stale one is refused, the
// relay's own stamp is the editor's address, a refusal carries the manual edit,
// a written edit ends in a reconcile the report names, and a deployment that is
// not connected is refused `undelivered` rather than queued.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type { RelayConfigSetAnswer } from "../src/contracts/relay-routes.ts";
import type { EditReceipt } from "../src/contracts/config-edit.ts";
import type { DeploymentReport } from "../src/contracts/deployment.ts";
import { createConfigEditor } from "../bootstrap/config-editor.ts";
import { createRootConfigSource } from "../bootstrap/config-report.ts";
import { createDeploymentState, type DeploymentState } from "../bootstrap/deployment-state.ts";
import { prepareRelay, type PreparedRelay } from "../bootstrap/relay-boot.ts";
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

/** The config the deployment boots with — one literal to move. */
const CONFIG_SOURCE = `import { defineConfig } from "phoebe-agent";

export default defineConfig({
  repoSlug: "acme/widget",
  // A comment the splice must not touch.
  pipelines: { work: { concurrency: 1 } },
});
`;

/** Wait for `predicate`, or fail the test rather than hang the suite. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("a config edit from the console", () => {
  let dataDir: string;
  let volume: string;
  let configDir: string;
  let configPath: string;
  let relay: RunningRelay;
  let origin: string;
  let bound = false;
  let nudges = 0;
  const deployments: PreparedRelay[] = [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-"));
    volume = mkdtempSync(join(tmpdir(), "phoebe-volume-"));
    configDir = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
    configPath = join(configDir, "phoebe.config.ts");
    writeFileSync(configPath, CONFIG_SOURCE, "utf8");
    nudges = 0;
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
    bound = true;
    origin = `http://127.0.0.1:${relay.port}`;
  });

  afterEach(async () => {
    for (const deployment of deployments.splice(0)) deployment.stop();
    if (bound) await relay.close();
    bound = false;
    for (const dir of [dataDir, volume, configDir]) rmSync(dir, { recursive: true, force: true });
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

  async function mint(): Promise<string> {
    const response = await fetch(`${origin}${RELAY_ROUTES.pairingTokens}`, {
      method: "POST",
      headers: { cookie: await session() },
    });
    return ((await response.json()) as { token: string }).token;
  }

  /**
   * A deployment with a pen, wired as boot wires one. The validator is stood in
   * for the engine process boot would spawn — a checkout is not what this test
   * is about — and it says yes to everything, so a refusal here is always one of
   * the writer's own.
   */
  function deploy(pairingToken: string, validates = true): DeploymentState {
    const editor = createConfigEditor({
      rootConfigPath: configPath,
      dataBase: volume,
      env: {},
      run: () => ({
        status: validates ? 0 : 1,
        stdout: validates ? '{"ok":true}' : '{"ok":false,"reason":"concurrency must be positive"}',
        stderr: "",
      }),
    });
    editor.useNudge(() => {
      nudges += 1;
    });
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
      rootConfig: createRootConfigSource(configPath),
      lastEditId: () => editor.lastEditId(),
      edits: () => editor.liveEdits(),
      armOf: () => "pat",
      onReport: () => prepared.push(),
    });
    prepared.start(state, { configSet: (edit) => editor.apply(edit) });
    return state;
  }

  /** The report the relay is holding, or null while it holds none. */
  function held(fingerprint: string): DeploymentReport | null {
    try {
      const stored = JSON.parse(
        readFileSync(join(dataDir, REPORTS_DIRNAME, `${fingerprint}.json`), "utf8"),
      ) as { report: DeploymentReport };
      return stored.report;
    } catch {
      return null;
    }
  }

  /** Wait for the handshake and the first report, and name the deployment. */
  async function reporting(): Promise<string> {
    await until(() => relay.deployments.connected().length === 1, "the pairing");
    const fingerprint = relay.deployments.connected()[0]!.link.fingerprint;
    await until(() => held(fingerprint) !== null, "the first report");
    return fingerprint;
  }

  /** The fingerprint of the config as the report showed it — what a page loads. */
  function loadedFingerprint(fingerprint: string): string {
    return held(fingerprint)!.config!.root.fingerprint!;
  }

  /** One config-set, as the console's relay client makes it. */
  async function setField(
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; answer: RelayConfigSetAnswer }> {
    const response = await fetch(`${origin}${RELAY_ROUTES.configSet}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      answer: (await response.json()) as RelayConfigSetAnswer,
    };
  }

  test("moves one literal in the file and answers with the deployment's receipt", async () => {
    const state = deploy(await mint());
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();

    const { status, answer } = await setField(cookie, {
      fingerprint,
      id: "edit-1",
      path: "pipelines.work.concurrency",
      value: 4,
      configFingerprint: loadedFingerprint(fingerprint),
    });

    expect(status).toBe(200);
    expect(answer.outcome).toBe("written");
    const receipt = answer.receipt as EditReceipt;
    expect(receipt.state).toBe("written");
    expect(receipt.path).toBe("pipelines.work.concurrency");

    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("concurrency: 4");
    // Every other byte, including the comment: this is a splice, not a rewrite.
    expect(after).toContain("// A comment the splice must not touch.");
    // And the write nudged the reconcile loop the poll would have nudged later.
    expect(nudges).toBe(1);
  });

  test("stamps the signed-in address into the ledger, not the body's idea of it", async () => {
    const state = deploy(await mint());
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();

    const { answer } = await setField(cookie, {
      fingerprint,
      id: "edit-1",
      path: "pipelines.work.concurrency",
      value: 4,
      configFingerprint: loadedFingerprint(fingerprint),
      by: "someone-else@example.test",
    });

    expect((answer.receipt as EditReceipt).by).toBe(OPERATOR);
    const ledger = JSON.parse(readFileSync(join(volume, "state", "config-edits.json"), "utf8")) as {
      applied: { by?: string }[];
    };
    expect(ledger.applied.map((entry) => entry.by)).toEqual([OPERATOR]);
  });

  test("refuses a fingerprint the file has moved past, and says what to type instead", async () => {
    const state = deploy(await mint());
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();

    const { answer } = await setField(cookie, {
      fingerprint,
      id: "edit-stale",
      path: "pipelines.work.concurrency",
      value: 4,
      configFingerprint: "sha256:the-file-this-page-was-drawn-from",
    });

    expect(answer.outcome).toBe("refused");
    const receipt = answer.receipt as EditReceipt & { state: "refused" };
    expect(receipt.reason).toBe("stale");
    expect(receipt.why).toContain("changed since you loaded it");
    expect(receipt.instruction).toContain("pipelines: { work: { concurrency: 4 } }");
    // Refused means the disk is exactly as it was.
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_SOURCE);
  });

  test("refuses a leaf that is not the console's, with the block's own sentence", async () => {
    const state = deploy(await mint());
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();

    const { answer } = await setField(cookie, {
      fingerprint,
      id: "edit-engine",
      path: "engine.ref",
      value: "v9.9.9",
      configFingerprint: loadedFingerprint(fingerprint),
    });

    const receipt = answer.receipt as EditReceipt & { state: "refused" };
    expect(receipt.reason).toBe("not-editable");
    expect(receipt.why).toContain("phoebe upgrade");
    expect(receipt.instruction).toContain("by hand");
  });

  test("refuses a patch the running engine's loader will not take", async () => {
    const state = deploy(await mint(), false);
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();

    const { answer } = await setField(cookie, {
      fingerprint,
      id: "edit-invalid",
      path: "pipelines.work.concurrency",
      value: -1,
      configFingerprint: loadedFingerprint(fingerprint),
    });

    const receipt = answer.receipt as EditReceipt & { state: "refused" };
    expect(receipt.reason).toBe("invalid");
    expect(receipt.why).toContain("concurrency must be positive");
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_SOURCE);
  });

  test("answers a redelivered edit with the receipt the first one got", async () => {
    const state = deploy(await mint());
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();
    const configFingerprint = loadedFingerprint(fingerprint);

    const first = await setField(cookie, {
      fingerprint,
      id: "edit-once",
      path: "pipelines.work.concurrency",
      value: 4,
      configFingerprint,
    });
    // The same id, and now a fingerprint the file has already moved past: the
    // ledger answers before the staleness check, which is what makes a retry
    // safe rather than a second write.
    const again = await setField(cookie, {
      fingerprint,
      id: "edit-once",
      path: "pipelines.work.concurrency",
      value: 4,
      configFingerprint,
    });

    expect(again.answer).toEqual(first.answer);
    expect(readFileSync(configPath, "utf8").match(/concurrency: 4/g)).toHaveLength(1);
  });

  test("the report that follows a write names the edit the reconcile is for", async () => {
    const state = deploy(await mint());
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();

    await setField(cookie, {
      fingerprint,
      id: "edit-followed",
      path: "pipelines.work.concurrency",
      value: 4,
      configFingerprint: loadedFingerprint(fingerprint),
    });
    // The supervisor's own reconcile is what would move the phase; the fact the
    // console follows is the id, which the model reads off the ledger at every
    // publish.
    state.publish();
    await until(
      () => held(fingerprint)?.bootstrapper.reconcile.lastEditId === "edit-followed",
      "the reconcile to name the edit",
    );

    const report = held(fingerprint)!;
    expect(report.bootstrapper.reconcile.phase).toBe("idle");
    expect(report.edits?.map((entry) => entry.path)).toEqual(["pipelines.work.concurrency"]);
    expect(report.edits?.[0]!.by).toBe(OPERATOR);
    // The ledger's own bookkeeping does not ride along in the report.
    expect(report.edits?.[0]).not.toHaveProperty("after");
  });

  test("a deployment the relay cannot reach is undelivered, not queued", async () => {
    const state = deploy(await mint());
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();
    // The deployment goes away. The link is still on the relay; the socket is not.
    for (const deployment of deployments.splice(0)) deployment.stop();
    await until(() => relay.deployments.connected().length === 0, "the socket to close");

    const { status, answer } = await setField(cookie, {
      fingerprint,
      id: "edit-undelivered",
      path: "pipelines.work.concurrency",
      value: 4,
      configFingerprint: "sha256:whatever-this-page-loaded",
    });

    expect(status).toBe(200);
    expect(answer.outcome).toBe("undelivered");
    expect(answer.receipt).toBeUndefined();
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_SOURCE);
  });

  test("refuses the unsigned-in, the malformed and the unknown deployment", async () => {
    const state = deploy(await mint());
    state.publish();
    const fingerprint = await reporting();
    const cookie = await session();
    const configFingerprint = loadedFingerprint(fingerprint);

    const anonymous = await fetch(`${origin}${RELAY_ROUTES.configSet}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint, id: "e", path: "a", value: 1, configFingerprint }),
    });
    expect(anonymous.status).toBe(401);

    // An object is not a literal, and a leaf holds one.
    const object = await setField(cookie, {
      fingerprint,
      id: "e",
      path: "pipelines.work",
      value: { concurrency: 4 },
      configFingerprint,
    });
    expect(object.status).toBe(400);

    // No fingerprint of the config is an edit composed blind, and there is no
    // merge here to recover from one.
    const blind = await setField(cookie, {
      fingerprint,
      id: "e",
      path: "pipelines.work.concurrency",
      value: 4,
    });
    expect(blind.status).toBe(400);

    const stranger = await setField(cookie, {
      fingerprint: "B".repeat(32),
      id: "e",
      path: "pipelines.work.concurrency",
      value: 4,
      configFingerprint,
    });
    expect(stranger.status).toBe(404);
  });
});
