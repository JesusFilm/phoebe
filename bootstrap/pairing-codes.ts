// Pairing codes (map #690, decided in #695): what a host verb mints and a device
// spends for a session.
//
// Twelve characters of Crockford base32 — digits and letters with I, L, O and U
// left out — 60 bits, shown as `XXXX-XXXX-XXXX` and normalised on redeem
// (uppercase, dashes and spaces stripped, I and L read as 1, O as 0). Five
// minutes to live. Single use: the redeem deletes the pending entry before it
// checks anything else, so a failed attempt never gets a second one. At most
// eight pending at once.
//
// The code itself exists in the root process that minted it and on the device
// that typed it. What crosses into the bootstrapper is `{ nonce, hash, scopes,
// expiresAt }` through the mint drop (mint-drop.ts); what the bootstrapper
// keeps is this in-memory map of hashes, which a relaunch empties.

import { createHash, randomBytes } from "node:crypto";
import type { RemoteScope } from "../src/contracts/remote-protocol.ts";
import { CROCKFORD_ALPHABET } from "./deployment-id.ts";

/** A code's length, in characters of the alphabet. */
export const CODE_LENGTH = 12;

/** A code's life, from mint. */
export const CODE_LIFETIME_MS = 5 * 60_000;

/** How many codes may wait to be spent at once. */
export const MAX_PENDING_CODES = 8;

/** A fresh code, unformatted: twelve uniform draws from the alphabet. */
export function generateCode(random: (n: number) => Buffer = randomBytes): string {
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of random(16)) {
      out += CROCKFORD_ALPHABET[byte & 31];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** `XXXX-XXXX-XXXX`, the shape a person reads and types. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/**
 * What a person typed, read back as a code, or null when it cannot be one.
 * Case, dashes and spaces are forgiven; so are the four letters the alphabet
 * leaves out, read as the digits they resemble. Anything else, or any other
 * length, is not a code — eleven characters is a typo, not a near miss.
 */
export function normalizeCode(input: string): string | null {
  const stripped = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (stripped.length !== CODE_LENGTH) return null;
  for (const char of stripped) if (!CROCKFORD_ALPHABET.includes(char)) return null;
  return stripped;
}

/** `SHA-256(code)`, hex, over the normalised code. */
export function hashCode(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** What the drop file carries, and what the pending map holds. */
export type PendingCode = {
  nonce: string;
  hash: string;
  scopes: RemoteScope[];
  /** ISO. */
  expiresAt: string;
};

export type PendingCodes = {
  /** Hold a minted code. False when the map is full. */
  add: (code: PendingCode, now: number) => boolean;
  /**
   * Spend a code by its hash. The entry is deleted before anything is judged,
   * whether or not it turns out to be good; null unless it existed and was fresh.
   */
  spend: (hash: string, now: number) => { scopes: RemoteScope[] } | null;
  /** How many are waiting. */
  size: (now: number) => number;
};

/** The codes in flight, in memory. */
export function createPendingCodes(max: number = MAX_PENDING_CODES): PendingCodes {
  const pending = new Map<string, PendingCode>();

  /** Swept on every touch: a code nobody spent is gone at five minutes. */
  const sweep = (now: number): void => {
    for (const [hash, code] of pending) {
      if (Date.parse(code.expiresAt) <= now) pending.delete(hash);
    }
  };

  return {
    add(code, now) {
      sweep(now);
      if (pending.size >= max) return false;
      pending.set(code.hash, code);
      return true;
    },
    spend(hash, now) {
      const entry = pending.get(hash);
      if (entry === undefined) return null;
      pending.delete(hash);
      if (Date.parse(entry.expiresAt) <= now) return null;
      return { scopes: [...entry.scopes] };
    },
    size(now) {
      sweep(now);
      return pending.size;
    },
  };
}

/** Read one drop file's JSON back as a pending code, or null. */
export function parsePendingCode(raw: string): PendingCode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { nonce, hash, scopes, expiresAt } = record;
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return null;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) return null;
  if (!Array.isArray(scopes) || !scopes.every((s) => s === "read" || s === "operate")) return null;
  if (!scopes.includes("read")) return null;
  return { nonce, hash, scopes: [...new Set(scopes as RemoteScope[])], expiresAt };
}
