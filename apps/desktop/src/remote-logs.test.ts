// A remote's log stream (map #690): the backlog resolves the follow, lines are
// kept and forwarded, a second follow joins, a stop keeps nothing and reports
// nothing, a drop is reported, and a refusal rejects with the deployment's
// reason.

import { describe, expect, test } from "vite-plus/test";
import type { RemoteLogLine, RemoteLogsEnded } from "phoebe-agent/contracts";
import { createRemoteLogs } from "./remote-logs.ts";

const URL_ = "https://phoebe.tail1.ts.net";

function deployment(answer: { status: number; body?: unknown } | "stream" | Error = "stream") {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      path: url.slice(URL_.length),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    if (answer instanceof Error) throw answer;
    if (answer !== "stream") {
      return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
        status: answer.status,
      });
    }
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
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return {
    calls,
    fetchFn,
    send: (text: string) => streams.at(-1)!.enqueue(new TextEncoder().encode(text)),
    close: () => streams.at(-1)!.close(),
  };
}

function harness(answer?: Parameters<typeof deployment>[0]) {
  const dep = deployment(answer);
  const lines: RemoteLogLine[] = [];
  const ended: RemoteLogsEnded[] = [];
  const logs = createRemoteLogs({
    fetchFn: dep.fetchFn,
    onLine: (line) => lines.push(line),
    onEnded: (end) => ended.push(end),
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { dep, logs, lines, ended, settle };
}

const backlog = (lines: string[]): string =>
  `event: backlog\ndata: ${JSON.stringify({ lines })}\n\n`;
const line = (text: string): string => `event: line\ndata: ${JSON.stringify({ line: text })}\n\n`;

describe("follow", () => {
  test("sends the bearer, resolves with the backlog, forwards each line, and a second follow joins", async () => {
    const h = harness();
    const first = h.logs.follow("dep_A", { url: URL_, bearer: "bearer-a" });
    await h.settle();
    expect(h.dep.calls).toEqual([
      { path: "/api/logs", headers: expect.objectContaining({ authorization: "Bearer bearer-a" }) },
    ]);
    h.dep.send(backlog(["[phoebe] boot: one", "[acme:a/b:work] two"]));
    await expect(first).resolves.toEqual(["[phoebe] boot: one", "[acme:a/b:work] two"]);
    h.dep.send(line("[acme:a/b:work] three"));
    await h.settle();
    expect(h.lines).toEqual([{ deploymentId: "dep_A", line: "[acme:a/b:work] three" }]);
    // The joiner gets what is held now, and opens no second socket.
    await expect(h.logs.follow("dep_A", { url: URL_, bearer: "bearer-a" })).resolves.toEqual([
      "[phoebe] boot: one",
      "[acme:a/b:work] two",
    ]);
    expect(h.dep.calls).toHaveLength(1);
    h.logs.stop("dep_A");
    await h.settle();
    expect(h.ended).toEqual([]);
  });

  test("a stream the deployment closes is reported once, and the next follow opens anew", async () => {
    const h = harness();
    const first = h.logs.follow("dep_A", { url: URL_, bearer: "b" });
    await h.settle();
    h.dep.send(backlog([]));
    await first;
    h.dep.close();
    await h.settle();
    expect(h.ended).toEqual([
      { deploymentId: "dep_A", reason: "the log stream ended — the deployment closed it" },
    ]);
    void h.logs.follow("dep_A", { url: URL_, bearer: "b" });
    await h.settle();
    expect(h.dep.calls).toHaveLength(2);
    h.logs.stopAll();
  });

  test("a refusal rejects with the deployment's reason and reports no ending", async () => {
    for (const [answer, reason] of [
      [{ status: 401, body: { error: "unauthenticated", reason: "expired" } }, "pair again"],
      [{ status: 404, body: { error: "no-logs" } }, "keeps no output"],
      [{ status: 503, body: { error: "too-many-streams" } }, "too many streams"],
      [new Error("ECONNREFUSED"), "did not answer: ECONNREFUSED"],
    ] as const) {
      const h = harness(answer);
      await expect(h.logs.follow("dep_A", { url: URL_, bearer: "b" })).rejects.toThrow(reason);
      await h.settle();
      expect(h.ended).toEqual([]);
    }
  });
});
