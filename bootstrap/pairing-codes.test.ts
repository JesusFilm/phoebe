// Pairing codes (map #690, #695): alphabet, length, formatting, the
// normalisation table, single use, expiry, and the cap of eight.

import { describe, expect, test } from "vite-plus/test";
import {
  CODE_LIFETIME_MS,
  createPendingCodes,
  formatCode,
  generateCode,
  hashCode,
  normalizeCode,
  parsePendingCode,
} from "./pairing-codes.ts";

describe("the code", () => {
  test("twelve Crockford characters, no I, L, O or U, shown in three groups", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
      expect(formatCode(code)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
  });

  test("normalisation forgives case, dashes, spaces, and the four look-alikes", () => {
    expect(normalizeCode("abcd-efgh-jk12")).toBe("ABCDEFGHJK12");
    expect(normalizeCode(" ABCD EFGH JK12 ")).toBe("ABCDEFGHJK12");
    expect(normalizeCode("ILIL-OOOO-1234")).toBe("111100001234");
    expect(normalizeCode("ABCD-EFGH-JK1")).toBeNull();
    expect(normalizeCode("ABCD-EFGH-JK123")).toBeNull();
    expect(normalizeCode("ABCD-EFGH-JKU2")).toBeNull();
    expect(normalizeCode("")).toBeNull();
  });

  test("the hash is over the normalised code", () => {
    expect(hashCode(normalizeCode("abcd-efgh-jk12")!)).toBe(hashCode("ABCDEFGHJK12"));
  });
});

describe("the pending map", () => {
  const T0 = 1_000_000;
  const code = (hash: string, expiresAt = new Date(T0 + CODE_LIFETIME_MS).toISOString()) => ({
    nonce: `n-${hash}`,
    hash,
    scopes: ["read" as const],
    expiresAt,
  });

  test("single use: the second spend of the same hash is rejected", () => {
    const pending = createPendingCodes();
    expect(pending.add(code("h1"), T0)).toBe(true);
    expect(pending.spend("h1", T0 + 1)).toEqual({ scopes: ["read"] });
    expect(pending.spend("h1", T0 + 2)).toBeNull();
  });

  test("an expired code is deleted on the attempt and rejected", () => {
    const pending = createPendingCodes();
    pending.add(code("h1"), T0);
    expect(pending.spend("h1", T0 + CODE_LIFETIME_MS)).toBeNull();
    expect(pending.size(T0 + CODE_LIFETIME_MS)).toBe(0);
  });

  test("a ninth pending code is refused; expiry makes room", () => {
    const pending = createPendingCodes();
    for (let i = 0; i < 8; i++) expect(pending.add(code(`h${i}`), T0)).toBe(true);
    expect(pending.add(code("h9"), T0)).toBe(false);
    expect(pending.size(T0)).toBe(8);
    expect(pending.add(code("h9"), T0 + CODE_LIFETIME_MS)).toBe(true);
  });

  test("the drop file's shape is checked before it is trusted", () => {
    const good = JSON.stringify({
      nonce: "abcdefgh",
      hash: "a".repeat(64),
      scopes: ["read", "operate"],
      expiresAt: new Date(T0).toISOString(),
    });
    expect(parsePendingCode(good)).toEqual({
      nonce: "abcdefgh",
      hash: "a".repeat(64),
      scopes: ["read", "operate"],
      expiresAt: new Date(T0).toISOString(),
    });
    expect(parsePendingCode("nope")).toBeNull();
    expect(
      parsePendingCode(
        JSON.stringify({ nonce: "abcdefgh", hash: "zz", scopes: ["read"], expiresAt: "x" }),
      ),
    ).toBeNull();
    expect(
      parsePendingCode(
        JSON.stringify({
          nonce: "abcdefgh",
          hash: "a".repeat(64),
          scopes: ["operate"],
          expiresAt: new Date(T0).toISOString(),
        }),
      ),
    ).toBeNull();
    expect(
      parsePendingCode(
        JSON.stringify({
          nonce: "abcdefgh",
          hash: "a".repeat(64),
          scopes: ["root"],
          expiresAt: new Date(T0).toISOString(),
        }),
      ),
    ).toBeNull();
  });
});
