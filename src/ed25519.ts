// Ed25519 as the relay rail spells it (#540): raw 32-byte public keys in
// base64url, signatures over the raw bytes of a challenge nonce, and one
// fingerprint rule.
//
// Both ends of the rail need the same three answers and they live in different
// halves of this package — the deployment key is the bootstrapper's
// (bootstrap/relay-key.ts), the verification is the relay's (relay/links.ts) —
// so the encoding decisions sit here, in one module neither half owns. A
// fingerprint computed two ways is two fingerprints, and the relay names a
// file after it.
//
// **Raw keys, not PEM, on the wire.** A PEM public key carries a header, a
// footer and line breaks through JSON for no benefit; the 32 bytes are the key.
// Node will only build a `KeyObject` from a structured encoding, so the fixed
// 12-byte SPKI prefix for this one curve is prepended on the way in. It is a
// constant because the curve is: an Ed25519 SPKI header never varies.

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/** Raw public keys are 32 bytes on this curve, always. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * The SPKI DER header every Ed25519 public key carries: `SEQUENCE { SEQUENCE {
 * OID 1.3.101.112 }, BIT STRING }`, up to the 32 key bytes that follow it.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The raw 32 bytes of a public key, base64url — the form `hello` carries. */
export function rawPublicKeyOf(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return der.subarray(der.length - ED25519_PUBLIC_KEY_BYTES).toString("base64url");
}

/**
 * A `KeyObject` from the wire form, or null when the string is not 32 bytes of
 * base64url. Null rather than a throw: the caller is a relay reading a frame a
 * stranger sent, and a malformed key is a refusal, not an exception.
 */
export function publicKeyFromRaw(publicKey: string): KeyObject | null {
  if (typeof publicKey !== "string" || publicKey.length === 0) return null;
  const raw = Buffer.from(publicKey, "base64url");
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/**
 * Does `signature` (base64url) sign `nonce` (base64url) under `publicKey`?
 * False for every malformed input, so one call answers "is this deployment who
 * it says it is" with no exception path to get wrong.
 *
 * The nonce is signed as the bytes it decodes to rather than as its characters,
 * so neither end has to re-encode the other's string to agree.
 */
export function verifyNonceSignature(publicKey: string, nonce: string, signature: string): boolean {
  const key = publicKeyFromRaw(publicKey);
  if (key === null || typeof nonce !== "string" || typeof signature !== "string") return false;
  try {
    return verify(null, Buffer.from(nonce, "base64url"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/**
 * The key fingerprint: SHA-256 of the raw public key, base64url, first 32
 * characters. Long enough that no fleet collides, short enough to read aloud,
 * and safe in a filename — the relay stores one report per fingerprint.
 */
export function fingerprintOf(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("base64url")
    .slice(0, 32);
}
