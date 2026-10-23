// The bearers at rest (map #690; the policy from #523 §5).
//
// A session's bearer is good for thirty days, so a copy of it read off a disk
// is a working credential until it expires or is revoked. That is why the only
// two answers here are "encrypted by the OS keyring" and "not written down at
// all", and why there is no third one where the file is plaintext and the app
// says nothing.
//
// Electron's `safeStorage` is the keyring: Keychain on macOS, DPAPI on Windows,
// and libsecret behind a session keyring on Linux. The last one is the one that
// is often missing — a headless box, a minimal desktop, a container — and there
// `isEncryptionAvailable()` is false. The companion then keeps the bearers in
// memory for the session, says so, and the operator pairs again at the next
// launch.
//
// One file for every remote, keyed by deployment id, because the record a
// bearer belongs to is keyed the same way (remotes.ts) and a vault per remote
// would be a directory of ciphertexts nobody can tell apart.
//
// `safeStorage` is a parameter rather than an import so this file needs no
// Electron to run: the whole of it is testable with a keyring that works, one
// that does not, and one that has rotated under an existing file.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** As much of Electron's `safeStorage` as this file touches. */
export type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
};

export type BearerVault = {
  /**
   * Whether this machine can encrypt at rest. False is not an error and not a
   * refusal to run — it is the companion declining to persist, which the rail
   * reports.
   */
  persists: boolean;
  /** The bearer for one deployment, or null when there is none this machine can read. */
  read: (deploymentId: string) => string | null;
  /** Keep a bearer across relaunches. Held in memory only when there is no keyring. */
  write: (deploymentId: string, bearer: string) => void;
  /** Forget one bearer. Idempotent. */
  clear: (deploymentId: string) => void;
};

/** The file in `userData` that holds the ciphertext. Never JSON, never readable. */
export const VAULT_FILENAME = "remote-bearers.bin";

/** What the rail says when there is no keyring to write to. */
export const NO_KEYRING_REASON: string =
  "This machine has no keyring the companion can encrypt to, so the pairing is not " +
  "being saved. It lasts until the companion quits.";

type Bearers = Record<string, string>;

export function createBearerVault(options: {
  safeStorage: SafeStorageLike;
  /** Electron's `userData` directory. */
  userDataDir: string;
  warn?: (message: string) => void;
}): BearerVault {
  const path = join(options.userDataDir, VAULT_FILENAME);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const persists = options.safeStorage.isEncryptionAvailable();
  /** The bearers this process holds when it cannot write them down. */
  const held: Bearers = {};

  function readAll(): Bearers {
    if (!persists) return held;
    let plain: string;
    try {
      plain = options.safeStorage.decryptString(readFileSync(path));
    } catch {
      // A missing file is the ordinary first launch. A file this machine can
      // no longer decrypt is a keyring that rotated under it, and the honest
      // reading of both is the same: there are no bearers here. Clearing it
      // keeps the next launch from trying again on bytes that will never open.
      rmSync(path, { force: true });
      return {};
    }
    try {
      const parsed = JSON.parse(plain) as unknown;
      return isBearers(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(bearers: Bearers): void {
    if (!persists) return;
    try {
      writeFileSync(path, options.safeStorage.encryptString(JSON.stringify(bearers)), {
        mode: 0o600,
      });
    } catch (error) {
      // The bearer is already live in memory; failing to write it down costs
      // the next launch a pairing and nothing else, so this is a complaint
      // rather than a throw that would take the pairing down with it.
      warn(`[phoebe] could not save the pairing: ${messageOf(error)}`);
    }
  }

  return {
    persists,

    read(deploymentId) {
      const bearer = readAll()[deploymentId];
      return typeof bearer === "string" && bearer !== "" ? bearer : null;
    },

    write(deploymentId, bearer) {
      if (!persists) {
        held[deploymentId] = bearer;
        return;
      }
      writeAll({ ...readAll(), [deploymentId]: bearer });
    },

    clear(deploymentId) {
      if (!persists) {
        delete held[deploymentId];
        return;
      }
      const bearers = readAll();
      if (!(deploymentId in bearers)) return;
      delete bearers[deploymentId];
      if (Object.keys(bearers).length === 0) rmSync(path, { force: true });
      else writeAll(bearers);
    },
  };
}

/** Enough of a shape check that a truncated or foreign file is not a vault. */
function isBearers(value: unknown): value is Bearers {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((bearer) => typeof bearer === "string")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
