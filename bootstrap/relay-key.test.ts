// The deployment key: minted in memory, saved only once the relay accepts it,
// and the same key on every boot after that — both halves of it, the Ed25519
// key that signs and the X25519 box key a console encrypts to (#549).

import { createPrivateKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { fingerprintOf, verifyHelloSignature } from "../src/ed25519.ts";
import { isBoxKey } from "../src/x25519.ts";
import { openSecret, sealSecret } from "../src/contracts/secret-envelope.mjs";
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
    expect(
      verifyHelloSignature(key.publicKey, { nonce, boxKey: key.boxKey }, key.sign(nonce)),
    ).toBe(true);
  });

  test("and does not verify under anyone else's", () => {
    const key = generateDeploymentKey();
    expect(
      verifyHelloSignature(
        generateDeploymentKey().publicKey,
        { nonce, boxKey: key.boxKey },
        key.sign(nonce),
      ),
    ).toBe(false);
  });

  test("nor for a nonce it did not sign — a replayed hello is refused", () => {
    const key = generateDeploymentKey();
    const other = Buffer.from("a different nonce").toString("base64url");
    expect(
      verifyHelloSignature(key.publicKey, { nonce: other, boxKey: key.boxKey }, key.sign(nonce)),
    ).toBe(false);
  });

  test("the fingerprint is a function of the public key alone", () => {
    const key = generateDeploymentKey();
    expect(key.fingerprint).toBe(fingerprintOf(key.publicKey));
    expect(key.fingerprint).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  test("both keys are minted together and the file holds both", () => {
    const path = relayKeyPath(volume());
    const minted = generateDeploymentKey();
    saveDeploymentKey(path, minted);

    // Two PKCS#8 blocks, one file, one lifecycle (#514 §3). PEM labels both
    // "PRIVATE KEY", which is exactly why the reader asks the curve and not
    // the armour.
    const contents = readFileSync(path, "utf8");
    expect(contents.match(/-----BEGIN PRIVATE KEY-----/g)).toHaveLength(2);

    const reloaded = readDeploymentKey(path)!;
    expect(reloaded.publicKey).toBe(minted.publicKey);
    expect(reloaded.boxKey).toBe(minted.boxKey);
    expect(reloaded.boxKeyOnVolume).toBe(true);
  });

  test("the box key is a 32-byte X25519 key, not the signing key wearing a hat", () => {
    const key = generateDeploymentKey();
    expect(Buffer.from(key.boxKey, "base64url")).toHaveLength(32);
    expect(key.boxKey).not.toBe(key.publicKey);
    expect(isBoxKey(key.boxKey)).toBe(true);
    // And the private half is PKCS#8 DER, which is what `openSecret` takes.
    expect(
      createPrivateKey({ key: Buffer.from(key.boxPrivateKey), format: "der", type: "pkcs8" })
        .asymmetricKeyType,
    ).toBe("x25519");
  });

  test("a key file written before box keys existed gains one on the next read", () => {
    // The signing key is the identity and the link is keyed on it, so an
    // upgrade must not mint a new one: the deployment keeps its link and simply
    // learns where a console should encrypt. The box key comes back unsaved, so
    // the caller writes the file before the handshake commits to it.
    const path = relayKeyPath(volume());
    const original = generateDeploymentKey();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, original.privateKey.export({ type: "pkcs8", format: "pem" }));

    const read = readDeploymentKey(path)!;

    expect(read.publicKey).toBe(original.publicKey);
    expect(read.fingerprint).toBe(original.fingerprint);
    expect(isBoxKey(read.boxKey)).toBe(true);
    expect(read.boxKeyOnVolume).toBe(false);

    // Saved, it is the file's key from then on and the flag goes quiet.
    saveDeploymentKey(path, read);
    const again = readDeploymentKey(path)!;
    expect(again.boxKey).toBe(read.boxKey);
    expect(again.boxKeyOnVolume).toBe(true);
  });

  test("the signature covers the box key, so it cannot be lifted onto another", () => {
    // The whole reason the box key rides inside the signature (#514 §7): a
    // deployment's own attestation must not survive someone swapping the key
    // secrets would be sealed to.
    const key = generateDeploymentKey();
    const other = generateDeploymentKey();

    expect(
      verifyHelloSignature(key.publicKey, { nonce, boxKey: key.boxKey }, key.sign(nonce)),
    ).toBe(true);
    expect(
      verifyHelloSignature(key.publicKey, { nonce, boxKey: other.boxKey }, key.sign(nonce)),
    ).toBe(false);
  });

  test("a corrupt key file reads as no key rather than as a crash", () => {
    const path = relayKeyPath(volume());
    saveDeploymentKey(path, generateDeploymentKey());
    writeFileSync(path, "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n");
    expect(readDeploymentKey(path)).toBeNull();
  });

  test("the console seals to the published box key and the volume opens it", async () => {
    // The end-to-end shape of write-only secrets (#504, #514), in one test: the
    // browser has nothing but what the hello published, the deployment has
    // nothing but its own file, and the relay in between carries the envelope.
    const path = relayKeyPath(volume());
    saveDeploymentKey(path, generateDeploymentKey());
    const key = readDeploymentKey(path)!;
    const aad = {
      keyFingerprint: key.fingerprint,
      tenant: "acme/widget",
      key: "ANTHROPIC_API_KEY",
      editId: "edit-1",
    };

    const envelope = await sealSecret({ boxKey: key.boxKey, aad, plaintext: "sk-ant-secret" });

    expect(JSON.stringify(envelope)).not.toContain("sk-ant-secret");
    await expect(openSecret({ boxPrivateKey: key.boxPrivateKey, aad, envelope })).resolves.toBe(
      "sk-ant-secret",
    );
  });

  test("and a second deployment cannot open it", async () => {
    const key = generateDeploymentKey();
    const other = generateDeploymentKey();
    const aad = {
      keyFingerprint: key.fingerprint,
      tenant: "acme/widget",
      key: "ANTHROPIC_API_KEY",
      editId: "edit-1",
    };
    const envelope = await sealSecret({ boxKey: key.boxKey, aad, plaintext: "sk-ant-secret" });

    await expect(openSecret({ boxPrivateKey: other.boxPrivateKey, aad, envelope })).rejects.toThrow(
      /not sealed for this deployment/,
    );
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
