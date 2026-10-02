import { describe, expect, test } from "vite-plus/test";
import {
  clearCookie,
  createSessionStore,
  parseCookies,
  PRE_AUTH_COOKIE,
  PRE_AUTH_TTL_MS,
  randomId,
  SESSION_COOKIE,
  setCookie,
} from "./sessions.ts";

const T0 = 1_700_000_000_000;

describe("the session store", () => {
  test("a pre-auth entry comes back once and only once", () => {
    const store = createSessionStore();
    const id = store.startPreAuth({ state: "s", nonce: "n", codeVerifier: "v" }, T0);

    expect(store.takePreAuth(id, T0)).toMatchObject({ state: "s", nonce: "n", codeVerifier: "v" });
    expect(store.takePreAuth(id, T0)).toBeNull();
  });

  test("a stale pre-auth entry is spent and refused", () => {
    const store = createSessionStore();
    const id = store.startPreAuth({ state: "s", nonce: "n", codeVerifier: "v" }, T0);

    expect(store.takePreAuth(id, T0 + PRE_AUTH_TTL_MS + 1)).toBeNull();
  });

  test("an unknown or absent id is null, never a throw", () => {
    const store = createSessionStore();

    expect(store.takePreAuth(undefined, T0)).toBeNull();
    expect(store.takePreAuth("not-an-id", T0)).toBeNull();
    expect(store.get(undefined)).toBeNull();
    expect(store.get("not-an-id")).toBeNull();
  });

  test("stale pre-auth entries are swept as new ones arrive", () => {
    const store = createSessionStore();
    const stale = store.startPreAuth({ state: "s", nonce: "n", codeVerifier: "v" }, T0);
    store.startPreAuth({ state: "s2", nonce: "n2", codeVerifier: "v2" }, T0 + PRE_AUTH_TTL_MS + 1);

    expect(store.takePreAuth(stale, T0 + PRE_AUTH_TTL_MS + 2)).toBeNull();
  });

  test("a session lives until it is closed", () => {
    const store = createSessionStore();
    const id = store.open({ sub: "sub-1", email: "ada@example.test" }, T0);

    expect(store.get(id)).toMatchObject({ sub: "sub-1", email: "ada@example.test" });
    expect(store.size()).toBe(1);
    store.close(id);
    expect(store.get(id)).toBeNull();
    expect(store.size()).toBe(0);
  });

  test("ids are unguessable and distinct", () => {
    const ids = new Set(Array.from({ length: 64 }, () => randomId()));

    expect(ids.size).toBe(64);
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(43);
  });
});

describe("cookies", () => {
  test("both names carry the __Host- prefix", () => {
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    expect(PRE_AUTH_COOKIE.startsWith("__Host-")).toBe(true);
  });

  test("a set cookie carries every attribute __Host- and the flow require", () => {
    const header = setCookie(SESSION_COOKIE, "abc");

    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    // Lax, not Strict: Google's callback is a cross-site top-level navigation
    // and Strict would drop the pre-auth cookie on exactly that request.
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
  });

  test("clearing a cookie expires it in place", () => {
    expect(clearCookie(SESSION_COOKIE)).toBe(
      `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
  });

  test("parsing tolerates the other cookies on the host", () => {
    const cookies = parseCookies(`other=1; ${SESSION_COOKIE}=abc%3D; malformed; =nameless`);

    expect(cookies.get(SESSION_COOKIE)).toBe("abc=");
    expect(cookies.get("other")).toBe("1");
    expect(parseCookies(undefined).size).toBe(0);
  });
});
