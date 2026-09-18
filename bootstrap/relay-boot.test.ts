// What boot does about the `relay` block: who the deployment says it is, and
// whether it dials at all.
//
// The socket is stubbed, because what is under test is the decision, not the
// wire — relay-link.test.ts drives the handshake and relay/deployments.test.ts
// runs both ends against a real port.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { RelayStatus } from "./deployment-state.ts";
import type { DeploymentState } from "./deployment-state.ts";
import { prepareRelay, RELAY_TOKEN_ENV } from "./relay-boot.ts";
import { fingerprintOf } from "../src/ed25519.ts";
import {
  generateDeploymentKey,
  readDeploymentKey,
  relayKeyPath,
  saveDeploymentKey,
} from "./relay-key.ts";
import type { RelaySocketHandlers } from "./relay-link.ts";

const URL = "wss://relay.example.com/deployments";
const volume = (): string => mkdtempSync(join(tmpdir(), "phoebe-relay-boot-"));

type Run = {
  identity: () => ReturnType<ReturnType<typeof prepareRelay>["identity"]>;
  statuses: RelayStatus[];
  dials: Array<{ url: string; handlers: RelaySocketHandlers; sent: string[] }>;
  warnings: string[];
  stop: () => void;
};

function boot(opts: { rootConfig: unknown; dataBase: string; env?: NodeJS.ProcessEnv }): Run {
  const statuses: RelayStatus[] = [];
  const dials: Run["dials"] = [];
  const warnings: string[] = [];
  const relay = prepareRelay({
    rootConfig: opts.rootConfig,
    defaultName: "acme/widget",
    arm: "solo",
    dataBase: opts.dataBase,
    env: opts.env ?? {},
    warn: (message) => warnings.push(message),
    open: (url, handlers) => {
      dials.push({ url, handlers, sent: [] });
      return { send: (data) => dials[dials.length - 1]!.sent.push(data), close: () => {} };
    },
  });
  // Only `noteRelay` is ever called on this path; the rest of the model is the
  // supervisor's and has nothing to do with the link.
  relay.start({
    noteRelay: (status: RelayStatus) => {
      statuses.push(status);
    },
  } as unknown as DeploymentState);
  return { identity: relay.identity, statuses, dials, warnings, stop: relay.stop };
}

describe("a deployment with no relay block", () => {
  const run = (): Run => boot({ rootConfig: { repoSlug: "acme/widget" }, dataBase: volume() });

  test("dials nothing", () => {
    expect(run().dials).toEqual([]);
  });

  test("says nothing about a relay in the report", () => {
    expect(run().statuses).toEqual([]);
  });

  test("and its identity names no relay and no key", () => {
    expect(run().identity()).toEqual({ name: "acme/widget", arm: "solo" });
  });
});

describe("identity", () => {
  test("`relay.name` wins over the default", () => {
    const run = boot({
      rootConfig: { relay: { url: URL, name: "the-fleet" } },
      dataBase: volume(),
      env: { [RELAY_TOKEN_ENV]: "mint-fresh" },
    });
    expect(run.identity().name).toBe("the-fleet");
  });

  test("without one, the deployment's own default stands", () => {
    const run = boot({
      rootConfig: { relay: { url: URL } },
      dataBase: volume(),
      env: { [RELAY_TOKEN_ENV]: "mint-fresh" },
    });
    expect(run.identity()).toMatchObject({ name: "acme/widget", relayUrl: URL });
  });

  test("the fingerprint appears as soon as a key is on the volume", () => {
    const dataBase = volume();
    const key = generateDeploymentKey();
    saveDeploymentKey(relayKeyPath(dataBase), key);
    const run = boot({ rootConfig: { relay: { url: URL } }, dataBase });
    expect(run.identity().keyFingerprint).toBe(key.fingerprint);
  });

  test("and appears mid-run when a first pairing completes", () => {
    const dataBase = volume();
    const run = boot({
      rootConfig: { relay: { url: URL } },
      dataBase,
      env: { [RELAY_TOKEN_ENV]: "mint-fresh" },
    });
    expect(run.identity().keyFingerprint).toBeUndefined();
    run.dials[0]!.handlers.onOpen();
    run.dials[0]!.handlers.onMessage(
      JSON.stringify({ type: "phoebe:relay:challenge", nonce: "bm9uY2U", protocol: 1 }),
    );
    const presented = JSON.parse(run.dials[0]!.sent[0]!) as { publicKey: string };
    expect(run.identity().keyFingerprint).toBe(fingerprintOf(presented.publicKey));
    expect(readDeploymentKey(relayKeyPath(dataBase))?.publicKey).toBe(presented.publicKey);
  });
});

describe("a malformed relay block", () => {
  const run = (): Run =>
    boot({ rootConfig: { relay: { url: "https://relay.example.com" } }, dataBase: volume() });

  test("is a warning, not a boot failure — the relay is never load-bearing", () => {
    expect(run().warnings.join("\n")).toContain("ignoring the `relay` block");
  });

  test("and nothing is dialled", () => {
    expect(run().dials).toEqual([]);
  });
});

describe("the pairing token", () => {
  test("rides in the hello when there is no key yet", () => {
    const run = boot({
      rootConfig: { relay: { url: URL } },
      dataBase: volume(),
      env: { [RELAY_TOKEN_ENV]: "mint-fresh" },
    });
    run.dials[0]!.handlers.onOpen();
    run.dials[0]!.handlers.onMessage(
      JSON.stringify({ type: "phoebe:relay:challenge", nonce: "bm9uY2U", protocol: 1 }),
    );
    expect(JSON.parse(run.dials[0]!.sent[0]!)).toMatchObject({ pairingToken: "mint-fresh" });
  });

  test("an empty one is no token at all", () => {
    const run = boot({
      rootConfig: { relay: { url: URL } },
      dataBase: volume(),
      env: { [RELAY_TOKEN_ENV]: "" },
    });
    expect(run.dials).toEqual([]);
    expect(run.statuses[run.statuses.length - 1]).toMatchObject({
      configured: true,
      state: "unpaired",
    });
  });
});
