// `devices.json` on the relay volume: the companions signed in to this relay
// (#523 §3, #554).
//
// A browser's session is a row in a map that dies with the process, and that is
// right for a browser — signing in again costs one redirect and the operator is
// already at the keyboard. A companion is not at the keyboard. It is an app the
// operator launched a week ago, so its credential outlives the relay's process
// or it is not worth having. That is the whole reason this file is on the
// volume and sessions.ts is not.
//
// **The token is never written down.** What the relay keeps is
// `SHA-256(token)`, so a copy of this file is not a set of working bearers. The
// token itself exists once, in the body of the exchange response, and after
// that only in the companion's keyring.
//
// **`id` is not derived from the token.** Removing a device names it by `id`,
// and that name travels to a console and back; deriving it from the hash would
// put a prefix of the secret's digest on a page.
//
// **No expiry, by decision.** A TTL on a bearer whose hash is already the only
// stored form buys nothing but a re-sign-in, so revocation is the only end a
// device token has (#523 §3).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEVICE_CODE_TTL_MS } from "../src/contracts/relay-routes.ts";
import type { RelayDevice } from "../src/contracts/relay-routes.ts";
import { pkceChallenge } from "./oidc.ts";

/** The name the file has on the relay volume. */
export const DEVICES_FILENAME = "devices.json";

/**
 * How stale a `lastSeenAt` is allowed to get before a request rewrites it. A
 * companion holds an event stream open and polls nothing, but its heartbeat and
 * its reads still arrive often enough that stamping every one would mean a
 * volume write per request for a field nobody reads to the second.
 */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

/** The longest device name the relay will record. A name is a label, not a payload. */
export const MAX_DEVICE_NAME = 120;

/** One device on the volume: the public record plus the hash that authenticates it. */
export type DeviceRecord = RelayDevice & {
  /** `SHA-256(token)`, hex. The token itself is never here. */
  tokenHash: string;
};

/** The file's shape. An object, not a bare array, so it can grow a field. */
export type DevicesFile = { devices: DeviceRecord[] };

/** Which devices a remove is asking for. Exactly one of the two is set. */
export type DeviceSelector = { id: string } | { sub: string };

export type Devices = {
  /** Issue a token for one signed-in person. The only time the token exists. */
  issue: (
    person: { sub: string; email: string },
    name: string,
    now: Date,
  ) => {
    token: string;
    device: RelayDevice;
  };
  /**
   * The device a bearer belongs to, or null. Stamps `lastSeenAt` when it has
   * drifted past `LAST_SEEN_RESOLUTION_MS`, which is the only write a read does.
   */
  authenticate: (token: string | undefined, now: Date) => RelayDevice | null;
  /** Every device the relay holds, in the order they were issued. */
  list: () => RelayDevice[];
  /** Revoke the device a bearer belongs to. Idempotent; a stranger's token is a no-op. */
  revoke: (token: string | undefined) => void;
  /** Revoke by name or by person. Returns how many went. */
  remove: (selector: DeviceSelector) => number;
};

