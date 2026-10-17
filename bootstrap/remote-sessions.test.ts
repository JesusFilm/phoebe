// The sessions store (map #690, #696): round trip, atomic 0600 write, the
// missing and malformed paths, lastSeenAt at 60 s resolution, expiry without a
// sweep, and the tampered flag.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  bearerToken,
  createSessions,
  hashToken,
  isExpired,
  LAST_SEEN_RESOLUTION_MS,
  SESSION_LIFETIME_MS,
  sessionLabel,
  sessionsPath,
} from "./remote-sessions.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-sessions-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-16T12:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);
const ISSUE = {
  scopes: ["read" as const],
  label: "  Mike's   MacBook ",
  deviceType: "desktop" as const,
  os: "macOS 15",
  pairedAs: null,
};

describe("issue and authenticate", () => {
  test("round-trips through a 0600 file, hashes only, and the label is tidied", () => {
    const base = tmp();
    const store = createSessions(base);
    const { token, row } = store.issue(ISSUE, at(0));
    expect(row.label).toBe("Mike's MacBook");
    expect(row.expiresAt).toBe(new Date(T0 + SESSION_LIFETIME_MS).toISOString());
    const raw = readFileSync(sessionsPath(base), "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashToken(token));
    expect(statSync(sessionsPath(base)).mode & 0o777).toBe(0o600);

    const auth = store.authenticate(token, at(1_000));
    expect(auth).toEqual({
      ok: true,
      row: expect.objectContaining({ id: row.id, scopes: ["read"] }),
    });
    expect(JSON.stringify(auth)).not.toContain("tokenHash");
  });

  test("an unknown token is `unknown`, an expired one is `expired`, and a missing file is nobody", () => {
    const base = tmp();
    const store = createSessions(base);
    expect(store.authenticate("nope", at(0))).toEqual({ ok: false, reason: "unknown" });
    expect(store.authenticate(undefined, at(0))).toEqual({ ok: false, reason: "unknown" });
    const { token } = store.issue(ISSUE, at(0));
    expect(store.authenticate(token, at(SESSION_LIFETIME_MS))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(store.list(at(0))).toHaveLength(1);
  });

  test("two reads 30 s apart write once; a read past 60 s writes again", () => {
    const base = tmp();
    const writes: string[] = [];
    const store = createSessions(base, {
      readFile: (path) => readFileSync(path, "utf8"),
      writeFile: (path, content) => {
        writes.push(content);
        mkdirSync(join(base, "state"), { recursive: true });
        writeFileSync(path, content);
      },
    });
    const { token } = store.issue(ISSUE, at(0));
    expect(writes).toHaveLength(1);
    store.authenticate(token, at(30_000));
    expect(writes).toHaveLength(1);
    store.authenticate(token, at(LAST_SEEN_RESOLUTION_MS + 1));
    expect(writes).toHaveLength(2);
    expect(store.byId(store.list(at(0))[0]!.id)!.lastSeenAt).toBe(
      at(LAST_SEEN_RESOLUTION_MS + 1).toISOString(),
    );
  });

  test("a malformed file reads as nobody paired, and says so once", () => {
    const base = tmp();
    mkdirSync(join(base, "state"), { recursive: true });
    writeFileSync(sessionsPath(base), "{ not json");
    const said: string[] = [];
    const store = createSessions(base, { onMalformed: (path) => said.push(path) });
    expect(store.list(at(0))).toEqual([]);
    expect(store.counts(at(0))).toEqual({ active: 0, expired: 0 });
    expect(said).toEqual([sessionsPath(base)]);
  });
});

describe("expiry", () => {
  test("an expired row is listed and counted until the next write drops it", () => {
    const base = tmp();
    const store = createSessions(base);
    store.issue(ISSUE, at(0));
    const later = at(SESSION_LIFETIME_MS + 1);
    expect(store.counts(later)).toEqual({ active: 0, expired: 1 });
    expect(store.list(later)).toHaveLength(1);
    expect(isExpired(store.list(later)[0]!, later)).toBe(true);
    // The next write: a fresh issue drops the expired row on the way to disk.
    store.issue({ ...ISSUE, label: "phone", deviceType: "mobile" }, later);
    expect(store.list(later).map((row) => row.label)).toEqual(["phone"]);
  });
});

describe("revocation", () => {
  test("by id, and all", () => {
    const base = tmp();
    const store = createSessions(base);
    const a = store.issue(ISSUE, at(0));
    const b = store.issue({ ...ISSUE, label: "b" }, at(0));
    expect(store.revoke("nope")).toBe(false);
    expect(store.revoke(a.row.id)).toBe(true);
    expect(store.authenticate(a.token, at(1))).toEqual({ ok: false, reason: "unknown" });
    expect(store.authenticate(b.token, at(1)).ok).toBe(true);
    expect(store.revokeAll()).toBe(1);
    expect(store.list(at(0))).toEqual([]);
  });
});

describe("tampered", () => {
  test("bytes that differ from the last write set the flag once and say so", () => {
    const base = tmp();
    const said: string[] = [];
    const store = createSessions(base, { onTampered: (path) => said.push(path) });
    store.issue(ISSUE, at(0));
    expect(store.tampered()).toBe(false);
    store.list(at(0));
    expect(store.tampered()).toBe(false);
    // A child appends a row of its own choosing.
    const file = JSON.parse(readFileSync(sessionsPath(base), "utf8")) as { sessions: unknown[] };
    file.sessions.push({
      id: "forged",
      tokenHash: "00",
      scopes: ["read", "operate"],
      label: "x",
      deviceType: "desktop",
      os: "?",
      pairedAs: null,
      issuedAt: at(0).toISOString(),
      expiresAt: at(1e9).toISOString(),
      lastSeenAt: at(0).toISOString(),
    });
    writeFileSync(sessionsPath(base), JSON.stringify(file));
    expect(store.list(at(0)).map((row) => row.id)).toContain("forged");
    expect(store.tampered()).toBe(true);
    expect(said).toEqual([sessionsPath(base)]);
    store.list(at(0));
    expect(said).toHaveLength(1);
  });

  test("across a relaunch the flag is false — nothing to compare against", () => {
    const base = tmp();
    createSessions(base).issue(ISSUE, at(0));
    const relaunched = createSessions(base);
    expect(relaunched.list(at(0))).toHaveLength(1);
    expect(relaunched.tampered()).toBe(false);
  });
});

describe("helpers", () => {
  test("bearerToken reads exactly one scheme and one space", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  test("sessionLabel caps at 120 and defaults to 'a device'", () => {
    expect(sessionLabel("")).toBe("a device");
    expect(sessionLabel("x".repeat(200))).toHaveLength(120);
  });
});
