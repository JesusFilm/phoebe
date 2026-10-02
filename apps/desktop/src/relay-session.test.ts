// Main as the relay client, with no Electron and no network (#523 §1, #554).
//
// Every edge is a parameter, so the whole sign-in runs here: the browser that
// opens is a recorded URL, the relay is a table of routes, and the keyring is an
// object. What the tests hold is the handful of things a mistake would be silent
// in — the verifier never leaving the process, the token never reaching the
// renderer, and a 401 ending the session rather than starting a retry loop.

import { describe, expect, test } from "vite-plus/test";
import { RELAY_ROUTES } from "phoebe-agent/contracts";
import type { RelayEvent } from "phoebe-agent/contracts";
import {
  companionName,
  createRelaySession,
  pkceChallenge,
  reconnectDelayMs,
  RECONNECT_CAP_MS,
  type RelayFetch,
  type RelaySessionOptions,
} from "./relay-session.ts";
import { NO_KEYRING_REASON, type StoredSession, type TokenVault } from "./vault.ts";

const RELAY = "https://relay.example.test";
const ADA = { sub: "sub-ada", email: "ada@example.test" };
const DEVICE = {
  id: "dev-1",
  ...ADA,
  name: "ada-mbp",
  createdAt: "2026-09-18T12:00:00.000Z",
  lastSeenAt: null,
};

/** One answer from the fake relay. */
type Answer = { status?: number; body?: unknown; stream?: string[] };

/** What a test wants to see afterwards. */
type Seen = { url: string; method: string; authorization?: string; body?: unknown };

/**
 * A relay that answers from a table, keyed on path. Anything not in the table
 * is a 404, which is how a test notices a request it did not mean to allow.
 */
function fakeRelay(routes: Record<string, Answer | (() => Answer)>): {
  fetch: RelayFetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetch: RelayFetch = (url, init) => {
    const path = new URL(url).pathname;
    seen.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.headers?.authorization === undefined
        ? {}
        : { authorization: init.headers.authorization }),
      ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
    });
    const route = routes[path];
    const answer: Answer =
      route === undefined ? { status: 404 } : typeof route === "function" ? route() : route;
    const status = answer.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(answer.body),
      body:
        answer.stream === undefined
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                for (const chunk of answer.stream ?? []) controller.enqueue(encoder.encode(chunk));
                controller.close();
              },
            }),
    });
  };
  return { fetch, seen };
}

/** A keyring that works, holding whatever was last written to it. */
function memoryVault(persists = true): TokenVault & { held: () => StoredSession | null } {
  let held: StoredSession | null = null;
  return {
    persists,
    held: () => held,
    read: () => held,
    write: (session) => {
      if (persists) held = session;
    },
    clear: () => {
      held = null;
    },
  };
}

function session(overrides: Partial<RelaySessionOptions> & Pick<RelaySessionOptions, "fetch">): {
  arm: ReturnType<typeof createRelaySession>;
  opened: string[];
  events: RelayEvent[];
} {
  const opened: string[] = [];
  const events: RelayEvent[] = [];
  const arm = createRelaySession({
    vault: memoryVault(),
    openExternal: (url) => {
      opened.push(url);
    },
    deviceName: "ada-mbp (macOS)",
    onEvent: (event) => events.push(event),
    // The redial loop parks rather than spinning: no test here is about backoff.
    delay: () => new Promise<void>(() => {}),
    warn: () => {},
    ...overrides,
  });
  return { arm, opened, events };
}

/**
 * Wait for the browser to have been opened. Sign-in reaches that point after a
 * variable number of awaits — revoking a previous relay first adds one — so the
 * tests wait on the thing they care about rather than counting microtasks.
 */
async function browserOpened(opened: string[], count = 1): Promise<void> {
  for (let tries = 0; tries < 100 && opened.length < count; tries++) {
    await new Promise((done) => setTimeout(done, 1));
  }
}

/** The exchange route, answering with a token for whatever verifier it is sent. */
function signInRoutes(token = "device-token"): Record<string, Answer> {
  return {
    [RELAY_ROUTES.deviceExchange]: { status: 201, body: { token, device: DEVICE } },
    [RELAY_ROUTES.events]: { stream: [": watching\n\n"] },
  };
}

