// The OTLP sender (#993), against a fake collector on a real socket: one POST
// per record, one retry on the statuses the spec names, counts in the report,
// and nothing on disk.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { UnitRecord } from "../src/contracts/unit-record.ts";
import { resolveOtlpTarget, type OtlpTraceRequest } from "./otlp.ts";
import {
  createTelemetryForwarder,
  engineVersionAt,
  OTLP_RETRY_DEFAULT_MS,
  OTLP_RETRY_MAX_MS,
  retryAfterMs,
} from "./telemetry-forwarder.ts";

const record: UnitRecord = {
  v: 1,
  tenant: "acme/widget",
  pipeline: "observer",
  unit: { kind: "observer", id: "2026-11-20" },
  outcome: "completed",
  quarantined: false,
  detail: "Filed two proposals about flaky-test-secret",
  startedAt: "2026-11-20T10:00:00.000Z",
  settledAt: "2026-11-20T10:05:00.000Z",
  durationMs: 300_000,
  runBudgetMs: null,
  provider: "codex",
  model: "gpt-5.5",
  effort: null,
  branch: "phoebe/observer-branch-secret",
  headSha: null,
  prNumber: null,
  engineCommit: null,
  agentRuns: [
    {
      startedAt: "2026-11-20T10:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      promptSha: "d".repeat(64),
      costBasis: null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      costUsd: null,
      turns: 1,
      providerDurationMs: null,
      stopReason: null,
      reportedModels: [],
      usageComplete: true,
      toolCalls: {},
    },
  ],
};

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
type Answer = (response: ServerResponse) => void;

/** A collector that answers each request with the next scripted reply, then 200. */
async function fakeCollector(answers: Answer[] = []): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      });
      const answer = answers.shift();
      if (answer !== undefined) return answer(response);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function status(code: number, headers: Record<string, string> = {}): Answer {
  return (response) => {
    response.writeHead(code, headers);
    response.end();
  };
}

function forwarderFor(base: string, extra: Record<string, string> = {}) {
  const target = resolveOtlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: base, ...extra })!;
  const waits: number[] = [];
  let changes = 0;
  const forwarder = createTelemetryForwarder({
    target,
    deploymentId: () => "dep_0123456789ABCDEFGHJKMNPQRS",
    now: () => new Date("2026-11-20T11:00:00.000Z"),
    sleep: async (ms) => {
      waits.push(ms);
    },
    onChange: () => (changes += 1),
  });
  return { forwarder, waits, changes: () => changes };
}

