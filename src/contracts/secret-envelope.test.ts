// The envelope's promises, as tests (#549, decided in #514).
//
// The round trip is the cheap half. The half that matters is the AAD: every one
// of the four bound fields is checked one at a time, because a construction that
// binds three of them and silently drops the fourth passes a round-trip test
// perfectly and leaves an envelope replayable at whichever field was dropped.

import { describe, expect, test } from "vite-plus/test";

import { type EnvelopeAad, openSecret, sealSecret } from "./secret-envelope.mjs";

/** WebCrypto's key type, read off the global class — see secret-envelope.mjs. */
type CryptoKey = InstanceType<typeof globalThis.CryptoKey>;

const AAD: EnvelopeAad = {
  keyFingerprint: "3f7a 91c2 0e5b 84d6",
  tenant: "acme",
  key: "ANTHROPIC_API_KEY",
  editId: "edit-0001",
};

const SECRET = "sk-ant-not-a-real-key-0123456789";

/** A deployment's box key, in the two forms the envelope takes them in. */
async function boxKeyPair(): Promise<{ boxKey: string; boxPrivateKey: Uint8Array }> {
  // The lib types do not know X25519 is a key-agreement algorithm, so
  // generateKey is typed as returning a single key rather than a pair.
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  const boxKey = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { boxKey, boxPrivateKey: pkcs8 };
}

function decodeBase64Url(text: string): Uint8Array {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

describe("the secret envelope round-trips", () => {
  test("what the console seals, the deployment opens", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    await expect(openSecret({ boxPrivateKey, aad: AAD, envelope })).resolves.toBe(SECRET);
  });

  test("a secret with multibyte characters survives", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const plaintext = "pässwörd — 秘密 🔑";
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext });
    await expect(openSecret({ boxPrivateKey, aad: AAD, envelope })).resolves.toBe(plaintext);
  });

  test("an empty secret is still a secret", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: "" });
    await expect(openSecret({ boxPrivateKey, aad: AAD, envelope })).resolves.toBe("");
  });

  test("sealing the same secret twice gives two unrelated envelopes", async () => {
    const { boxKey } = await boxKeyPair();
    const first = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    const second = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    expect(first.epk).not.toBe(second.epk);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });
});