describe("signing in", () => {
  test("opens the system browser at the relay's device start, named and challenged", async () => {
    const { fetch } = fakeRelay(signInRoutes());
    const { arm, opened } = session({ fetch });

    void arm.signIn(RELAY);
    await browserOpened(opened);

    const start = new URL(opened[0] ?? "");
    expect(start.origin).toBe(RELAY);
    expect(start.pathname).toBe(RELAY_ROUTES.deviceStart);
    expect(start.searchParams.get("name")).toBe("ada-mbp (macOS)");
    expect(start.searchParams.get("challenge")).toEqual(expect.any(String));
  });

  test("spends the code with the verifier behind the challenge, and nothing else sees either", async () => {
    const { fetch, seen } = fakeRelay(signInRoutes());
    const { arm, opened } = session({ fetch });

    const signingIn = arm.signIn(RELAY);
    await browserOpened(opened);
    arm.deliver("one-time-code");
    await signingIn;

    const challenge = new URL(opened[0] ?? "").searchParams.get("challenge");
    const exchange = seen.find((call) => call.url.endsWith(RELAY_ROUTES.deviceExchange));
    const body = exchange?.body as { code: string; verifier: string };
    expect(body.code).toBe("one-time-code");
    expect(pkceChallenge(body.verifier)).toBe(challenge);
    // Only the hash went out with the browser; the verifier went to the relay
    // and to nowhere else.
    expect(opened[0]).not.toContain(body.verifier);
  });

  test("the arm reads signed in, and the token is not in what the renderer gets", async () => {
    const { fetch } = fakeRelay(signInRoutes("the-secret"));
    const { arm, opened } = session({ fetch });

    const signingIn = arm.signIn(RELAY);
    await browserOpened(opened);
    arm.deliver("one-time-code");
    const state = await signingIn;

    expect(state).toEqual({ url: RELAY, person: ADA, persisted: true });
    expect(JSON.stringify(state)).not.toContain("the-secret");
  });

  test("the sign-in is written to the keyring so a relaunch keeps it", async () => {
    const vault = memoryVault();
    const { fetch } = fakeRelay(signInRoutes());
    const { arm, opened } = session({ fetch, vault });

    const signingIn = arm.signIn(RELAY);
    await browserOpened(opened);
    arm.deliver("one-time-code");
    await signingIn;

    expect(vault.held()).toEqual({ url: RELAY, token: "device-token", person: ADA });
  });

  test("with no keyring the companion refuses to persist and says why", async () => {
    const vault = memoryVault(false);
    const { fetch } = fakeRelay(signInRoutes());
    const { arm, opened } = session({ fetch, vault });

    const signingIn = arm.signIn(RELAY);
    await browserOpened(opened);
    arm.deliver("one-time-code");
    const state = await signingIn;

    expect(vault.held()).toBeNull();
    expect(state.persisted).toBe(false);
    expect(state.reason).toBe(NO_KEYRING_REASON);
  });

  test("a code arriving with no attempt open is not spent", () => {
    const { fetch, seen } = fakeRelay(signInRoutes());
    const { arm } = session({ fetch });

    expect(arm.deliver("a-code-from-nowhere")).toBe(false);
    expect(seen).toEqual([]);
  });

  test("an address that is not an http relay never reaches the browser", async () => {
    const { fetch } = fakeRelay(signInRoutes());
    const { arm, opened } = session({ fetch });

    await expect(arm.signIn("file:///etc/passwd")).rejects.toThrow("not a relay address");
    await expect(arm.signIn("nonsense")).rejects.toThrow("not a relay address");
    expect(opened).toEqual([]);
  });

  test("an exchange the relay refuses leaves the arm signed out, with a sentence", async () => {
    const { fetch } = fakeRelay({
      [RELAY_ROUTES.deviceExchange]: { status: 400, body: { error: "bad-code" } },
    });
    const { arm, opened } = session({ fetch });

    const signingIn = arm.signIn(RELAY);
    await browserOpened(opened);
    arm.deliver("stale-code");

    await expect(signingIn).rejects.toThrow("bad-code");
    expect(arm.state().person).toBeNull();
  });

  test("the attempt is abandoned when the operator never comes back", async () => {
    const { fetch } = fakeRelay(signInRoutes());
    const { arm } = session({ fetch, signInWindowMs: 1 });

    await expect(arm.signIn(RELAY)).rejects.toThrow("did not come back");
  });
});

