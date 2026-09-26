// Sessions and the cookies that carry them (#506 §3, #499 §5).
//
// Both maps live in memory and die with the process, by decision: a relay
// restart logs every browser out, and signing in again costs one redirect. The
// ID token Google returns is a login receipt, not a session — it is read once,
// for `sub` and `email`, and dropped. No refresh token is ever requested, so
// the relay holds nothing of Google's after the callback returns.
//
// Two cookies, both `__Host-` prefixed, which pins them to this exact host and
// forces `Secure` + `Path=/` + no `Domain`:
//
//   * the pre-auth cookie, alive only for the round trip to Google, keying the
//     `state` / `nonce` / PKCE verifier the callback must check against;
//   * the session cookie, the signed-in person.
//
// `SameSite=Lax`, not `Strict`, and that is load-bearing rather than lax: the
// callback is a cross-site top-level GET from accounts.google.com, and Strict
// would withhold the pre-auth cookie on exactly that navigation, failing every
// login on the `state` check.

import { randomBytes } from "node:crypto";

/** Alive only for the round trip to Google. */
export const PRE_AUTH_COOKIE = "__Host-phoebe-relay-auth";
/** The signed-in browser. */
export const SESSION_COOKIE = "__Host-phoebe-relay-session";

/** How long a person has to finish signing in before the attempt is stale. */
export const PRE_AUTH_TTL_MS = 10 * 60 * 1000;

/**
 * What a companion asked for when it started the flow (#523 §2). Present only
 * on a sign-in that began at `/auth/device/start`, and it is the one thing that
 * tells the shared callback which of the two landings this sign-in wants.
 */
export type DeviceIntent = {
  /** `BASE64URL(SHA256(verifier))`, carried through to the one-time code. */
  challenge: string;
  /** What the companion calls itself, recorded on the device it is about to get. */
  name: string;
};

/** What the callback needs back from the request that started the flow. */
export type PreAuth = {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
  /** Set when a companion started this, absent when a browser did. */
  device?: DeviceIntent;
};

/** A signed-in person, keyed on Google's `sub`. */
export type Session = {
  sub: string;
  email: string;
  createdAt: number;
};

export type SessionStore = {
  /** Remember one in-flight sign-in; returns the id for the pre-auth cookie. */
  startPreAuth: (preAuth: Omit<PreAuth, "createdAt">, now: number) => string;
  /** Spend a pre-auth id: returns it and forgets it, or null if absent or stale. */
  takePreAuth: (id: string | undefined, now: number) => PreAuth | null;
  /** Open a session; returns the id for the session cookie. */
  open: (session: Omit<Session, "createdAt">, now: number) => string;
  /** The session behind a cookie value, or null. */
  get: (id: string | undefined) => Session | null;
  /** Forget one session. Idempotent. */
  close: (id: string | undefined) => void;
  /**
   * Forget every session one person holds, and say how many there were (#505
   * §6: a removed user's sessions end).
   *
   * Matched on `sub` when the entry has one and on the address otherwise, which
   * is how the allowlist itself matches. Sessions are the only place a removal
   * has to reach: nothing of Google's outlives the callback, so a person with
   * no session and no allowlist entry is a person with no way back in.
   */
  closeEveryone: (person: { sub?: string; email: string }) => number;
  /** How many sessions are open — the one number worth reporting. */
  size: () => number;
};

/** A 256-bit random id, base64url. Unguessable is the only requirement. */
export function randomId(): string {
  return randomBytes(32).toString("base64url");
}

export function createSessionStore(): SessionStore {
  const preAuths = new Map<string, PreAuth>();
  const sessions = new Map<string, Session>();

  return {
    startPreAuth(preAuth, now) {
      // Sweep on write rather than on a timer: a relay nobody is signing into
      // has nothing to sweep, and the map is bounded by sign-ins in flight.
      for (const [id, entry] of preAuths) {
        if (now - entry.createdAt > PRE_AUTH_TTL_MS) preAuths.delete(id);
      }
      const id = randomId();
      preAuths.set(id, { ...preAuth, createdAt: now });
      return id;
    },

    takePreAuth(id, now) {
      if (id === undefined) return null;
      const entry = preAuths.get(id);
      if (entry === undefined) return null;
      // Single use, whether or not it turns out to be fresh: a replayed
      // callback must not get a second chance at the same `state`.
      preAuths.delete(id);
      if (now - entry.createdAt > PRE_AUTH_TTL_MS) return null;
      return entry;
    },

    open(session, now) {
      const id = randomId();
      sessions.set(id, { ...session, createdAt: now });
      return id;
    },

    get(id) {
      if (id === undefined) return null;
      return sessions.get(id) ?? null;
    },

    close(id) {
      if (id !== undefined) sessions.delete(id);
    },

    closeEveryone(person) {
      let closed = 0;
      for (const [id, session] of sessions) {
        const same =
          person.sub !== undefined ? session.sub === person.sub : session.email === person.email;
        if (!same) continue;
        sessions.delete(id);
        closed += 1;
      }
      return closed;
    },

    size() {
      return sessions.size;
    },
  };
}

/**
 * Parse a `Cookie` header into a map. Tolerant by design — a browser sends
 * whatever else is on the host alongside ours, and one unparsable pair must
 * not lose the session cookie next to it.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "") continue;
    cookies.set(name, decodeURIComponent(pair.slice(eq + 1).trim()));
  }
  return cookies;
}

/**
 * A `Set-Cookie` value with the attributes `__Host-` requires plus the ones the
 * research settles: `HttpOnly` (nothing user-readable is in there, and
 * `document.cookie` has no business with it) and `SameSite=Lax`.
 */
export function setCookie(name: string, value: string, maxAgeSeconds?: number): string {
  const attributes = ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAgeSeconds !== undefined) attributes.push(`Max-Age=${maxAgeSeconds}`);
  return `${name}=${encodeURIComponent(value)}; ${attributes.join("; ")}`;
}

/** The same cookie, expired — how a `__Host-` cookie is withdrawn. */
export function clearCookie(name: string): string {
  return setCookie(name, "", 0);
}
