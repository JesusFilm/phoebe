// The **deployment key** (#505 §1, #549) — the key pair on the data volume that
// is this deployment's identity to its relay, and the box key beside it that a
// console encrypts secrets to.
//
// Three properties make it the identity rather than the pairing token:
//
//  1. **The deployment generates it.** The private halves are created inside the
//     container and never travel — not to the relay, not into the config
//     directory people commit, not through the operator's clipboard. The relay
//     only ever sees the public halves.
//  2. **It outlives everything around it.** Restarts, engine relaunches and
//     crash-loop fallbacks leave it alone, so a deployment that paired once
//     never pairs again. `docker compose down -v` takes the volume and the key
//     with it; that is the one case where re-pairing is correct, and the relay
//     keeps the old link as evidence rather than merging (#505 §5).
//  3. **One key signs, the other encrypts.** Every connection after the first
//     answers a relay-issued nonce with an Ed25519 signature. Ed25519 cannot
//     encrypt, so the sealed-secret envelope (#514) uses an X25519 **box key**,
//     and the signature covers `nonce ‖ boxKey` so the encrypting key is as
//     attested as the signing one.
//
// **Two keys, one file, one lifecycle** (#514 §3). Both PEM blocks live in
// `state/relay-key`, are minted together, are saved together and are forgotten
// together. Two files would be two lifecycles: a volume could hold half an
// identity, and every reader would need a rule for which half to believe. An
// older file holding only the signing key gains a box key on the next boot,
// under the same public Ed25519 key — so the link the relay already holds keeps
// working and simply learns where to encrypt.
//
// The blocks are told apart by asking Node what curve each one is, not by their
// order or their armour: PKCS#8 PEM labels both `PRIVATE KEY`, so the label
// cannot carry it and a positional rule would silently swap the two.
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
// tenant data — and now because one of the two keys opens every secret a
// console has ever sent this deployment.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fingerprintOf, helloSignedBytes, rawPublicKeyOf } from "../src/ed25519.ts";
import { rawBoxKeyOf } from "../src/x25519.ts";

/** The key's filename inside the deployment-level `state/` directory. */
export const RELAY_KEY_FILE = "relay-key";

/** Where the deployment key lives, given the data volume's mount point. */
export function relayKeyPath(dataBase: string): string {
  return join(dataBase, "state", RELAY_KEY_FILE);
}

/** The deployment key, in the forms the handshake and the envelope need it in. */
export type DeploymentKey = {
  /** Raw Ed25519 public key, base64url — what `hello` carries and the relay records. */
  publicKey: string;
  /** A short, stable name for that key: what a console shows, and what files are named after. */
  fingerprint: string;
  /**
   * Raw X25519 public key, base64url — the box key `hello` carries and a
   * browser seals to (#549).
   */
  boxKey: string;
  /**
   * The box key's private half as PKCS#8 DER — exactly what `openSecret` takes.
   * Bytes rather than a `KeyObject` because contracts may not import
   * `node:crypto`, and the deployment is the only holder either way.
   */
  boxPrivateKey: Uint8Array;
  /**
   * Sign a challenge nonce, over `nonce ‖ boxKey`. Base64url, the encoding
   * `hello` declares.
   */
  sign: (nonce: string) => string;
  /**
   * Is the box key the one on the volume? False for a key read out of a file
   * written before box keys existed: the signing half is the volume's, the box
   * half was minted here and has to be saved before anything encrypts to it.
   */
  boxKeyOnVolume: boolean;
  /** The private halves, kept for {@link saveDeploymentKey}. Never leave the process. */
  privateKey: KeyObject;
  boxPrivate: KeyObject;
};

/** Mint a new pair of keys in memory. Nothing touches the disk until it is saved. */
export function generateDeploymentKey(): DeploymentKey {
  return deploymentKeyFrom(generateKeyPairSync("ed25519").privateKey, newBoxPrivate(), true);
}

/**
 * The key on the volume, or null when this deployment has never paired. Null
 * for an unreadable or corrupt file too: either way there is no usable identity
 * here, and the answer that matters is the same one.
 *
 * A file holding a signing key and no box key is not corrupt — it is a
 * deployment that paired before box keys existed. It reads as a key whose box
 * half was minted just now, flagged {@link DeploymentKey.boxKeyOnVolume} false
 * so the caller writes the file back before the handshake commits to it.
 */
export function readDeploymentKey(path: string): DeploymentKey | null {
  let signing: KeyObject | null = null;
  let box: KeyObject | null = null;
  try {
    for (const block of pemBlocks(readFileSync(path, "utf8"))) {
      let parsed: KeyObject;
      try {
        parsed = createPrivateKey(block);
      } catch {
        // One unreadable block among several is not the whole file's problem:
        // an operator who appended something is still a deployment with an
        // identity, and the keys this reader recognises are what it has.
        continue;
      }
      if (parsed.asymmetricKeyType === "ed25519" && signing === null) signing = parsed;
      if (parsed.asymmetricKeyType === "x25519" && box === null) box = parsed;
    }
  } catch {
    return null;
  }
  if (signing === null) return null;
  return deploymentKeyFrom(signing, box ?? newBoxPrivate(), box !== null);
}

/**
 * Write both keys to the volume at `0600`, creating `state/` if it is not
 * there. The signing key first, because that is the order the file has always
 * been in and an operator reading it should not have to wonder what changed.
 */
export function saveDeploymentKey(path: string, key: DeploymentKey): void {
  mkdirSync(dirname(path), { recursive: true });
  const contents = `${pem(key.privateKey)}${pem(key.boxPrivate)}`;
  writeFileSync(path, contents, { mode: 0o600 });
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

/** One PKCS#8 PEM block, with the trailing newline Node already writes. */
function pem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

/**
 * The PEM blocks in a file, in order. A regex rather than a split on the
 * armour, so anything between or around the blocks — a comment an operator
 * added, a stray blank line — is skipped rather than folded into a key.
 */
function pemBlocks(contents: string): string[] {
  return contents.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) ?? [];
}

/** A fresh box key. Its own function so both mint paths agree on the curve. */
function newBoxPrivate(): KeyObject {
  return generateKeyPairSync("x25519").privateKey;
}

/** Build the public forms from the private ones. */
function deploymentKeyFrom(
  privateKey: KeyObject,
  boxPrivate: KeyObject,
  boxKeyOnVolume: boolean,
): DeploymentKey {
  const publicKey = rawPublicKeyOf(createPublicKey(privateKey));
  const boxKey = rawBoxKeyOf(createPublicKey(boxPrivate));
  return {
    publicKey,
    fingerprint: fingerprintOf(publicKey),
    boxKey,
    boxPrivateKey: new Uint8Array(boxPrivate.export({ type: "pkcs8", format: "der" })),
    // Ed25519 signs the message itself — no digest argument, which is what the
    // `null` says. The message is the nonce and the box key together, so a
    // signature cannot be lifted onto a different box key.
    sign: (nonce: string) =>
      sign(null, helloSignedBytes(nonce, boxKey), privateKey).toString("base64url"),
    boxKeyOnVolume,
    privateKey,
    boxPrivate,
  };
}
