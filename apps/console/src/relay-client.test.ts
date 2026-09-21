// The browser arm of the seam: the cookie, the paths, and the stream.
//
// Both globals are injected, so this exercises the real client — the paths it
// builds, the credentials it sets, the 401 it turns into "signed out", and the
// per-name SSE listeners — without a browser.

import { describe, expect, test } from "vite-plus/test";
import { RELAY_EVENTS, RELAY_ROUTES } from "phoebe-agent/contracts";
import {
  createBrowserRelayClient,
  isNotSignedIn,
  RelayRequestError,
  type EventSourceLike,
} from "./relay-client.ts";
import { ago, person, row } from "./test-fixture.ts";

type Call = { url: string; init: RequestInit | undefined };

/** A `fetch` that answers from a table and records every call. */
function fakeFetch(answers: Record<string, { status?: number; body: unknown }>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[url] ?? { status: 404, body: { error: "no-such-route" } };
    const status = answer.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(answer.body),
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** An `EventSource` a test can push frames into. */
function fakeStream(): {
  source: EventSourceLike;
  emit: (name: string, data: string) => void;
  opened: Array<{ url: string; withCredentials: boolean | undefined }>;
  closed: number;
} {
  const listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  const opened: Array<{ url: string; withCredentials: boolean | undefined }> = [];
  const state = { closed: 0 };
  class Fake {
    constructor(url: string, init?: { withCredentials?: boolean }) {
      opened.push({ url, withCredentials: init?.withCredentials });
    }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }
    close() {
      state.closed += 1;
    }
  }
  return {
    source: Fake as unknown as EventSourceLike,
    emit: (name, data) => {
      for (const listener of listeners.get(name) ?? []) {
        listener({ data } as MessageEvent<string>);
      }
    },
    opened,
    get closed() {
      return state.closed;
    },
  };
}

describe("the reads", () => {
  test("go to the paths in contracts, with the session cookie", async () => {
    const { fetch, calls } = fakeFetch({
      [RELAY_ROUTES.me]: { body: { sub: "s", email: "ada@example.test" } },
      [RELAY_ROUTES.deployments]: { body: { deployments: [row()] } },
    });
    const client = createBrowserRelayClient({ fetch });

    expect(await client.me()).toEqual({ sub: "s", email: "ada@example.test" });
    expect(await client.deployments()).toEqual([row()]);
    expect(calls.map((call) => call.url)).toEqual([RELAY_ROUTES.me, RELAY_ROUTES.deployments]);
    for (const call of calls) expect(call.init?.credentials).toBe("same-origin");
  });

  test("one deployment is the fleet path plus its fingerprint, encoded", async () => {
    const { fetch, calls } = fakeFetch({
      [`${RELAY_ROUTES.deployments}/a%2Fb`]: { body: { deployment: row(), report: null } },
    });

    await createBrowserRelayClient({ fetch }).deployment("a/b");

    expect(calls[0]?.url).toBe(`${RELAY_ROUTES.deployments}/a%2Fb`);
  });

  test("no session is `me` answering null, not an error to report", async () => {
    const { fetch } = fakeFetch({
      [RELAY_ROUTES.me]: { status: 401, body: { error: "not-signed-in" } },
    });

    expect(await createBrowserRelayClient({ fetch }).me()).toBeNull();
  });

  test("a refusal on any other read carries the relay's own error code", async () => {
    const { fetch } = fakeFetch({
      [RELAY_ROUTES.deployments]: { status: 401, body: { error: "not-signed-in" } },
    });

    const failure = await createBrowserRelayClient({ fetch })
      .deployments()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayRequestError);
    expect(isNotSignedIn(failure)).toBe(true);
    expect((failure as RelayRequestError).code).toBe("not-signed-in");
  });

  test("a refusal with no JSON body still reports its status", async () => {
    const fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error("not JSON")),
      })) as unknown as typeof globalThis.fetch;

    const failure = await createBrowserRelayClient({ fetch })
      .deployments()
      .catch((error: unknown) => error);

    expect((failure as RelayRequestError).status).toBe(502);
    expect((failure as RelayRequestError).code).toBe("unreadable");
  });

  test("running doctor posts the fingerprint, and posts none for the fleet (#546)", async () => {
    const results = [{ fingerprint: "one", name: "alpha", state: "connected", outcome: "started" }];
    const { fetch, calls } = fakeFetch({ [RELAY_ROUTES.doctorRun]: { body: { results } } });
    const client = createBrowserRelayClient({ fetch });

    expect(await client.runDoctor("one")).toEqual(results);
    expect(await client.runDoctor()).toEqual(results);

    expect(calls.map((call) => call.init?.body)).toEqual(['{"fingerprint":"one"}', "{}"]);
    for (const call of calls) {
      expect(call.url).toBe(RELAY_ROUTES.doctorRun);
      expect(call.init?.method).toBe("POST");
      expect(call.init?.credentials).toBe("same-origin");
    }
  });

  test("signing out treats a session that is already gone as done", async () => {
    const { fetch, calls } = fakeFetch({
      [RELAY_ROUTES.signOut]: { status: 401, body: { error: "not-signed-in" } },
    });

    await createBrowserRelayClient({ fetch }).signOut();

    expect(calls[0]?.init?.method).toBe("POST");
  });
});

