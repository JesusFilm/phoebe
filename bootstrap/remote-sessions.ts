// `state/sessions.json` on the data volume: the devices paired with this
// deployment (map #690, decided in #696). The relay's `devices.ts` moved onto
// the volume, almost line for line, plus the two things a volume shared with
// tenant children makes necessary.
//
// **The token is never written down.** What the deployment keeps is
// `SHA-256(token)`, so a copy of this file is not a set of working bearers. The
// token exists once, in the body of the pair response, and after that only in
// the companion's keyring.
//
// **`id` is not derived from the hash.** Revoking names a session by `id`, and
// that name travels to a page and back.
//
// **The limit the store has to own.** Tenant children share uid 10001 with the
// bootstrapper, so hashing keeps a copy of the file from being a set of
// bearers, but it does not keep a child from *appending* a row whose hash it
// chose. No key or HMAC mends that: anything the bootstrapper can read, a child
// can read. So the bootstrapper keeps the last bytes it wrote, and a file that
// differs on the next read sets `tampered`, which the report carries and the
// doctor `remote` check fails on. Across a relaunch it cannot tell, and says
// nothing. Every row shows in the devices list, so a forged one is on the page
// the owner looks at.
//
// **Expiry has no sweep timer.** A row past `expiresAt` cannot authenticate
// (the 401 says `expired`), is dropped on the next write, and until then is
// listed as expired — an expired row is still worth being able to revoke.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  RemoteDeviceType,
  RemoteScope,
  SessionRow,
} from "../src/contracts/remote-protocol.ts";

/** The file's name inside the deployment-level `state/` directory. */
export const SESSIONS_FILE = "sessions.json";

export function sessionsPath(dataBase: string): string {
  return join(dataBase, "state", SESSIONS_FILE);
}

/** A session lives this long from its pair. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale `lastSeenAt` may get before a request rewrites it. A stream's
 * reads arrive often; stamping every one would be a volume write per request
 * for a field nobody reads to the second.
 */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

/** The longest label the deployment records. A label is a label, not a payload. */
export const MAX_SESSION_LABEL = 120;

/** One row on the volume: the public record plus the hash that authenticates it. */
export type SessionRecord = SessionRow & {
  /** `SHA-256(token)`, hex. The token itself is never here. */
  tokenHash: string;
};

/** The file's shape. An object, not a bare array, so it can grow a field. */
export type SessionsFile = { sessions: SessionRecord[] };

/** What a pair hands the store: the code's scopes and the client's own words. */
export type SessionIssue = {
  scopes: RemoteScope[];
  label: string;
  deviceType: RemoteDeviceType;
  os: string;
  pairedAs: string | null;
};

export type Authenticated =
  | { ok: true; row: SessionRow }
  | { ok: false; reason: "unknown" | "expired" };

export type Sessions = {
  /** Issue a token for one pair. The only time the token exists. */
  issue: (issue: SessionIssue, now: Date) => { token: string; row: SessionRow };
  /**
   * The session a bearer belongs to. Stamps `lastSeenAt` when it has drifted
   * past `LAST_SEEN_RESOLUTION_MS`, which is the only write a read does.
   */
  authenticate: (token: string | undefined, now: Date) => Authenticated;
  /** Every row, expired ones included, in the order they were issued. */
  list: (now: Date) => SessionRow[];
  /** One row by id, or null. */
  byId: (id: string) => SessionRow | null;
  /** Revoke by id. True when a row went. */
  revoke: (id: string) => boolean;
  /** Revoke every row. How many went. */
  revokeAll: () => number;
  /** The report's two numbers. */
  counts: (now: Date) => { active: number; expired: number };
  /** The file differs from what this process last wrote. */
  tampered: () => boolean;
};

export type SessionsDeps = {
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  random?: (n: number) => Buffer;
  /** One line on the bootstrapper's channel when the file is found moved. */
  onTampered?: (path: string) => void;
  /** One line when the file would not parse. */
  onMalformed?: (path: string) => void;
};

/** `SHA-256(token)`, hex. The one direction this file ever goes. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A label the deployment is willing to write down: trimmed, collapsed, capped, never empty. */
export function sessionLabel(label: string): string {
  const trimmed = label.trim().replace(/\s+/g, " ").slice(0, MAX_SESSION_LABEL);
  return trimmed === "" ? "a device" : trimmed;
}