describe("createTelemetryForwarder", () => {
  test("no OTLP variable means no target, so nothing is built to send", () => {
    expect(resolveOtlpTarget({})).toBeNull();
  });

  test("each record is one POST of one OTLP/JSON trace, with the operator's headers", async () => {
    const collector = await fakeCollector();
    const { forwarder, changes } = forwarderFor(collector.url, {
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20token-123",
    });
    forwarder.forward(record);
    await forwarder.idle();

    expect(collector.seen).toHaveLength(1);
    const [request] = collector.seen as [Seen];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/traces");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["authorization"]).toBe("Bearer token-123");
    const body = JSON.parse(request.body) as OtlpTraceRequest;
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((span) => span.name)).toEqual(["unit observer", "invoke_agent observer"]);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(request.body).not.toContain("secret");

    expect(forwarder.report()).toEqual({
      sent: 1,
      dropped: 0,
      lastError: null,
      lastSentAt: "2026-11-20T11:00:00.000Z",
    });
    expect(changes()).toBe(1);
  });

  test("re-sending a record sends the same trace and span IDs", async () => {
    const collector = await fakeCollector();
    const { forwarder } = forwarderFor(collector.url);
    forwarder.forward(record);
    forwarder.forward(record);
    await forwarder.idle();
    const ids = collector.seen.map((seen) =>
      (JSON.parse(seen.body) as OtlpTraceRequest).resourceSpans[0]!.scopeSpans[0]!.spans.map(
        (span) => `${span.traceId}/${span.spanId}`,
      ),
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toEqual(ids[1]);
  });

  test.each([429, 502, 503, 504])("HTTP %i is retried once, after Retry-After", async (code) => {
    const collector = await fakeCollector([status(code, { "retry-after": "2" })]);
    const { forwarder, waits } = forwarderFor(collector.url);
    forwarder.forward(record);
    await forwarder.idle();
    expect(collector.seen).toHaveLength(2);
    expect(waits).toEqual([2000]);
    expect(forwarder.report()).toMatchObject({ sent: 1, dropped: 0, lastError: null });
  });

  test("a retryable status twice is dropped after the one retry", async () => {
    const collector = await fakeCollector([status(503), status(503), status(503)]);
    const { forwarder, waits } = forwarderFor(collector.url);
    forwarder.forward(record);
    await forwarder.idle();
    expect(collector.seen).toHaveLength(2);
    expect(waits).toEqual([OTLP_RETRY_DEFAULT_MS]);
    expect(forwarder.report()).toEqual({
      sent: 0,
      dropped: 1,
      lastError: `${collector.url}/v1/traces answered HTTP 503`,
      lastSentAt: null,
    });
  });

  test.each([400, 401, 403, 404, 500])("HTTP %i is dropped without a retry", async (code) => {
    const collector = await fakeCollector([status(code)]);
    const { forwarder, waits } = forwarderFor(collector.url);
    forwarder.forward(record);
    await forwarder.idle();
    expect(collector.seen).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(forwarder.report()).toMatchObject({ sent: 0, dropped: 1 });
  });

  test("a partial success is dropped and never retried", async () => {
    const collector = await fakeCollector([
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ partialSuccess: { rejectedSpans: "1", errorMessage: "too old" } }),
        );
      },
    ]);
    const { forwarder } = forwarderFor(collector.url);
    forwarder.forward(record);
    await forwarder.idle();
    expect(collector.seen).toHaveLength(1);
    expect(forwarder.report()).toMatchObject({
      sent: 0,
      dropped: 1,
      lastError: `${collector.url}/v1/traces rejected 1 span(s): too old`,
    });
  });

  test("a dropped connection is retried once", async () => {
    const collector = await fakeCollector([(response) => response.socket?.destroy()]);
    const { forwarder, waits } = forwarderFor(collector.url);
    forwarder.forward(record);
    await forwarder.idle();
    expect(collector.seen).toHaveLength(2);
    expect(waits).toEqual([OTLP_RETRY_DEFAULT_MS]);
    expect(forwarder.report()).toMatchObject({ sent: 1, dropped: 0 });
  });

  test("a collector that is not there is dropped after one retry, and a later success clears the error", async () => {
    const { forwarder } = forwarderFor("http://127.0.0.1:1");
    forwarder.forward(record);
    await forwarder.idle();
    expect(forwarder.report()).toMatchObject({ sent: 0, dropped: 1 });
    expect(forwarder.report().lastError).toMatch(/^connection failed/);

    const collector = await fakeCollector();
    const healthy = forwarderFor(collector.url).forwarder;
    healthy.forward(record);
    await healthy.idle();
    expect(healthy.report().lastError).toBeNull();
  });

  test("nothing is written to disk: the only filesystem call the sender makes is a read", () => {
    const source = readFileSync(new URL("./telemetry-forwarder.ts", import.meta.url), "utf8");
    const fsImports = [...source.matchAll(/import \{([^}]*)\} from "node:fs(?:\/promises)?"/g)];
    expect(fsImports.map((match) => match[1]!.trim())).toEqual(["readFileSync"]);
    expect(source).not.toMatch(/from "node:fs\/promises"/);
  });
});

describe("retryAfterMs", () => {
  const now = new Date("2026-11-20T11:00:00.000Z");
  test("seconds, an HTTP date, nothing, and a wait too long to honour", () => {
    expect(retryAfterMs("3", now)).toBe(3000);
    expect(retryAfterMs("Fri, 20 Nov 2026 11:00:05 GMT", now)).toBe(5000);
    expect(retryAfterMs(null, now)).toBe(OTLP_RETRY_DEFAULT_MS);
    expect(retryAfterMs("garbage", now)).toBe(OTLP_RETRY_DEFAULT_MS);
    expect(retryAfterMs("3600", now)).toBe(OTLP_RETRY_MAX_MS);
  });
});

describe("engineVersionAt", () => {
  test("reads the version at the checkout root above src/cli.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "phoebe-engine-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.19.0" }));
    expect(engineVersionAt(join(root, "src", "cli.ts"))).toBe("0.19.0");
    expect(engineVersionAt(join(root, "missing", "src", "cli.ts"))).toBe("unknown");
  });
});
