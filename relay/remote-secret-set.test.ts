// Setting a secret on a remote deployment, end to end (#550, decided in #504
// and #514): sealed in the console, carried by a real relay over a real socket,
// opened on the deployment, written to its store.
//
// The console's side is `sealSecret` called directly — the same function the
// browser bundle imports — and the deployment's side is the bootstrapper's own
// link and handler. What sits between them is a relay on a bound port with a
// volume, so the claim this file exists to make is a claim about that process:
// **the relay never holds the secret.** Not in the request it forwarded, not in
// the receipt it answered with, not in a file on its volume, and not in a log
// line. The test reads all four.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { sealSecret } from "../src/contracts/secret-envelope.mjs";
import { RELAY_UNDELIVERED } from "../src/contracts/relay-protocol.ts";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";
import type { SecretReceiptDetail } from "../src/contracts/secrets.ts";
import { readSecretEdits, readSecretStore, setSecret } from "../src/secret-store.ts";
import { connectRelay, type RelayLink } from "../bootstrap/relay-link.ts";
import {
  forgetDeploymentKey,
  generateDeploymentKey,
  readDeploymentKey,
  relayKeyPath,
  saveDeploymentKey,
} from "../bootstrap/relay-key.ts";
import { deliverSecret } from "../bootstrap/secret-delivery.ts";
import type { GoogleIdentity, IdentityProvider } from "./oidc.ts";
import { PRE_AUTH_COOKIE, SESSION_COOKIE } from "./sessions.ts";
import { startRelay, type RunningRelay } from "./serve.ts";

const OPERATOR = "ada@example.test";
const ADA: GoogleIdentity = { sub: "sub-ada", email: OPERATOR, emailVerified: true };
const SECRET = "sk-ant-api03-not-a-real-key";

const google: IdentityProvider = {
  authorizationUrl: (params) =>
    Promise.resolve(`https://accounts.google.test/auth?state=${encodeURIComponent(params.state)}`),
  verifyCallback: () => Promise.resolve(ADA),
};

