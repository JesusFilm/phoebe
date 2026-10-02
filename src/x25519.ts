// X25519 as the relay rail spells it (#549, decided in #514) — the **box key**:
// the half of the deployment's identity that encrypts, beside the Ed25519 half
// that signs.
//
// The signing key cannot do this job. Ed25519 and X25519 are the same curve
// underneath, and converting one to the other is a published trick, but it
// makes one key answer two questions and there is no WebCrypto call that does
// it. So the deployment carries two keys in one file with one lifecycle
// (bootstrap/relay-key.ts), and the signature over the handshake nonce covers
// the box key too — which is what makes the encrypting key as attested as the
// signing one.
//
// This module is the encoding half, and it mirrors src/ed25519.ts on purpose:
// raw 32-byte keys in base64url on the wire, a structured encoding only where
// Node insists on one. Both halves of the package read it — the bootstrapper
// mints the key, the relay records what a `hello` claimed — so the rules live
// in one module neither owns.

import { createPublicKey, type KeyObject } from "node:crypto";

/** Raw public keys are 32 bytes on this curve, always. */
export const X25519_PUBLIC_KEY_BYTES = 32;

/**
 * The SPKI DER header every X25519 public key carries: `SEQUENCE { SEQUENCE {
 * OID 1.3.101.110 }, BIT STRING }`, up to the 32 key bytes that follow it. One
 * byte apart from Ed25519's — the OID's last byte — and a constant for the same
 * reason: the header never varies for a curve.
 */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** The raw 32 bytes of a box key, base64url — the form `hello` carries. */
export function rawBoxKeyOf(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return der.subarray(der.length - X25519_PUBLIC_KEY_BYTES).toString("base64url");
}

/**
 * Is this string a box key on the wire? The relay asks before recording one,
 * and the console imports whatever the relay hands back, so a link holding 31
 * bytes of something would be a set that fails in the browser with no way to
 * tell whose fault it was.
 *
 * The check is a real import rather than a length test: a well-formed length
 * with bytes the curve rejects is the interesting failure.
 */
export function isBoxKey(boxKey: unknown): boxKey is string {
  return typeof boxKey === "string" && boxKeyFromRaw(boxKey) !== null;
}

/**
 * A `KeyObject` from the wire form, or null when the string is not 32 bytes of
 * base64url on this curve. Null rather than a throw, as with the signing key:
 * the caller is a relay reading a frame a stranger sent.
 */
export function boxKeyFromRaw(boxKey: string): KeyObject | null {
  if (typeof boxKey !== "string" || boxKey.length === 0) return null;
  const raw = Buffer.from(boxKey, "base64url");
  if (raw.length !== X25519_PUBLIC_KEY_BYTES) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}
