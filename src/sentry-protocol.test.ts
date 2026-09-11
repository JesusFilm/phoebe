// The Sentry wire shapes: DSN parsing (both the kind's collector URL and the
// crash reporter's envelope endpoint start here), the API request helper, and
// the Link-header pagination read.

import { describe, expect, test } from "vite-plus/test";
import {
  nextPageUrl,
  normalizeCollectorUrl,
  parseDsn,
  sentryApiRequest,
  type FetchLike,
} from "./sentry-protocol.ts";

describe("parseDsn", () => {
  test("takes the SDK-standard shape apart and derives the envelope endpoint", () => {
    const parsed = parseDsn("https://abc123@o456.ingest.us.sentry.io/789");
    expect(parsed).toEqual({
      protocol: "https:",
      host: "o456.ingest.us.sentry.io",
      pathPrefix: "",
      publicKey: "abc123",
      projectId: "789",
      envelopeUrl: "https://o456.ingest.us.sentry.io/api/789/envelope/",
    });
  });

  test("keeps a self-hosted path prefix and ignores a legacy secret", () => {
    const parsed = parseDsn("http://key:secret@sentry.internal:9000/prefix/42");
    expect(parsed.pathPrefix).toBe("/prefix");
    expect(parsed.host).toBe("sentry.internal:9000");
    expect(parsed.envelopeUrl).toBe("http://sentry.internal:9000/prefix/api/42/envelope/");
  });

  test.each([
    ["not a url", "not a URL"],
    ["ftp://key@host/1", "must be http(s)"],
    ["https://host/1", "no public key"],
    ["https://key@host/", "numeric project id"],
    ["https://key@host/abc", "numeric project id"],
  ])("refuses %s", (dsn, message) => {
    expect(() => parseDsn(dsn)).toThrow(message);
  });
});

describe("normalizeCollectorUrl", () => {
  test("strips a trailing slash and keeps a sub-path", () => {
    expect(normalizeCollectorUrl("https://sentry.io/")).toBe("https://sentry.io");
    expect(normalizeCollectorUrl("https://glitchtip.corp/sentry/")).toBe(
      "https://glitchtip.corp/sentry",
    );
  });

  test("refuses a relative or non-http value", () => {
    expect(() => normalizeCollectorUrl("sentry.io")).toThrow("absolute URL");
    expect(() => normalizeCollectorUrl("ftp://sentry.io")).toThrow("http(s)");
  });
});

describe("sentryApiRequest", () => {
  test("sends the bearer token and returns the parsed body with headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { Link: '<https://x/?cursor=1>; rel="next"; results="false"' },
      });
    };
    const { body, headers } = await sentryApiRequest<{ ok: number }>({
      fetchFn,
      url: "https://sentry.io/api/0/x/",
      token: "tok",
      timeoutMs: 1000,
    });
    expect(body).toEqual({ ok: 1 });
    expect(headers.get("Link")).toContain('rel="next"');
    const headersSent = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headersSent?.["Authorization"]).toBe("Bearer tok");
  });

  test("a non-2xx answer throws naming the status and the body", async () => {
    const fetchFn: FetchLike = async () =>
      new Response(JSON.stringify({ detail: "Invalid token" }), { status: 401 });
    await expect(
      sentryApiRequest({ fetchFn, url: "https://sentry.io/api/0/x/", token: "t", timeoutMs: 1 }),
    ).rejects.toThrow('Sentry API 401 for https://sentry.io/api/0/x/: {"detail":"Invalid token"}');
  });
});

describe("nextPageUrl", () => {
  test("follows rel=next only while results=true", () => {
    const more =
      '<https://s/api/0/i/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
      '<https://s/api/0/i/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
    expect(nextPageUrl(more)).toBe("https://s/api/0/i/?cursor=0:100:0");
    expect(nextPageUrl(more.replace('results="true"', 'results="false"'))).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
  });
});