describe("the wire form is what #514 §6 fixed", () => {
  test("exactly { v, epk, iv, ct }, base64url, at version 1", async () => {
    const { boxKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    expect(Object.keys(envelope).sort()).toEqual(["ct", "epk", "iv", "v"]);
    expect(envelope.v).toBe(1);
    for (const field of [envelope.epk, envelope.iv, envelope.ct]) {
      expect(field).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("the ephemeral key is 32 raw bytes and the IV is 12", async () => {
    const { boxKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    expect(decodeBase64Url(envelope.epk)).toHaveLength(32);
    expect(decodeBase64Url(envelope.iv)).toHaveLength(12);
  });

  test("the envelope is JSON, so the relay can store and forward it verbatim", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    const relayed = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
    await expect(openSecret({ boxPrivateKey, aad: AAD, envelope: relayed })).resolves.toBe(SECRET);
  });
});

describe("the AAD binds the envelope", () => {
  const CHANGED: Record<keyof EnvelopeAad, string> = {
    keyFingerprint: "0000 1111 2222 3333",
    tenant: "evilcorp",
    key: "GITHUB_TOKEN",
    editId: "edit-0002",
  };

  test.each(Object.keys(CHANGED) as (keyof EnvelopeAad)[])(
    "a changed %s fails to open",
    async (field) => {
      const { boxKey, boxPrivateKey } = await boxKeyPair();
      const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
      const aad = { ...AAD, [field]: CHANGED[field] };
      await expect(openSecret({ boxPrivateKey, aad, envelope })).rejects.toThrow(
        /not sealed for this deployment/,
      );
    },
  );

  test("shifting a field boundary fails to open — the fields are bound, not their run-on", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const sealed: EnvelopeAad = { ...AAD, tenant: "ac", key: "me" };
    const shifted: EnvelopeAad = { ...AAD, tenant: "a", key: "cme" };
    const envelope = await sealSecret({ boxKey, aad: sealed, plaintext: SECRET });
    await expect(openSecret({ boxPrivateKey, aad: shifted, envelope })).rejects.toThrow(
      /not sealed for this deployment/,
    );
  });

  test("a NUL in a field is refused rather than allowed to blur a boundary", async () => {
    const { boxKey } = await boxKeyPair();
    const aad: EnvelopeAad = { ...AAD, tenant: "ac\u0000me" };
    await expect(sealSecret({ boxKey, aad, plaintext: SECRET })).rejects.toThrow(
      /"tenant" must not contain a NUL/,
    );
  });

  test.each(["keyFingerprint", "tenant", "key", "editId"] as (keyof EnvelopeAad)[])(
    "a missing %s is refused rather than sealed as undefined",
    async (field) => {
      const { boxKey } = await boxKeyPair();
      const aad = { ...AAD };
      delete aad[field];
      await expect(sealSecret({ boxKey, aad, plaintext: SECRET })).rejects.toThrow(
        new RegExp(`"${field}" must be a string`),
      );
    },
  );
});

describe("nothing else opens the envelope", () => {
  test("another deployment's box private key fails", async () => {
    const { boxKey } = await boxKeyPair();
    const other = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    await expect(
      openSecret({ boxPrivateKey: other.boxPrivateKey, aad: AAD, envelope }),
    ).rejects.toThrow(/not sealed for this deployment/);
  });

  test("a tampered ciphertext fails", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    const bytes = decodeBase64Url(envelope.ct);
    bytes[0] ^= 0xff;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const ct = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(
      openSecret({ boxPrivateKey, aad: AAD, envelope: { ...envelope, ct } }),
    ).rejects.toThrow(/not sealed for this deployment/);
  });

  test("a substituted ephemeral key fails", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    const other = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    await expect(
      openSecret({ boxPrivateKey, aad: AAD, envelope: { ...envelope, epk: other.epk } }),
    ).rejects.toThrow(/not sealed for this deployment/);
  });
});

describe("a malformed envelope says which part is wrong", () => {
  test("an unknown version is refused, not guessed at", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    await expect(
      openSecret({
        boxPrivateKey,
        aad: AAD,
        envelope: { ...envelope, v: 2 as unknown as 1 },
      }),
    ).rejects.toThrow(/unsupported version 2/);
  });

  test.each(["epk", "iv", "ct"] as const)("a non-base64url %s is named", async (field) => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    await expect(
      openSecret({ boxPrivateKey, aad: AAD, envelope: { ...envelope, [field]: "not base64!" } }),
    ).rejects.toThrow(new RegExp(`"${field}" is not base64url`));
  });

  test("an epk of the wrong length is named rather than left to WebCrypto", async () => {
    const { boxKey, boxPrivateKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    await expect(
      openSecret({ boxPrivateKey, aad: AAD, envelope: { ...envelope, epk: "AAAA" } }),
    ).rejects.toThrow(/"epk" is not a raw X25519 public key/);
  });

  test("a box key that is not an X25519 point is refused at seal time", async () => {
    await expect(sealSecret({ boxKey: "AAAA", aad: AAD, plaintext: SECRET })).rejects.toThrow(
      /not a raw X25519 public key/,
    );
  });

  test("box private key bytes that are not a PKCS8 X25519 key are named", async () => {
    const { boxKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    await expect(
      openSecret({ boxPrivateKey: new Uint8Array([1, 2, 3]), aad: AAD, envelope }),
    ).rejects.toThrow(/not an X25519 key in PKCS8/);
  });

  test("a box private key that is not PKCS8 bytes is refused", async () => {
    const { boxKey } = await boxKeyPair();
    const envelope = await sealSecret({ boxKey, aad: AAD, plaintext: SECRET });
    await expect(
      openSecret({
        boxPrivateKey: "not bytes" as unknown as Uint8Array,
        aad: AAD,
        envelope,
      }),
    ).rejects.toThrow(/must be PKCS8 bytes/);
  });
});