/** Open the device store on `dataDir`. */
export function createDevices(dataDir: string): Devices {
  const path = join(dataDir, DEVICES_FILENAME);

  /** A missing, unreadable or malformed file is a relay nobody has signed a companion in to. */
  function read(): DevicesFile {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return { devices: [] };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DevicesFile>;
      return { devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
    } catch {
      return { devices: [] };
    }
  }

  /** Through a sibling temp file and `rename`, as every other file on the volume is. */
  function write(file: DevicesFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${process.pid}.${DEVICES_FILENAME}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  /** The record a bearer names, or null. */
  function match(file: DevicesFile, token: string | undefined): DeviceRecord | undefined {
    if (token === undefined || token === "") return undefined;
    const presented = hashToken(token);
    return file.devices.find((device) => sameDigest(device.tokenHash, presented));
  }

  return {
    issue(person, name, now) {
      // 256 bits from the CSPRNG. Opaque on purpose: a bearer the relay can look
      // up is a bearer that can be revoked, which a signed one could not be
      // without a revocation list that is this file by another name.
      const token = randomBytes(32).toString("base64url");
      const device: RelayDevice = {
        id: randomBytes(16).toString("base64url"),
        sub: person.sub,
        email: person.email,
        name: deviceName(name),
        createdAt: now.toISOString(),
        lastSeenAt: null,
      };
      const file = read();
      file.devices.push({ ...device, tokenHash: hashToken(token) });
      write(file);
      return { token, device };
    },

    authenticate(token, now) {
      const file = read();
      const record = match(file, token);
      if (record === undefined) return null;
      const seen = record.lastSeenAt === null ? 0 : Date.parse(record.lastSeenAt);
      if (!(now.getTime() - seen < LAST_SEEN_RESOLUTION_MS)) {
        record.lastSeenAt = now.toISOString();
        write(file);
      }
      return publicOf(record);
    },

    list() {
      return read().devices.map(publicOf);
    },

    revoke(token) {
      const file = read();
      const record = match(file, token);
      if (record === undefined) return;
      write({ devices: file.devices.filter((device) => device !== record) });
    },

    remove(selector) {
      const file = read();
      const keep = file.devices.filter((device) =>
        "id" in selector ? device.id !== selector.id : device.sub !== selector.sub,
      );
      const removed = file.devices.length - keep.length;
      if (removed > 0) write({ devices: keep });
      return removed;
    },
  };
}

/** The record without its hash — what a console is allowed to see. */
function publicOf(record: DeviceRecord): RelayDevice {
  const { tokenHash: _hash, ...device } = record;
  return device;
}

/** `SHA-256(token)`, hex. The one direction this file ever goes. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Two digests, compared without leaking where they first differ. The stored
 * side is already a hash, so the leak this closes is narrow — but a scan over
 * every device is exactly the loop a timing signal is read off, and
 * `timingSafeEqual` costs nothing here.
 */
function sameDigest(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(presented, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A name the relay is willing to write down: trimmed, capped, never empty. */
function deviceName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, MAX_DEVICE_NAME);
  return trimmed === "" ? "a companion" : trimmed;
}

/**
 * The bearer on one request, or undefined. Case-insensitive on the scheme, as
 * RFC 7235 requires, and strict about there being exactly one space.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match === null ? undefined : match[1];
}

// ───────────────────────────── the one-time code ─────────────────────────────

/**
 * What a spent code hands back: who signed in, and what their companion calls
 * itself. Held in memory for sixty seconds and nowhere else.
 */
export type DeviceGrant = { sub: string; email: string; name: string };

export type DeviceCodes = {
  /** Park a completed sign-in behind a fresh code bound to `challenge`. */
  mint: (grant: DeviceGrant & { challenge: string }, now: number) => string;
  /**
   * Spend a code. Null unless it exists, is fresh, and the verifier hashes to
   * the challenge it was minted against. Single use either way.
   */
  spend: (
    code: string | undefined,
    verifier: string | undefined,
    now: number,
  ) => DeviceGrant | null;
};

/**
 * The codes in flight, in memory (#523 §2). In memory rather than on the volume
 * because the whole of a code's life is one OS handover: the relay mints it,
 * redirects a browser at the scheme, and the companion spends it within the
 * second. A relay that restarts in that window has lost a sign-in the operator
 * repeats with one click.
 */
export function createDeviceCodes(): DeviceCodes {
  const codes = new Map<string, DeviceGrant & { challenge: string; createdAt: number }>();

  return {
    mint(grant, now) {
      // Swept on write, as pre-auth is: a relay nobody is signing into has
      // nothing to sweep, and the map is bounded by sign-ins in flight.
      for (const [code, entry] of codes) {
        if (now - entry.createdAt > DEVICE_CODE_TTL_MS) codes.delete(code);
      }
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { ...grant, createdAt: now });
      return code;
    },

    spend(code, verifier, now) {
      if (code === undefined || verifier === undefined) return null;
      const entry = codes.get(code);
      if (entry === undefined) return null;
      // Deleted before it is judged, whether or not it turns out to be good: a
      // code that failed its PKCE check must not get a second attempt.
      codes.delete(code);
      if (now - entry.createdAt > DEVICE_CODE_TTL_MS) return null;
      if (!sameChallenge(entry.challenge, verifier)) return null;
      return { sub: entry.sub, email: entry.email, name: entry.name };
    },
  };
}

/** Whether `verifier` is the secret behind `challenge`. */
function sameChallenge(challenge: string, verifier: string): boolean {
  const expected = Buffer.from(challenge, "utf8");
  const actual = Buffer.from(pkceChallenge(verifier), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