describe("the stream", () => {
  test("opens the events path with credentials and closes on unsubscribe", () => {
    const stream = fakeStream();
    const client = createBrowserRelayClient({
      fetch: fakeFetch({}).fetch,
      eventSource: stream.source,
    });

    const unsubscribe = client.events(() => {});

    expect(stream.opened).toEqual([{ url: RELAY_ROUTES.events, withCredentials: true }]);
    unsubscribe();
    expect(stream.closed).toBe(1);
  });

  test("hands over one event per name the relay writes", () => {
    const stream = fakeStream();
    const seen: string[] = [];
    createBrowserRelayClient({
      fetch: fakeFetch({}).fetch,
      eventSource: stream.source,
    }).events((event) => seen.push(event.type));

    stream.emit(
      RELAY_EVENTS.report,
      JSON.stringify({ type: "report", at: ago(0), fingerprint: "one", schema: 1, report: {} }),
    );
    stream.emit(
      RELAY_EVENTS.dark,
      JSON.stringify({ type: "dark", at: ago(0), deployment: row({ state: "dark" }) }),
    );

    expect(seen).toEqual(["report", "dark"]);
  });

  test("a frame that does not parse is dropped, not thrown", () => {
    const stream = fakeStream();
    const seen: string[] = [];
    createBrowserRelayClient({
      fetch: fakeFetch({}).fetch,
      eventSource: stream.source,
    }).events((event) => seen.push(event.type));

    stream.emit(RELAY_EVENTS.report, "{ not json");
    stream.emit(RELAY_EVENTS.report, JSON.stringify({ type: "something-else" }));
    stream.emit(
      RELAY_EVENTS.report,
      JSON.stringify({ type: "report", at: ago(0), fingerprint: "one", schema: 1, report: {} }),
    );

    expect(seen).toEqual(["report"]);
  });
});

describe("the People verbs", () => {
  test("read the list, and send an address as JSON on the two writes", async () => {
    const { fetch, calls } = fakeFetch({
      [RELAY_ROUTES.people]: { body: { people: [person()] } },
      [RELAY_ROUTES.removePerson]: { body: { sessionsEnded: 2 } },
    });
    const client = createBrowserRelayClient({ fetch });

    expect(await client.people()).toEqual([person()]);
    await client.addPerson("grace@example.test");
    expect(await client.removePerson("grace@example.test")).toEqual({ sessionsEnded: 2 });

    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      [RELAY_ROUTES.people, undefined],
      [RELAY_ROUTES.people, "POST"],
      [RELAY_ROUTES.removePerson, "POST"],
    ]);
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ email: "grace@example.test" }));
    for (const call of calls) expect(call.init?.credentials).toBe("same-origin");
  });

  test("a refusal keeps the relay's code, which is what the page words", async () => {
    const { fetch } = fakeFetch({
      [RELAY_ROUTES.people]: { status: 409, body: { error: "already-listed" } },
    });

    const failure = await createBrowserRelayClient({ fetch })
      .addPerson("grace@example.test")
      .catch((error: unknown) => error);

    expect((failure as RelayRequestError).code).toBe("already-listed");
  });

  test("minting is a POST with no body at all", async () => {
    const minted = { token: "t", expiresAt: ago(-900), relayUrl: "wss://relay.test/deployments" };
    const { fetch, calls } = fakeFetch({ [RELAY_ROUTES.pairingTokens]: { body: minted } });

    expect(await createBrowserRelayClient({ fetch }).mintPairingToken()).toEqual(minted);

    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBeUndefined();
  });
});
