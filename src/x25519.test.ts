// The box key's encoding: raw 32 bytes on the wire, and one honest answer to
// "is this a key at all".

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { rawPublicKeyOf } from "./ed25519.ts";
import { boxKeyFromRaw, isBoxKey, rawBoxKeyOf, X25519_PUBLIC_KEY_BYTES } from "./x25519.ts";

const mint = (): string => rawBoxKeyOf(createPublicKey(generateKeyPairSync("x25519").privateKey));

describe("the box key on the wire", () => {
  test("is the 32 key bytes, base64url, and nothing else", () => {
    const boxKey = mint();
    expect(Buffer.from(boxKey, "base64url")).toHaveLength(X25519_PUBLIC_KEY_BYTES);
    expect(boxKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("round-trips through the SPKI header Node insists on", () => {
    const boxKey = mint();
    expect(rawBoxKeyOf(boxKeyFromRaw(boxKey)!)).toBe(boxKey);
  });

  test("32 bytes is 32 bytes — a signing key's bytes import as a box key", () => {
    // Worth pinning because it says what this check is *not*. X25519 does no
    // point validation on import, and a raw Ed25519 key is the same 32 bytes in
    // the same encoding, so nothing here can tell an operator they pasted the
    // wrong key. What catches a substituted box key is the hello's signature
    // covering it (src/ed25519.ts) — this module only rules out lengths and
    // characters that are not a key on any curve.
    const signing = rawPublicKeyOf(createPublicKey(generateKeyPairSync("ed25519").privateKey));
    const asBox = boxKeyFromRaw(signing);
    expect(asBox?.asymmetricKeyType).toBe("x25519");
    expect(rawBoxKeyOf(asBox!)).toBe(signing);
  });

  test("anything that is not 32 bytes is not a key", () => {
    expect(isBoxKey("")).toBe(false);
    expect(isBoxKey("short")).toBe(false);
    expect(isBoxKey(Buffer.alloc(31).toString("base64url"))).toBe(false);
    expect(isBoxKey(Buffer.alloc(33).toString("base64url"))).toBe(false);
    expect(isBoxKey(undefined)).toBe(false);
    expect(isBoxKey(null)).toBe(false);
    expect(isBoxKey(42)).toBe(false);
  });

  test("a well-formed key of the right length is one", () => {
    expect(isBoxKey(mint())).toBe(true);
  });
});
