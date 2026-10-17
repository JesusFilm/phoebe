// The bearers at rest: encrypted, or not written at all (map #690, #523 §5).
//
// The keyring is a parameter, so the three cases that matter all run here — one
// that works, one that is not there, and one that has rotated under a file the
// companion already wrote. The third is the interesting one: on a machine whose
// keyring changed, the ciphertext on disk will never open again, and a
// companion that keeps trying is a companion that never pairs.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { createBearerVault, VAULT_FILENAME, type SafeStorageLike } from "./vault.ts";

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

describe("the bearer vault", () => {
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

  test("keeps bearers across relaunches, keyed by deployment, and never in the clear", () => {
    const vault = createBearerVault({ safeStorage: keyring(), userDataDir });

    vault.write("dep_A", "bearer-a");
    vault.write("dep_B", "bearer-b");

    expect(readFileSync(file(), "utf8")).not.toContain("bearer-a");
    const again = createBearerVault({ safeStorage: keyring(), userDataDir });
    expect(again.read("dep_A")).toBe("bearer-a");
    expect(again.read("dep_B")).toBe("bearer-b");
    expect(again.read("dep_C")).toBeNull();
  });

  test("with no keyring it writes nothing, holds the bearer for the session, and says so", () => {
    const vault = createBearerVault({ safeStorage: NO_KEYRING, userDataDir });

    vault.write("dep_A", "bearer-a");

    expect(vault.persists).toBe(false);
    expect(existsSync(file())).toBe(false);
    expect(vault.read("dep_A")).toBe("bearer-a");
    expect(createBearerVault({ safeStorage: NO_KEYRING, userDataDir }).read("dep_A")).toBeNull();
  });

  test("a keyring that rotated under the file is no bearer, and the file goes", () => {
    createBearerVault({ safeStorage: keyring("old"), userDataDir }).write("dep_A", "bearer-a");

    const after = createBearerVault({ safeStorage: keyring("new"), userDataDir });

    expect(after.read("dep_A")).toBeNull();
    expect(existsSync(file())).toBe(false);
  });

  test("a file that decrypts to something that is not a vault holds nothing", () => {
    writeFileSync(file(), keyring().encryptString(JSON.stringify(["x"])));

    expect(createBearerVault({ safeStorage: keyring(), userDataDir }).read("dep_A")).toBeNull();
  });

  test("clearing forgets one bearer, keeps the others, and removes the file with the last", () => {
    const vault = createBearerVault({ safeStorage: keyring(), userDataDir });
    vault.write("dep_A", "bearer-a");
    vault.write("dep_B", "bearer-b");

    vault.clear("dep_A");
    vault.clear("dep_A");
    expect(vault.read("dep_A")).toBeNull();
    expect(vault.read("dep_B")).toBe("bearer-b");

    vault.clear("dep_B");
    expect(existsSync(file())).toBe(false);
  });
});
