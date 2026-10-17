// The supervisor (map #690, #697) against a fake deployment and a clock the
// test owns: the descriptor before every open, the 60 s idle abort, the ladder
// a 503 climbs, the four blocked endings, and the resets.

import { describe, expect, test } from "vite-plus/test";
import type { StoredReport } from "phoebe-agent/contracts";
import { createRemoteSupervisor, type SupervisorReading } from "./remote-supervisor.ts";

const T0 = 1_700_000_000_000;
const URL_ = "https://phoebe.tail1.ts.net";

type Answer = { status: number; body?: unknown } | "stream" | Error;

/** A deployment the test scripts: what the descriptor says and what the stream does. */
function deployment(opts: { descriptor?: () => Answer; events?: () => Answer }) {
  const calls: string[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.slice(URL_.length);
    calls.push(path);
    const answer = path.startsWith("/.well-known")
      ? (
          opts.descriptor ??
          (() => ({
            status: 200,
            body: { deploymentId: "dep_A", protocol: 1, name: "acme", version: "0", arm: "host" },
          }))
        )()
      : (opts.events ?? (() => "stream"))();
    if (answer instanceof Error) throw answer;
    if (answer === "stream") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.error(new DOMException("aborted", "AbortError"));
            } catch {
              // Already closed.
            }
          });
          controller.enqueue(encoder.encode(": connected\n\n"));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    fetchFn,
    /** Push bytes down the open stream. */
    send: (text: string) => streams.at(-1)!.enqueue(new TextEncoder().encode(text)),
    /** End the stream from the deployment's side. */
    close: () => streams.at(-1)!.close(),
  };
}

function harness(
  opts: Parameters<typeof deployment>[0] & { lastHeardAt?: string | null; random?: number } = {},
) {
  const dep = deployment(opts);
  const clock = { now: T0 };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextHandle = 1;
  const readings: SupervisorReading[] = [];
  const heard: Array<{ at: string; report: StoredReport | null }> = [];
  const supervisor = createRemoteSupervisor({
    url: URL_,
    stored: { deploymentId: "dep_A", protocol: 1 },
    bearer: () => "bearer-a",
    lastHeardAt: opts.lastHeardAt ?? null,
    fetchFn: dep.fetchFn,
    now: () => clock.now,
    random: () => opts.random ?? 0.5,
    setTimer: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { fn, ms });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle as number),
    onHeard: (at, report) => heard.push({ at, report }),
    onReading: (reading) => readings.push(reading),
  });
  /** Let the promise chain settle. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** The pending timers' delays. */
  const pending = (): number[] => [...timers.values()].map((timer) => timer.ms);
  /** Fire the first pending timer with this delay. */
  const fire = async (ms: number): Promise<void> => {
    const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
    if (entry === undefined) throw new Error(`no timer of ${ms} ms among ${pending().join(", ")}`);
    timers.delete(entry[0]);
    entry[1].fn();
    await settle();
  };
  return { dep, clock, supervisor, readings, heard, settle, pending, fire, timers };
}

const last = (h: ReturnType<typeof harness>): SupervisorReading => h.readings.at(-1)!;

describe("the stream", () => {
  test("the descriptor is read before the open, the first event is heard, and the state is connected", async () => {
    const h = harness();
    h.supervisor.start();
    await h.settle();
    expect(h.dep.calls).toEqual(["/.well-known/phoebe/deployment", "/api/events"]);
    expect(last(h).reachability).toBe("connected");
    h.dep.send('event: report\ndata: {"schema":1,"identity":{"name":"acme"}}\n\n');
    await h.settle();
    expect(h.heard.at(-1)?.report).toEqual({
      schema: 1,
      receivedAt: new Date(T0).toISOString(),
      report: { schema: 1, identity: { name: "acme" } },
    });
    h.supervisor.stop();
  });

  test("the stream dropping is disconnected, then the ladder; the descriptor is read again before the next open", async () => {
    const h = harness();
    h.supervisor.start();
    await h.settle();
    h.dep.close();
    await h.settle();
    expect(last(h).reachability).toBe("disconnected");
    expect(h.pending()).toContain(3_000);
    await h.fire(3_000);
    expect(h.dep.calls).toEqual([
      "/.well-known/phoebe/deployment",
      "/api/events",
      "/.well-known/phoebe/deployment",
      "/api/events",
    ]);
    expect(last(h).reachability).toBe("connected");
    h.supervisor.stop();
  });

  test("60 s of silence aborts the read, and a remote that old is dark", async () => {
    const h = harness();
    h.supervisor.start();
    await h.settle();
    expect(h.pending()).toContain(60_000);
    h.clock.now += 60_000;
    await h.fire(60_000);
    expect(last(h).reachability).toBe("dark");
    // Climbs the ladder like any other failure.
    expect(h.pending()).toContain(3_000);
    h.supervisor.stop();
  });

  test("a disconnected remote turns dark on its own at the 60 s mark", async () => {
    const h = harness({ events: () => ({ status: 503 }) });
    h.supervisor.start();
    await h.settle();
    expect(last(h).reachability).toBe("dark");
    h.supervisor.stop();
  });
});

