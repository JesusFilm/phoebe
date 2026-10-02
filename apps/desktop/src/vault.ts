// The device token at rest (#523 §5).
//
// A device token has no expiry, so a copy of it read off a disk is a working
// credential for as long as nobody revokes it. That is why the only two answers
// here are "encrypted by the OS keyring" and "not written down at all", and why
// there is no third one where the file is plaintext and the app says nothing.
//
// Electron's `safeStorage` is the keyring: Keychain on macOS, DPAPI on Windows,
// and libsecret behind a session keyring on Linux. The last one is the one that
// is often missing — a headless box, a minimal desktop, a container — and there
// `isEncryptionAvailable()` is false. The companion then keeps the token in
// memory for the session, says so in the rail, and the operator signs in again
// at the next launch.
//
// `safeStorage` is a parameter rather than an import so this file needs no
// Electron to run: the whole of it is testable with a keyring that works, one
// that does not, and one that has rotated under an existing file.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayIdentity } from "phoebe-agent/contracts";

/** What survives a relaunch: which relay, the bearer, and who it belongs to. */
export type StoredSession = {
  /** The relay's origin, with no trailing slash. */
  url: string;
  /** The opaque device token. The only secret in the file. */
  token: string;
  person: RelayIdentity;
};

/** As much of Electron's `safeStorage` as this file touches. */
export type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
};

export type TokenVault = {
  /**
   * Whether this machine can encrypt at rest. False is not an error and not a
   * refusal to run — it is the companion declining to persist, which the rail
   * reports (#523 §5).
   */
  persists: boolean;
  /** The stored session, or null when there is none this machine can read. */
  read: () => StoredSession | null;
  /** Keep a session across relaunches. A no-op with no keyring. */
  write: (session: StoredSession) => void;
  /** Forget the stored session. Idempotent. */
  clear: () => void;
};

/** The file in `userData` that holds the ciphertext. Never JSON, never readable. */
export const VAULT_FILENAME = "relay-session.bin";

/** What the rail says when there is no keyring to write to. */
export const NO_KEYRING_REASON: string =
  "This machine has no keyring the companion can encrypt to, so the sign-in is not " +
  "being saved. It lasts until the companion quits.";

export function createTokenVault(options: {
  safeStorage: SafeStorageLike;
  /** Electron's `userData` directory. */
  userDataDir: string;
  warn?: (message: string) => void;
}): TokenVault {
  const path = join(options.userDataDir, VAULT_FILENAME);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const persists = options.safeStorage.isEncryptionAvailable();

  return {
    persists,

    read() {
      if (!persists) return null;
      let plain: string;
      try {
        plain = options.safeStorage.decryptString(readFileSync(path));
      } catch {
        // A missing file is the ordinary first launch. A file this machine can
        // no longer decrypt is a keyring that rotated under it, and the honest
        // reading of both is the same: there is no session here. Clearing it
        // keeps the next launch from trying again on bytes that will never open.
        rmSync(path, { force: true });
        return null;
      }
      try {
        const parsed = JSON.parse(plain) as Partial<StoredSession>;
        return isSession(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    write(session) {
      if (!persists) return;
      try {
        writeFileSync(path, options.safeStorage.encryptString(JSON.stringify(session)), {
          mode: 0o600,
        });
      } catch (error) {
        // The session is already live in memory; failing to write it down costs
        // the next launch a sign-in and nothing else, so this is a complaint
        // rather than a throw that would take the sign-in down with it.
        warn(`[phoebe] could not save the relay sign-in: ${messageOf(error)}`);
      }
    },

    clear() {
      rmSync(path, { force: true });
    },
  };
}

/** Enough of a shape check that a truncated or foreign file is not a session. */
function isSession(value: Partial<StoredSession>): value is StoredSession {
  return (
    typeof value.url === "string" &&
    typeof value.token === "string" &&
    value.token !== "" &&
    typeof value.person === "object" &&
    value.person !== null &&
    typeof value.person.sub === "string" &&
    typeof value.person.email === "string"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
