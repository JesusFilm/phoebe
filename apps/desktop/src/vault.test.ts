// The token at rest: encrypted, or not written at all (#523 §5).
//
// The keyring is a parameter, so the three cases that matter all run here — one
// that works, one that is not there, and one that has rotated under a file the
// companion already wrote. The third is the interesting one: on a machine whose
// keyring changed, the ciphertext on disk will never open again, and a
// companion that keeps trying is a companion that never signs in.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { createTokenVault, VAULT_FILENAME, type SafeStorageLike } from "./vault.ts";

const SESSION = {
  url: "https://relay.example.test",
  token: "a-device-token",
  person: { sub: "sub-ada", email: "ada@example.test" },
};

/**
 * A keyring that works. The stand-in only has to be reversible and opaque —
 * base64 behind a per-keyring marker — because what these tests hold is that the
 * plaintext is not on disk and that another keyring's bytes do not open.
 */
function keyring(marker = "k"): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) =>
      Buffer.from(`${marker}:${Buffer.from(plain, "utf8").toString("base64")}`, "utf8"),
    decryptString: (cipher) => {
      const text = cipher.toString("utf8");
      if (!text.startsWith(`${marker}:`)) throw new Error("not this keyring's ciphertext");
      return Buffer.from(text.slice(marker.length + 1), "base64").toString("utf8");
    },
  };
}

/** Linux with no session keyring: the case that decides the whole policy. */
const NO_KEYRING: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("no keyring");
  },
  decryptString: () => {
    throw new Error("no keyring");
  },
};

describe("the token vault", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "phoebe-vault-"));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  function file(): string {
    return join(userDataDir, VAULT_FILENAME);
  }

  test("keeps a session across relaunches, and never in the clear", () => {
    const vault = createTokenVault({ safeStorage: keyring(), userDataDir });

    vault.write(SESSION);

    expect(readFileSync(file(), "utf8")).not.toContain("a-device-token");
    expect(createTokenVault({ safeStorage: keyring(), userDataDir }).read()).toEqual(SESSION);
  });

  test("with no keyring it writes nothing and says it does not persist", () => {
    const vault = createTokenVault({ safeStorage: NO_KEYRING, userDataDir });

    vault.write(SESSION);

    expect(vault.persists).toBe(false);
    expect(existsSync(file())).toBe(false);
    expect(vault.read()).toBeNull();
  });

  test("a keyring that rotated under the file is no session, and the file goes", () => {
    createTokenVault({ safeStorage: keyring("old"), userDataDir }).write(SESSION);

    const after = createTokenVault({ safeStorage: keyring("new"), userDataDir });

    expect(after.read()).toBeNull();
    expect(existsSync(file())).toBe(false);
  });

  test("nothing written yet is no session, not an error", () => {
    expect(createTokenVault({ safeStorage: keyring(), userDataDir }).read()).toBeNull();
  });

  test("a file that decrypts to something that is not a session is no session", () => {
    writeFileSync(file(), keyring().encryptString(JSON.stringify({ url: "x" })));

    expect(createTokenVault({ safeStorage: keyring(), userDataDir }).read()).toBeNull();
  });

  test("clearing forgets it, and forgetting twice is not an error", () => {
    const vault = createTokenVault({ safeStorage: keyring(), userDataDir });
    vault.write(SESSION);

    vault.clear();
    vault.clear();

    expect(vault.read()).toBeNull();
  });
});
