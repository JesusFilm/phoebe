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
 * plaintext is not on disk and that another keyring's bytes do not open. A
 * keyring that has `retired` a marker still opens its bytes, and says they
 * want encrypting again, the way Electron does after a key rotation it can
 * still read through.
 */
function keyring(marker = "k", retired: string[] = []): SafeStorageLike {
  const encrypt = (plain: string): Buffer =>
    Buffer.from(`${marker}:${Buffer.from(plain, "utf8").toString("base64")}`, "utf8");
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain) => encrypt(plain),
    decryptStringAsync: async (cipher) => {
      const text = cipher.toString("utf8");
      const opener = [marker, ...retired].find((m) => text.startsWith(`${m}:`));
      if (opener === undefined) throw new Error("not this keyring's ciphertext");
      return {
        shouldReEncrypt: opener !== marker,
        result: Buffer.from(text.slice(opener.length + 1), "base64").toString("utf8"),
      };
    },
  };
}

/** Linux with no session keyring: the case that decides the whole policy. */
const NO_KEYRING: SafeStorageLike = {
  isAsyncEncryptionAvailable: async () => false,
  encryptStringAsync: async () => {
    throw new Error("no keyring");
  },
  decryptStringAsync: async () => {
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

  test("keeps bearers across relaunches, keyed by deployment, and never in the clear", async () => {
    const vault = await createBearerVault({ safeStorage: keyring(), userDataDir });

    await vault.write("dep_A", "bearer-a");
    await vault.write("dep_B", "bearer-b");

    expect(vault.persists).toBe(true);
    expect(readFileSync(file(), "utf8")).not.toContain("bearer-a");
    const again = await createBearerVault({ safeStorage: keyring(), userDataDir });
    expect(await again.read("dep_A")).toBe("bearer-a");
    expect(await again.read("dep_B")).toBe("bearer-b");
    expect(await again.read("dep_C")).toBeNull();
  });

  test("two writes asked for together both land", async () => {
    const vault = await createBearerVault({ safeStorage: keyring(), userDataDir });

    await Promise.all([vault.write("dep_A", "bearer-a"), vault.write("dep_B", "bearer-b")]);

    const again = await createBearerVault({ safeStorage: keyring(), userDataDir });
    expect(await again.read("dep_A")).toBe("bearer-a");
    expect(await again.read("dep_B")).toBe("bearer-b");
  });

  test("with no keyring it writes nothing, holds the bearer for the session, and says so", async () => {
    const vault = await createBearerVault({ safeStorage: NO_KEYRING, userDataDir });

    await vault.write("dep_A", "bearer-a");

    expect(vault.persists).toBe(false);
    expect(existsSync(file())).toBe(false);
    expect(await vault.read("dep_A")).toBe("bearer-a");
    const relaunched = await createBearerVault({ safeStorage: NO_KEYRING, userDataDir });
    expect(await relaunched.read("dep_A")).toBeNull();
  });

  test("a keyring that cannot say whether it is there is no keyring", async () => {
    const vault = await createBearerVault({
      safeStorage: {
        ...keyring(),
        isAsyncEncryptionAvailable: () => Promise.reject(new Error("no D-Bus")),
      },
      userDataDir,
    });

    await vault.write("dep_A", "bearer-a");

    expect(vault.persists).toBe(false);
    expect(existsSync(file())).toBe(false);
  });

  test("a keyring that cannot open the file is no bearer, and the file stays", async () => {
    await (
      await createBearerVault({ safeStorage: keyring("old"), userDataDir })
    ).write("dep_A", "bearer-a");

    const after = await createBearerVault({
      safeStorage: keyring("new"),
      userDataDir,
      warn: () => undefined,
    });

    expect(await after.read("dep_A")).toBeNull();
    expect(existsSync(file())).toBe(true);
  });

  test("a pairing made while the file will not open lasts the session and leaves the file alone", async () => {
    await (
      await createBearerVault({ safeStorage: keyring("old"), userDataDir })
    ).write("dep_A", "bearer-a");
    const before = readFileSync(file(), "utf8");
    const after = await createBearerVault({
      safeStorage: keyring("new"),
      userDataDir,
      warn: () => undefined,
    });

    await after.write("dep_B", "bearer-b");

    expect(await after.read("dep_B")).toBe("bearer-b");
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  test("a file the keyring opens but wants encrypting again is written back under the new key", async () => {
    await (
      await createBearerVault({ safeStorage: keyring("old"), userDataDir })
    ).write("dep_A", "bearer-a");

    const rotated = await createBearerVault({ safeStorage: keyring("new", ["old"]), userDataDir });
    expect(await rotated.read("dep_A")).toBe("bearer-a");

    expect(readFileSync(file(), "utf8").startsWith("new:")).toBe(true);
    const later = await createBearerVault({ safeStorage: keyring("new"), userDataDir });
    expect(await later.read("dep_A")).toBe("bearer-a");
  });

  test("a file that decrypts to something that is not a vault holds nothing", async () => {
    writeFileSync(file(), await keyring().encryptStringAsync(JSON.stringify(["x"])));

    const vault = await createBearerVault({ safeStorage: keyring(), userDataDir });
    expect(await vault.read("dep_A")).toBeNull();
  });

  test("clearing forgets one bearer, keeps the others, and removes the file with the last", async () => {
    const vault = await createBearerVault({ safeStorage: keyring(), userDataDir });
    await vault.write("dep_A", "bearer-a");
    await vault.write("dep_B", "bearer-b");

    await vault.clear("dep_A");
    await vault.clear("dep_A");
    expect(await vault.read("dep_A")).toBeNull();
    expect(await vault.read("dep_B")).toBe("bearer-b");

    await vault.clear("dep_B");
    expect(existsSync(file())).toBe(false);
  });
});