/** Is this row past its expiry? */
export function isExpired(row: SessionRow, now: Date): boolean {
  const at = Date.parse(row.expiresAt);
  return !Number.isFinite(at) || at <= now.getTime();
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

/** Two digests, compared without leaking where they first differ. */
function sameDigest(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(presented, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The record without its hash — what a page is allowed to see. */
function publicOf(record: SessionRecord): SessionRow {
  const { tokenHash: _hash, ...row } = record;
  return row;
}

/** Open the store on `dataBase`. */
export function createSessions(dataBase: string, deps: SessionsDeps = {}): Sessions {
  const path = sessionsPath(dataBase);
  const readFile = deps.readFile ?? ((target: string) => readFileSync(target, "utf8"));
  const writeFile =
    deps.writeFile ??
    ((target: string, content: string) => {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = join(dirname(target), `.${process.pid}.${SESSIONS_FILE}.tmp`);
      writeFileSync(tmp, content, { mode: 0o600 });
      renameSync(tmp, target);
    });
  const random = deps.random ?? randomBytes;

  /** The bytes this process last wrote, or null before it has written any. */
  let lastWritten: string | null = null;
  let tampered = false;
  let warnedMalformed = false;

  /** A missing, unreadable or malformed file is a deployment nobody paired. */
  function read(): SessionsFile {
    let raw: string;
    try {
      raw = readFile(path);
    } catch {
      return { sessions: [] };
    }
    if (lastWritten !== null && raw !== lastWritten && !tampered) {
      tampered = true;
      deps.onTampered?.(path);
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionsFile>;
      return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch {
      if (!warnedMalformed) {
        warnedMalformed = true;
        deps.onMalformed?.(path);
      }
      return { sessions: [] };
    }
  }

  /** Expired rows are dropped here, on the way to disk, and nowhere else. */
  function write(file: SessionsFile, now: Date): void {
    const kept = file.sessions.filter((row) => !isExpired(row, now));
    const content = `${JSON.stringify({ sessions: kept }, null, 2)}\n`;
    writeFile(path, content);
    lastWritten = content;
  }

  function match(file: SessionsFile, token: string | undefined): SessionRecord | undefined {
    if (token === undefined || token === "") return undefined;
    const presented = hashToken(token);
    return file.sessions.find((row) => sameDigest(row.tokenHash, presented));
  }

  return {
    issue(issue, now) {
      // 256 bits from the CSPRNG. Opaque on purpose: a bearer the deployment can
      // look up is a bearer that can be revoked.
      const token = random(32).toString("base64url");
      const row: SessionRow = {
        id: random(16).toString("base64url"),
        scopes: [...issue.scopes],
        label: sessionLabel(issue.label),
        deviceType: issue.deviceType,
        os: issue.os,
        pairedAs: issue.pairedAs,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
        lastSeenAt: now.toISOString(),
      };
      const file = read();
      file.sessions.push({ ...row, tokenHash: hashToken(token) });
      write(file, now);
      return { token, row };
    },

    authenticate(token, now) {
      const file = read();
      const record = match(file, token);
      if (record === undefined) return { ok: false, reason: "unknown" };
      if (isExpired(record, now)) return { ok: false, reason: "expired" };
      const seen = Date.parse(record.lastSeenAt);
      if (!(Number.isFinite(seen) && now.getTime() - seen < LAST_SEEN_RESOLUTION_MS)) {
        record.lastSeenAt = now.toISOString();
        write(file, now);
      }
      return { ok: true, row: publicOf(record) };
    },

    list() {
      return read().sessions.map(publicOf);
    },

    byId(id) {
      const record = read().sessions.find((row) => row.id === id);
      return record === undefined ? null : publicOf(record);
    },

    revoke(id) {
      const file = read();
      const keep = file.sessions.filter((row) => row.id !== id);
      if (keep.length === file.sessions.length) return false;
      write({ sessions: keep }, new Date());
      return true;
    },

    revokeAll() {
      const file = read();
      const count = file.sessions.length;
      write({ sessions: [] }, new Date());
      return count;
    },

    counts(now) {
      let active = 0;
      let expired = 0;
      for (const row of read().sessions) {
        if (isExpired(row, now)) expired += 1;
        else active += 1;
      }
      return { active, expired };
    },

    tampered: () => tampered,
  };
}
