// The **deployment key** (#505 §1) — the Ed25519 key pair on the data volume
// that is this deployment's identity to its relay.
//
// Three properties make it the identity rather than the pairing token:
//
//  1. **The deployment generates it.** The private half is created inside the
//     container and never travels — not to the relay, not into the config
//     directory people commit, not through the operator's clipboard. The relay
//     only ever sees the public half.
//  2. **It outlives everything around it.** Restarts, engine relaunches and
//     crash-loop fallbacks leave it alone, so a deployment that paired once
//     never pairs again. `docker compose down -v` takes the volume and the key
//     with it; that is the one case where re-pairing is correct, and the relay
//     keeps the old link as evidence rather than merging (#505 §5).
//  3. **It signs, it does not encrypt.** Every connection after the first
//     answers a relay-issued nonce with a signature. The sealed-secret envelope
//     needs key material of its own (#514); this key cannot do that job.
//
// **Generating, saving and forgetting are three steps on purpose.** A key is
// minted in memory and written to the volume as it is presented, because a
// container killed a second after pairing must come back with the key the relay
// just recorded. But a key the relay *refused* is worse than no key at all —
// every later boot would sign with it and be turned away — so a refusal on the
// connection that minted it takes it off the volume again. A mistyped token
// therefore leaves nothing behind: fix the `.env`, boot again, pair.
//
// The file is PKCS#8 PEM at `0600`. PEM because `createPrivateKey` reads it
// back with no format argument, and the mode because the volume is shared with
// tenant data.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fingerprintOf, rawPublicKeyOf } from "../src/ed25519.ts";

/** The key's filename inside the deployment-level `state/` directory. */
export const RELAY_KEY_FILE = "relay-key";

/** Where the deployment key lives, given the data volume's mount point. */
export function relayKeyPath(dataBase: string): string {
  return join(dataBase, "state", RELAY_KEY_FILE);
}

/** The deployment key, in the forms the handshake and the report need it in. */
export type DeploymentKey = {
  /** Raw Ed25519 public key, base64url — what `hello` carries and the relay records. */
  publicKey: string;
  /** A short, stable name for that key: what a console shows, and what files are named after. */
  fingerprint: string;
  /** Sign a challenge nonce. Base64url, the encoding `hello` declares. */
  sign: (nonce: string) => string;
  /** The private half, kept for {@link saveDeploymentKey}. Never leaves the process. */
  privateKey: KeyObject;
};

/** Mint a new key pair in memory. Nothing touches the disk until it is saved. */
export function generateDeploymentKey(): DeploymentKey {
  return deploymentKeyFrom(generateKeyPairSync("ed25519").privateKey);
}

/**
 * The key on the volume, or null when this deployment has never paired. Null
 * for an unreadable or corrupt file too: either way there is no usable identity
 * here, and the answer that matters is the same one.
 */
export function readDeploymentKey(path: string): DeploymentKey | null {
  try {
    return deploymentKeyFrom(createPrivateKey(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Write the key to the volume at `0600`, creating `state/` if it is not there. */
export function saveDeploymentKey(path: string, key: DeploymentKey): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  // `writeFileSync`'s mode is masked by the umask and ignored outright when the
  // file already existed, so the permission is asserted rather than requested.
  chmodSync(path, 0o600);
}

/**
 * Remove the key from the volume. Called on one path only: the relay refused
 * the pairing that minted it, so what is on disk is an identity nothing will
 * ever accept.
 */
export function forgetDeploymentKey(path: string): void {
  rmSync(path, { force: true });
}

/** Build the public forms from a private key. */
function deploymentKeyFrom(privateKey: KeyObject): DeploymentKey {
  const publicKey = rawPublicKeyOf(createPublicKey(privateKey));
  return {
    publicKey,
    fingerprint: fingerprintOf(publicKey),
    // Ed25519 signs the message itself — no digest argument, which is what the
    // `null` says.
    sign: (nonce: string) =>
      sign(null, Buffer.from(nonce, "base64url"), privateKey).toString("base64url"),
    privateKey,
  };
}
