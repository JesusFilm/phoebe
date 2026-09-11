// The crash reporter: what leaves the box and under which switch, the
// envelope shape, the stack redaction, and the never-throws posture of a send.

import { describe, expect, test } from "vite-plus/test";
import {
  authHeader,
  buildCrashPayload,
  buildEnvelope,
  createCrashReporter,
  parseStackFrames,
  redactTenantPaths,
  type CrashContext,
} from "./crash-reporter.ts";
import { parseDsn, type FetchLike } from "./sentry-protocol.ts";

const context: CrashContext = {
  bootstrapVersion: "0.12.1",
  engineRef: "main",
  engineSha: "abc123",
  deploymentArm: "workspace",
  credentialArm: "app",
};
const NOW = new Date("2026-09-11T12:00:00Z");

describe("redactTenantPaths", () => {
  test("rewrites every per-tenant data path to <tenant>", () => {
    expect(
      redactTenantPaths(
        "at boot (/data/repos/acme/widget/repo/src/x.ts:1:2) and /data/repos/acme/gadget/worktrees/y",
      ),
    ).toBe("at boot (<tenant>/repo/src/x.ts:1:2) and <tenant>/worktrees/y");
  });
});

describe("parseStackFrames", () => {
  test("reads named and anonymous frames, innermost last", () => {
    const frames = parseStackFrames(
      "Error: boom\n    at inner (/e/src/a.ts:10:5)\n    at /e/src/b.ts:20:1\n    at new Promise (<anonymous>)",
    );
    expect(frames).toEqual([
      { function: "new Promise (<anonymous>)", filename: "?" },
      { function: "<anonymous>", filename: "/e/src/b.ts", lineno: 20, colno: 1 },
      { function: "inner", filename: "/e/src/a.ts", lineno: 10, colno: 5 },
    ]);
  });
});

describe("buildCrashPayload", () => {
  const error = new Error("clone failed for /data/repos/acme/widget/repo");
  error.stack = "Error: clone failed\n    at run (/data/repos/acme/widget/repo/x.ts:1:1)";

  test("carries the phase and process tags, the error, and a redacted stack", () => {
    const payload = buildCrashPayload(
      {
        phase: "boot",
        level: "error",
        error,
        tenant: "acme/widget",
        ref: "issue:3",
        tags: { stage: "clone", exitCode: 1 },
      },
      context,
      { includeRef: false, now: NOW, eventId: "e1" },
    );
    expect(payload).toEqual({
      event_id: "e1",
      timestamp: "2026-09-11T12:00:00.000Z",
      platform: "node",
      logger: "phoebe",
      level: "error",
      release: "abc123",
      tags: {
        phase: "boot",
        bootstrapVersion: "0.12.1",
        engineRef: "main",
        engineSha: "abc123",
        node: process.version,
        deploymentArm: "workspace",
        credentialArm: "app",
        tenant: "redacted",
        stage: "clone",
        exitCode: "1",
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "clone failed for <tenant>/repo",
            stacktrace: {
              frames: [{ function: "run", filename: "<tenant>/repo/x.ts", lineno: 1, colno: 1 }],
            },
          },
        ],
      },
    });
  });

  test("includeRef opens the tenant slug and the unit ref together", () => {
    const payload = buildCrashPayload(
      {
        phase: "upgrade",
        level: "fatal",
        error: "plain string",
        tenant: "acme/widget",
        ref: "issue:3",
      },
      { ...context, engineSha: null, deploymentArm: null },
      { includeRef: true, now: NOW, eventId: "e2" },
    );
    const tags = payload["tags"] as Record<string, string>;
    expect(tags["tenant"]).toBe("acme/widget");
    expect(tags["ref"]).toBe("issue:3");
    expect(tags["deploymentArm"]).toBe("unknown");
    expect(payload["release"]).toBeUndefined();
    expect(payload["exception"]).toEqual({ values: [{ type: "Error", value: "plain string" }] });
  });
});

