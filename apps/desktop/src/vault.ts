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
// `isAsyncEncryptionAvailable()` resolves false. The companion then keeps the
// bearers in memory for the session, says so, and the operator pairs again at
// the next launch.
//
// One file for every remote, keyed by deployment id, because the record a
// bearer belongs to is keyed the same way (remotes.ts) and a vault per remote
// would be a directory of ciphertexts nobody can tell apart.
//
// `safeStorage` is a parameter rather than an import so this file needs no
// Electron to run: the whole of it is testable with a keyring that works, one
// that does not, and one that has rotated under an existing file.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the keyring hands back from a decrypt: the plaintext, and whether it
 * wants it encrypted again under a newer key.
 */
export type Decrypted = { shouldReEncrypt: boolean; result: string };

/**
 * As much of Electron's `safeStorage` as this file touches. The async half
 * only: Electron deprecated the sync one and says it will go.
 */
export type SafeStorageLike = {
  isAsyncEncryptionAvailable: () => Promise<boolean>;
  encryptStringAsync: (plainText: string) => Promise<Buffer>;
  decryptStringAsync: (encrypted: Buffer) => Promise<Decrypted>;
};

export type BearerVault = {
  /**
   * Whether this machine can encrypt at rest. False is not an error and not a
   * refusal to run — it is the companion declining to persist, which the rail
   * reports.
   */
  persists: boolean;
  /** The bearer for one deployment, or null when there is none this machine can read. */
  read: (deploymentId: string) => Promise<string | null>;
  /** Keep a bearer across relaunches. Held in memory only when there is no keyring. */
  write: (deploymentId: string, bearer: string) => Promise<void>;
  /** Forget one bearer. Idempotent. */
  clear: (deploymentId: string) => Promise<void>;
};

/** The file in `userData` that holds the ciphertext. Never JSON, never readable. */
export const VAULT_FILENAME = "remote-bearers.bin";

/** What the rail says when there is no keyring to write to. */
export const NO_KEYRING_REASON: string =
  "This machine has no keyring the companion can encrypt to, so the pairing is not " +
  "being saved. It lasts until the companion quits.";

type Bearers = Record<string, string>;

/**
 * Resolves once the keyring has said whether it is there, so `persists` is a
 * plain answer on the vault rather than one its readers have to wait for.
 */
export async function createBearerVault(options: {
  safeStorage: SafeStorageLike;
  /** Electron's `userData` directory. */
  userDataDir: string;
  warn?: (message: string) => void;
}): Promise<BearerVault> {
  const path = join(options.userDataDir, VAULT_FILENAME);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  // A keyring that cannot say whether it is there is not one to write to.
  const persists = await options.safeStorage.isAsyncEncryptionAvailable().catch(() => false);
  /** The bearers this process holds when it cannot write them down. */
  const held: Bearers = {};
  /**
   * Each operation reads the whole file and writes it back, so two pairings
   * landing together would each write a file without the other's bearer. One
   * at a time, in the order they were asked for.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  };

  /**
   * The bearers on disk, or null when the file is there and will not open. The
   * file is left alone in that case: the keyring may only be busy, and deleting
   * the file would take every other remote's bearer with it.
   */
  async function readAll(): Promise<Bearers | null> {
    if (!persists) return held;
    if (!existsSync(path)) return {};
    let decrypted: Decrypted;
    try {
      decrypted = await options.safeStorage.decryptStringAsync(readFileSync(path));
    } catch (error) {
      warn(`[phoebe] could not open the saved pairings: ${messageOf(error)}`);
      return null;
    }
    let bearers: Bearers;
    try {
      const parsed = JSON.parse(decrypted.result) as unknown;
      bearers = isBearers(parsed) ? parsed : {};
    } catch {
      return {};
    }
    // Opened with a key the keyring has since moved on from. Written back under
    // the current one, the file survives the old key going away.
    if (decrypted.shouldReEncrypt) await writeAll(bearers);
    return bearers;
  }

  async function writeAll(bearers: Bearers): Promise<void> {
    if (!persists) return;
    try {
      writeFileSync(path, await options.safeStorage.encryptStringAsync(JSON.stringify(bearers)), {
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

    read: (deploymentId) =>
      inTurn(async () => {
        const bearer = held[deploymentId] ?? (await readAll())?.[deploymentId];
        return typeof bearer === "string" && bearer !== "" ? bearer : null;
      }),

    write: (deploymentId, bearer) =>
      inTurn(async () => {
        if (!persists) {
          held[deploymentId] = bearer;
          return;
        }
        const saved = await readAll();
        if (saved === null) {
          // The file holds pairings this process cannot read; writing over it
          // would lose them. This one lasts the session.
          held[deploymentId] = bearer;
          return;
        }
        await writeAll({ ...saved, [deploymentId]: bearer });
      }),

    clear: (deploymentId) =>
      inTurn(async () => {
        if (!persists) {
          delete held[deploymentId];
          return;
        }
        delete held[deploymentId];
        const bearers = await readAll();
        if (bearers === null || !(deploymentId in bearers)) return;
        delete bearers[deploymentId];
        if (Object.keys(bearers).length === 0) rmSync(path, { force: true });
        else await writeAll(bearers);
      }),
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