const TENANT_CONFIG = `const config = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "pnpm install",
  checkCommand: "pnpm check",
  testCommand: "pnpm test",
  providerEnv: { claude: "ANTHROPIC_API_KEY" },
};
export default config;
`;

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("a secret set from the console", () => {
  let dataDir: string;
  let volume: string;
  let tenantRoot: string;
  let relay: RunningRelay;
  let origin: string;
  let url: string;
  const dialled: RelayLink[] = [];
  const relayLogs: string[] = [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-relay-"));
    volume = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
    tenantRoot = mkdtempSync(join(tmpdir(), "phoebe-tenant-"));
    writeFileSync(join(tenantRoot, "phoebe.config.ts"), TENANT_CONFIG);
    mkdirSync(join(volume, "acme", "widget", "state"), { recursive: true });
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
      log: (message: string) => relayLogs.push(message),
      warn: (message: string) => relayLogs.push(message),
    });
    origin = `http://127.0.0.1:${relay.port}`;
    url = `ws://127.0.0.1:${relay.port}/deployments`;
  });

  afterEach(async () => {
    for (const link of dialled.splice(0)) link.stop();
    relayLogs.length = 0;
    await relay.close();
    for (const dir of [dataDir, volume, tenantRoot]) {
      rmSync(dir, { recursive: true, force: true });
    }
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

  async function mint(): Promise<string> {
    const response = await fetch(`${origin}${RELAY_ROUTES.pairingTokens}`, {
      method: "POST",
      headers: { cookie: await session() },
    });
    return ((await response.json()) as { token: string }).token;
  }

  const stateDir = (): string => join(volume, "acme", "widget", "state");

  /**
   * Pair and connect a deployment that answers secret requests, exactly as
   * `phoebe boot` wires it: the link, the handler, and the box key off the
   * volume.
   */
  async function deployment(): Promise<{ fingerprint: string; boxKey: string }> {
    const token = await mint();
    dialled.push(
      connectRelay({
        url,
        name: "acme/widget",
        key: null,
        pairingToken: token,
        mintKey: generateDeploymentKey,
        saveKey: (minted) => saveDeploymentKey(relayKeyPath(volume), minted),
        forgetKey: () => forgetDeploymentKey(relayKeyPath(volume)),
        onStatus: () => {},
        onRequest: (request) =>
          deliverSecret(request, {
            configPath: join(tenantRoot, "phoebe.config.ts"),
            dataBase: volume,
            processEnv: { PHOEBE_DATA_DIR: volume },
            key: () => {
              const onDisk = readDeploymentKey(relayKeyPath(volume));
              return onDisk === null
                ? null
                : { boxPrivateKey: onDisk.boxPrivateKey, fingerprint: onDisk.fingerprint };
            },
          }),
      }),
    );
    await until(() => relay.deployments.connected().length === 1, "the deployment to connect");
    const row = relay.deployments.rows()[0]!;
    return { fingerprint: row.fingerprint, boxKey: row.boxKey! };
  }

  /**
   * What the console's secrets form does: read the deployment's box key off the
   * row the relay served, seal to it, and POST the envelope. The plaintext never
   * leaves this function.
   */
  async function setFromConsole(opts: {
    fingerprint: string;
    boxKey: string;
    key: string;
    value: string;
    id: string;
    tenant?: string;
  }): Promise<{ outcome: string; detail?: SecretReceiptDetail }> {
    const envelope = await sealSecret({
      boxKey: opts.boxKey,
      aad: {
        keyFingerprint: opts.fingerprint,
        tenant: opts.tenant ?? "acme/widget",
        key: opts.key,
        editId: opts.id,
      },
      plaintext: opts.value,
    });
    const response = await fetch(`${origin}${RELAY_ROUTES.secrets}`, {
      method: "POST",
      headers: { cookie: await session(), "content-type": "application/json" },
      body: JSON.stringify({
        fingerprint: opts.fingerprint,
        tenant: opts.tenant ?? "acme/widget",
        key: opts.key,
        action: "set",
        id: opts.id,
        envelope: JSON.stringify(envelope),
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { outcome: string; detail?: SecretReceiptDetail };
  }

  test("lands in the tenant's store and comes back `written`", async () => {
    const { fingerprint, boxKey } = await deployment();

    const receipt = await setFromConsole({
      fingerprint,
      boxKey,
      key: "ANTHROPIC_API_KEY",
      value: SECRET,
      id: "edit-1",
    });

    expect(receipt.outcome).toBe("written");
    expect(readSecretStore(stateDir())["ANTHROPIC_API_KEY"]).toBe(SECRET);
  });

  test("the relay stamps `by` from its own session, not from the request", async () => {
    // The console cannot choose who the ledger says asked. That is the whole
    // reason `by` is not a field in the body.
    const { fingerprint, boxKey } = await deployment();

    await setFromConsole({
      fingerprint,
      boxKey,
      key: "ANTHROPIC_API_KEY",
      value: SECRET,
      id: "edit-1",
    });

    expect(readSecretEdits(stateDir())).toEqual([
      { id: "edit-1", key: "ANTHROPIC_API_KEY", at: expect.any(String), by: OPERATOR },
    ]);
  });

  test("and the relay never holds the secret — volume, receipt or log", async () => {
    const { fingerprint, boxKey } = await deployment();

    const receipt = await setFromConsole({
      fingerprint,
      boxKey,
      key: "ANTHROPIC_API_KEY",
      value: SECRET,
      id: "edit-1",
    });

    // Every file the relay wrote while this happened: links.json, the reports
    // directory, anything else it keeps.
    const onVolume = walk(dataDir)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(onVolume).not.toContain(SECRET);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(relayLogs.join("\n")).not.toContain(SECRET);
    // What it does say is who asked for what, which is the audit line an
    // operator needs and carries no value.
    expect(relayLogs.join("\n")).toContain(`${OPERATOR} asked acme/widget`);
    expect(relayLogs.join("\n")).toContain("set ANTHROPIC_API_KEY");
  });

  test("a clear falls back to the tier beneath it", async () => {
    const { fingerprint } = await deployment();
    setSecret({ stateDir: stateDir(), key: "ANTHROPIC_API_KEY", value: "from-the-store" });

    const response = await fetch(`${origin}${RELAY_ROUTES.secrets}`, {
      method: "POST",
      headers: { cookie: await session(), "content-type": "application/json" },
      body: JSON.stringify({
        fingerprint,
        tenant: "acme/widget",
        key: "ANTHROPIC_API_KEY",
        action: "clear",
        id: "edit-2",
      }),
    });
    const receipt = (await response.json()) as { outcome: string; detail?: SecretReceiptDetail };

    expect(receipt.outcome).toBe("written");
    expect(receipt.detail?.detail).toMatch(/governs again/);
    expect(readSecretStore(stateDir())).toEqual({});
  });

  test("a deployment-scope key is refused, with the reason", async () => {
    const { fingerprint, boxKey } = await deployment();

    const receipt = await setFromConsole({
      fingerprint,
      boxKey,
      key: "GH_APP_PRIVATE_KEY",
      value: "-----BEGIN PRIVATE KEY-----",
      id: "edit-1",
    });

    expect(receipt.outcome).toBe("refused");
    expect(receipt.detail?.detail).toMatch(/deployment-scope credential/);
  });

  test("a deployment that is not connected is `undelivered`, never queued", async () => {
    // The whole of #506 §8 in one assertion: the operator re-issues, and the
    // edit id makes a re-issue idempotent. Nothing is parked for a reconnect
    // that may never come.
    const { fingerprint, boxKey } = await deployment();
    for (const link of dialled.splice(0)) link.stop();
    await until(() => relay.deployments.connected().length === 0, "the deployment to go away");

    const receipt = await setFromConsole({
      fingerprint,
      boxKey,
      key: "ANTHROPIC_API_KEY",
      value: SECRET,
      id: "edit-1",
    });

    expect(receipt.outcome).toBe(RELAY_UNDELIVERED);
    expect(readSecretStore(stateDir())).toEqual({});
  });

  test("a stranger cannot set anything", async () => {
    const { fingerprint } = await deployment();
    const response = await fetch(`${origin}${RELAY_ROUTES.secrets}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fingerprint,
        tenant: "acme/widget",
        key: "GH_TOKEN",
        action: "clear",
      }),
    });
    expect(response.status).toBe(401);
  });

  test("a fingerprint this relay does not know is a 404", async () => {
    await deployment();
    const response = await fetch(`${origin}${RELAY_ROUTES.secrets}`, {
      method: "POST",
      headers: { cookie: await session(), "content-type": "application/json" },
      body: JSON.stringify({
        fingerprint: "B".repeat(32),
        tenant: "acme/widget",
        key: "GH_TOKEN",
        action: "clear",
      }),
    });
    expect(response.status).toBe(404);
  });

  test("a path segment that is not a fingerprint never reaches the volume", async () => {
    await deployment();
    const response = await fetch(`${origin}${RELAY_ROUTES.secrets}`, {
      method: "POST",
      headers: { cookie: await session(), "content-type": "application/json" },
      body: JSON.stringify({
        fingerprint: "../../etc/passwd",
        tenant: "acme/widget",
        key: "GH_TOKEN",
        action: "clear",
      }),
    });
    expect(response.status).toBe(400);
  });

  test("a set with no envelope is refused before anything is forwarded", async () => {
    const { fingerprint } = await deployment();
    const response = await fetch(`${origin}${RELAY_ROUTES.secrets}`, {
      method: "POST",
      headers: { cookie: await session(), "content-type": "application/json" },
      body: JSON.stringify({ fingerprint, tenant: "acme/widget", key: "GH_TOKEN", action: "set" }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("no-envelope");
  });
});

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