describe("buildEnvelope / authHeader", () => {
  test("three newline-separated lines and a v7 auth header naming the public key", () => {
    const dsn = parseDsn("https://key@o1.ingest.sentry.io/42");
    const envelope = buildEnvelope(dsn, { event_id: "e1", level: "error" }, NOW);
    const [header, item, body] = envelope.split("\n");
    expect(JSON.parse(header!)).toEqual({
      event_id: "e1",
      sent_at: "2026-09-11T12:00:00.000Z",
      dsn: "https://key@o1.ingest.sentry.io/42",
    });
    expect(JSON.parse(item!)).toEqual({ type: "event", length: body!.length });
    expect(JSON.parse(body!)).toEqual({ event_id: "e1", level: "error" });
    expect(authHeader(dsn)).toBe(
      "Sentry sentry_version=7, sentry_client=phoebe-crash-reporter/1, sentry_key=key",
    );
  });
});

describe("createCrashReporter", () => {
  function capturing() {
    const posts: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      posts.push({ url, init });
      return new Response("", { status: 200 });
    };
    return { posts, fetchFn };
  }

  test("no block, or both switches off, builds no client and posts nothing", async () => {
    const { posts, fetchFn } = capturing();
    for (const reporting of [undefined, {}, { maintainers: false }]) {
      const reporter = createCrashReporter({
        reporting,
        context,
        fetchFn,
        maintainersDsn: "https://k@h/1",
      });
      expect(reporter.enabled).toBe(false);
      await reporter.report({ phase: "doctor", level: "error", error: new Error("x") });
    }
    expect(posts).toEqual([]);
  });

  test("both set means both targets get the same envelope", async () => {
    const { posts, fetchFn } = capturing();
    const reporter = createCrashReporter({
      reporting: { maintainers: true, dsn: "https://mine@my.host/7" },
      context,
      fetchFn,
      now: () => NOW,
      maintainersDsn: "https://k@o1.ingest.sentry.io/1",
    });
    expect(reporter.enabled).toBe(true);
    await reporter.report({
      phase: "migrate",
      level: "error",
      error: new Error("m001 verify failed"),
    });
    expect(posts.map((p) => p.url)).toEqual([
      "https://o1.ingest.sentry.io/api/1/envelope/",
      "https://my.host/api/7/envelope/",
    ]);
    const headers = posts[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-sentry-envelope");
    expect(headers["X-Sentry-Auth"]).toContain("sentry_key=k");
    const [first, second] = posts.map((p) => p.init.body as string);
    expect(first).toBe(
      second!.replace("https://mine@my.host/7", "https://k@o1.ingest.sentry.io/1"),
    );
  });

  test("maintainers on with no baked-in DSN is a debug line, not a client", () => {
    const lines: string[] = [];
    const reporter = createCrashReporter({
      reporting: { maintainers: true },
      context,
      debug: (l) => lines.push(l),
      maintainersDsn: null,
    });
    expect(reporter.enabled).toBe(false);
    expect(lines[0]).toContain("carries no maintainers DSN");
  });

  test("an unparseable consumer DSN is dropped at debug level", () => {
    const lines: string[] = [];
    const reporter = createCrashReporter({
      reporting: { dsn: "nope" },
      context,
      debug: (l) => lines.push(l),
    });
    expect(reporter.enabled).toBe(false);
    expect(lines[0]).toContain("reporting.dsn DSN ignored");
  });

  test("a failed or rejected send is logged at debug and never thrown; flush waits it out", async () => {
    const lines: string[] = [];
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      return new Response("", { status: 429 });
    };
    const reporter = createCrashReporter({
      reporting: { dsn: "https://k@h/1" },
      context,
      fetchFn,
      debug: (l) => lines.push(l),
    });
    void reporter.report({ phase: "boot", level: "fatal", error: new Error("a") });
    void reporter.report({ phase: "boot", level: "fatal", error: new Error("b") });
    await reporter.flush();
    expect(lines).toEqual([
      "crash reporter: could not reach h — ECONNREFUSED",
      "crash reporter: h answered 429.",
    ]);
  });
});