describe("a signed-in companion", () => {
  /** An arm that is already signed in, with `routes` behind it. */
  function signedIn(routes: Record<string, Answer | (() => Answer)>, persists = true) {
    const vault = memoryVault(persists);
    vault.write({ url: RELAY, token: "device-token", person: ADA });
    const { fetch, seen } = fakeRelay({
      [RELAY_ROUTES.events]: { stream: [": watching\n\n"] },
      ...routes,
    });
    return { ...session({ fetch, vault }), seen, vault };
  }

  test("restores its session at launch, so the operator is still signed in", () => {
    const { arm } = signedIn({});

    expect(arm.state()).toEqual({ url: RELAY, person: ADA, persisted: true });
  });

  test("passes a read through with the bearer, and hands back the relay's body", async () => {
    const { arm, seen } = signedIn({
      [RELAY_ROUTES.deployments]: { body: { deployments: [] } },
    });

    const body = await arm.request({ method: "GET", path: RELAY_ROUTES.deployments });

    expect(body).toEqual({ deployments: [] });
    const call = seen.find((one) => one.url.endsWith(RELAY_ROUTES.deployments));
    expect(call?.authorization).toBe("Bearer device-token");
  });

  test("will not aim the token at an address the renderer made up", async () => {
    const { arm } = signedIn({});

    await expect(
      arm.request({ method: "GET", path: "https://evil.example.test/api/me" }),
    ).rejects.toThrow("not a path on the relay");
  });

  test("a 401 drops the token, and the next call is a refusal rather than a retry", async () => {
    const { arm, vault } = signedIn({ [RELAY_ROUTES.deployments]: { status: 401 } });

    await expect(arm.request({ method: "GET", path: RELAY_ROUTES.deployments })).rejects.toThrow(
      "no longer accepts",
    );

    expect(arm.state().person).toBeNull();
    expect(vault.held()).toBeNull();
    await expect(arm.request({ method: "GET", path: RELAY_ROUTES.me })).rejects.toThrow(
      "not signed in",
    );
  });

  test("a 401 on the event stream ends the session too, and the arm says so unasked", async () => {
    const states: Array<string | null> = [];
    const vault = memoryVault();
    vault.write({ url: RELAY, token: "device-token", person: ADA });
    const { fetch } = fakeRelay({ [RELAY_ROUTES.events]: { status: 401 } });
    const { arm } = session({
      fetch,
      vault,
      onState: (state) => states.push(state.person?.email ?? null),
    });

    await new Promise((done) => setTimeout(done, 5));

    expect(arm.state().person).toBeNull();
    expect(states).toEqual([null]);
  });

  test("forwards the relay's events to whoever main is broadcasting to", async () => {
    const vault = memoryVault();
    vault.write({ url: RELAY, token: "device-token", person: ADA });
    const { fetch } = fakeRelay({
      [RELAY_ROUTES.events]: {
        stream: [
          ": watching\n\n",
          'event: report\ndata: {"type":"report","fingerprint":"one"}\n\n',
        ],
      },
    });
    const { arm, events } = session({ fetch, vault });

    await new Promise((done) => setTimeout(done, 5));
    arm.close();

    expect(events).toEqual([{ type: "report", fingerprint: "one" }]);
  });

  test("signing out revokes on the relay and then forgets it here", async () => {
    const { arm, seen, vault } = signedIn({ [RELAY_ROUTES.deviceRevoke]: { status: 204 } });

    await arm.signOut();

    const revoke = seen.find((one) => one.url.endsWith(RELAY_ROUTES.deviceRevoke));
    expect(revoke?.method).toBe("POST");
    expect(revoke?.authorization).toBe("Bearer device-token");
    expect(vault.held()).toBeNull();
    expect(arm.state().person).toBeNull();
  });

  test("a relay that cannot be reached still ends the session locally", async () => {
    const vault = memoryVault();
    vault.write({ url: RELAY, token: "device-token", person: ADA });
    const { arm } = session({
      vault,
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    await arm.signOut();

    expect(arm.state().person).toBeNull();
    expect(vault.held()).toBeNull();
  });

  test("signing in to a different relay revokes the old token first", async () => {
    const { arm, seen, opened } = signedIn({
      [RELAY_ROUTES.deviceRevoke]: { status: 204 },
      [RELAY_ROUTES.deviceExchange]: { status: 201, body: { token: "new-token", device: DEVICE } },
    });

    const signingIn = arm.signIn("https://other.example.test");
    await browserOpened(opened);
    arm.deliver("one-time-code");
    await signingIn;

    const revoke = seen.find((one) => one.url === `${RELAY}${RELAY_ROUTES.deviceRevoke}`);
    expect(revoke?.authorization).toBe("Bearer device-token");
    expect(arm.state().url).toBe("https://other.example.test");
  });
});

describe("what the companion calls itself", () => {
  test("is the machine and the OS, which is what a person recognises in a list", () => {
    expect(companionName("ada-mbp.local", "darwin")).toBe("ada-mbp (macOS)");
    expect(companionName("DESKTOP-7QK", "win32")).toBe("DESKTOP-7QK (Windows)");
    expect(companionName("tower", "linux")).toBe("tower (Linux)");
  });

  test("still names something on a machine with no name", () => {
    expect(companionName("", "linux")).toBe("a Linux companion");
  });
});

describe("the redial ladder", () => {
  test("doubles under a cap, and never returns the same delay to every companion", () => {
    expect(reconnectDelayMs(0)).toBeLessThan(1_000);
    expect(reconnectDelayMs(20)).toBeLessThan(RECONNECT_CAP_MS);
  });
});

describe("a browser that will not open", () => {
  test("is a refusal with the URL to open by hand, not a promise left hanging", async () => {
    const { fetch } = fakeRelay(signInRoutes());
    const { arm } = session({
      fetch,
      openExternal: () => {
        throw new Error("no browser here");
      },
    });

    await expect(arm.signIn(RELAY)).rejects.toThrow("could not open a browser");
  });
});