describe("the ladder", () => {
  test("503 climbs: 3, 4, 8, 16, 30 s, capped", async () => {
    const h = harness({ events: () => ({ status: 503 }), lastHeardAt: new Date(T0).toISOString() });
    h.supervisor.start();
    await h.settle();
    expect(last(h).reachability).toBe("disconnected");
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const retry = h.pending().find((ms) => ms !== 60_000)!;
      seen.push(retry);
      await h.fire(retry);
    }
    expect(seen).toEqual([3_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    h.supervisor.stop();
  });

  test("jitter stays within ±25 %", async () => {
    const h = harness({ events: () => ({ status: 503 }), random: 0 });
    h.supervisor.start();
    await h.settle();
    expect(h.pending()).toContain(2_250);
    h.supervisor.stop();
  });

  test("a poke resets the ladder and tries now", async () => {
    const h = harness({ events: () => ({ status: 503 }), lastHeardAt: new Date(T0).toISOString() });
    h.supervisor.start();
    await h.settle();
    await h.fire(3_000);
    await h.fire(4_000);
    const before = h.dep.calls.length;
    h.supervisor.poke();
    await h.settle();
    expect(h.dep.calls.length).toBe(before + 2);
    expect(h.pending().filter((ms) => ms !== 60_000)).toEqual([3_000]);
    h.supervisor.stop();
  });
});

describe("blocked", () => {
  test("401 expired is expired, and nothing is retried", async () => {
    const h = harness({
      events: () => ({ status: 401, body: { error: "unauthenticated", reason: "expired" } }),
    });
    h.supervisor.start();
    await h.settle();
    expect(last(h)).toMatchObject({ reachability: "blocked", blocked: "expired" });
    expect(h.pending().filter((ms) => ms !== 60_000)).toEqual([]);
    h.supervisor.poke();
    await h.settle();
    expect(h.dep.calls).toHaveLength(2);
    h.supervisor.stop();
  });

  test("401 unknown with the stored id still answering is revoked", async () => {
    const h = harness({
      events: () => ({ status: 401, body: { error: "unauthenticated", reason: "unknown" } }),
    });
    h.supervisor.start();
    await h.settle();
    expect(last(h)).toMatchObject({ reachability: "blocked", blocked: "revoked" });
    h.supervisor.stop();
  });

  test("a descriptor naming another id is replaced, before any bearer is sent", async () => {
    const h = harness({
      descriptor: () => ({
        status: 200,
        body: { deploymentId: "dep_B", protocol: 1, name: "other" },
      }),
    });
    h.supervisor.start();
    await h.settle();
    expect(last(h)).toMatchObject({
      reachability: "blocked",
      blocked: "replaced",
      descriptor: { deploymentId: "dep_B", protocol: 1 },
    });
    expect(h.dep.calls).toEqual(["/.well-known/phoebe/deployment"]);
    h.supervisor.stop();
  });

  test("a newer protocol is protocol", async () => {
    const h = harness({
      descriptor: () => ({
        status: 200,
        body: { deploymentId: "dep_A", protocol: 2, name: "acme" },
      }),
    });
    h.supervisor.start();
    await h.settle();
    expect(last(h)).toMatchObject({ reachability: "blocked", blocked: "protocol" });
    h.supervisor.stop();
  });

  test("a descriptor that will not answer is an ordinary failure, not blocked", async () => {
    const h = harness({
      descriptor: () => new Error("ECONNREFUSED"),
      lastHeardAt: new Date(T0).toISOString(),
    });
    h.supervisor.start();
    await h.settle();
    expect(last(h).reachability).toBe("disconnected");
    expect(h.pending()).toContain(3_000);
    h.supervisor.stop();
  });
});
