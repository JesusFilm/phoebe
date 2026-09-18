// The deployment key: minted in memory, saved only once the relay accepts it,
// and the same key on every boot after that.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { fingerprintOf, verifyNonceSignature } from "../src/ed25519.ts";
import {
  generateDeploymentKey,
  readDeploymentKey,
  relayKeyPath,
  saveDeploymentKey,
} from "./relay-key.ts";

const volume = (): string => mkdtempSync(join(tmpdir(), "phoebe-relay-key-"));
const nonce = Buffer.from("a-relay-issued-nonce").toString("base64url");

describe("relayKeyPath", () => {
  test("the key sits beside the report in the deployment-level state dir", () => {
    expect(relayKeyPath("/data/repos")).toBe(join("/data/repos", "state", "relay-key"));
  });
});

describe("the deployment key", () => {
  test("a volume with no key has no identity to report", () => {
    expect(readDeploymentKey(relayKeyPath(volume()))).toBeNull();
  });

  test("minting touches no disk — a refused pairing leaves nothing behind", () => {
    const path = relayKeyPath(volume());
    generateDeploymentKey();
    expect(readDeploymentKey(path)).toBeNull();
  });

  test("a saved key comes back the same on the next boot", () => {
    const path = relayKeyPath(volume());
    const minted = generateDeploymentKey();
    saveDeploymentKey(path, minted);
    const reloaded = readDeploymentKey(path);
    expect(reloaded?.publicKey).toBe(minted.publicKey);
    expect(reloaded?.fingerprint).toBe(minted.fingerprint);
  });

  test("it is written 0600 — the volume is shared with tenant data", () => {
    const path = relayKeyPath(volume());
    saveDeploymentKey(path, generateDeploymentKey());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("two mints are two identities", () => {
    expect(generateDeploymentKey().publicKey).not.toBe(generateDeploymentKey().publicKey);
  });

  test("a signature over the challenge nonce verifies under the public key", () => {
    const key = generateDeploymentKey();
    expect(verifyNonceSignature(key.publicKey, nonce, key.sign(nonce))).toBe(true);
  });

  test("and does not verify under anyone else's", () => {
    const key = generateDeploymentKey();
    expect(verifyNonceSignature(generateDeploymentKey().publicKey, nonce, key.sign(nonce))).toBe(
      false,
    );
  });

  test("nor for a nonce it did not sign — a replayed hello is refused", () => {
    const key = generateDeploymentKey();
    const other = Buffer.from("a different nonce").toString("base64url");
    expect(verifyNonceSignature(key.publicKey, other, key.sign(nonce))).toBe(false);
  });

  test("the fingerprint is a function of the public key alone", () => {
    const key = generateDeploymentKey();
    expect(key.fingerprint).toBe(fingerprintOf(key.publicKey));
    expect(key.fingerprint).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  test("a corrupt key file reads as no key rather than as a crash", () => {
    const path = relayKeyPath(volume());
    saveDeploymentKey(path, generateDeploymentKey());
    writeFileSync(path, "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n");
    expect(readDeploymentKey(path)).toBeNull();
  });

  test("the private half stays on the volume and never rides in the public form", () => {
    const path = relayKeyPath(volume());
    const key = generateDeploymentKey();
    saveDeploymentKey(path, key);
    expect(readFileSync(path, "utf8")).toContain("PRIVATE KEY");
    expect(
      JSON.stringify({ publicKey: key.publicKey, fingerprint: key.fingerprint }),
    ).not.toContain("PRIVATE");
  });
});
