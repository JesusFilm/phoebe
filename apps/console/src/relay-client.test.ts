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
import { ago, row } from "./test-fixture.ts";

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

  test("the version read goes to the open path and sends no accept-nothing", async () => {
    const { fetch, calls } = fakeFetch({
      [RELAY_ROUTES.version]: { body: { version: "0.13.0", console: 1 } },
    });

    expect(await createBrowserRelayClient({ fetch }).version()).toEqual({
      version: "0.13.0",
      console: 1,
    });
    expect(calls[0]?.url).toBe(RELAY_ROUTES.version);
  });

  test("a relay with no version route rejects with the 404, which is a verdict", async () => {
    // relay-version.ts reads this status as "too old" rather than as a failure.
    const failure = await createBrowserRelayClient({ fetch: fakeFetch({}).fetch })
      .version()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayRequestError);
    expect((failure as RelayRequestError).status).toBe(404);
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
