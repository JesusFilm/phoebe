// The deps.dev client against a fake fetch: a normal answer sorted by the
// ecosystem's order, back-off on 429 and 5xx, failures as results, and the
// per-package cache.

import { describe, expect, test } from "vite-plus/test";
import { createDepsDevClient } from "./deps-dev.ts";
import type { Clock, Fetch } from "./http.ts";

function fakeClock(start = Date.parse("2026-11-06T12:00:00Z")) {
  const sleeps: number[] = [];
  let now = start;
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { clock, sleeps, advance: (ms: number) => (now += ms) };
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(...replies: Reply[]) {
  const urls: string[] = [];
  const fetch: Fetch = async (input) => {
    urls.push(input);
    const reply = replies.shift() ?? { status: 500 };
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetch, urls };
}

function packageBody(system: string, name: string, versions: [string, string?][]) {
  return {
    packageKey: { system, name },
    versions: versions.map(([version, publishedAt]) => ({
      versionKey: { system, name, version },
      ...(publishedAt === undefined ? {} : { publishedAt }),
      isDefault: false,
      isDeprecated: false,
    })),
  };
}

const HOUR = { "cache-control": "public, max-age=3600" };

describe("versions", () => {
  test("returns every version oldest first, with publish dates where deps.dev has one", async () => {
    const { clock } = fakeClock();
    const { fetch, urls } = fakeFetch({
      headers: HOUR,
      body: packageBody("NPM", "@colors/colors", [
        ["1.6.1", "2026-09-07T03:51:27Z"],
        ["1.10.0", "2026-10-01T00:00:00Z"],
        ["1.6.1-rc.1"],
        ["1.2.0", "2020-01-01T00:00:00Z"],
      ]),
    });
    const result = await createDepsDevClient({ fetch, clock }).versions("npm", "@colors/colors");
    expect(urls).toEqual(["https://api.deps.dev/v3/systems/npm/packages/%40colors%2Fcolors"]);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          version: "1.2.0",
          publishedAt: "2020-01-01T00:00:00Z",
          isDefault: false,
          isDeprecated: false,
        },
        { version: "1.6.1-rc.1", isDefault: false, isDeprecated: false },
        {
          version: "1.6.1",
          publishedAt: "2026-09-07T03:51:27Z",
          isDefault: false,
          isDeprecated: false,
        },
        {
          version: "1.10.0",
          publishedAt: "2026-10-01T00:00:00Z",
          isDefault: false,
          isDeprecated: false,
        },
      ],
    });
  });

  test("normalises a PyPI name and sorts by PEP 440", async () => {
    const { clock } = fakeClock();
    const { fetch, urls } = fakeFetch({
      body: packageBody("PYPI", "zope-interface", [
        ["2.9.2"],
        ["2.10.0"],
        ["2.10.0rc1"],
        ["2.10.0.post1"],
        ["2.10.0.dev1"],
      ]),
    });
    const result = await createDepsDevClient({ fetch, clock }).versions("pypi", "Zope.Interface");
    expect(urls).toEqual(["https://api.deps.dev/v3/systems/pypi/packages/zope-interface"]);
    expect(result.ok && result.value.map((v) => v.version)).toEqual([
      "2.9.2",
      "2.10.0.dev1",
      "2.10.0rc1",
      "2.10.0",
      "2.10.0.post1",
    ]);
  });

  test("waits out a 429's retry-after, then answers", async () => {
    const { clock, sleeps } = fakeClock();
    const { fetch, urls } = fakeFetch(
      { status: 429, headers: { "retry-after": "7" } },
      { body: packageBody("CARGO", "serde", [["1.0.0"]]) },
    );
    const result = await createDepsDevClient({ fetch, clock }).versions("cargo", "serde");
    expect(sleeps).toEqual([7_000]);
    expect(urls).toHaveLength(2);
    expect(result.ok).toBe(true);
  });

  test("returns a 5xx that outlasts the retries as a failed result", async () => {
    const { clock, sleeps } = fakeClock();
    const { fetch, urls } = fakeFetch({ status: 503 }, { status: 502 }, { status: 500 });
    const result = await createDepsDevClient({ fetch, clock }).versions("npm", "react");
    expect(urls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(result).toEqual({
      ok: false,
      source: "deps.dev",
      status: 500,
      error: "https://api.deps.dev/v3/systems/npm/packages/react: HTTP 500",
    });
  });

  test("does not retry a 404, and a thrown fetch is a failure too", async () => {
    const { clock, sleeps } = fakeClock();
    const notFound = fakeFetch({ status: 404 });
    expect(
      await createDepsDevClient({ fetch: notFound.fetch, clock }).versions("npm", "nope"),
    ).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(notFound.urls).toHaveLength(1);
    const offline: Fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    expect(await createDepsDevClient({ fetch: offline, clock }).versions("npm", "react")).toEqual({
      ok: false,
      source: "deps.dev",
      error: "https://api.deps.dev/v3/systems/npm/packages/react: getaddrinfo ENOTFOUND",
    });
    expect(sleeps).toEqual([]);
  });

  test("a package asked twice costs one request until max-age runs out", async () => {
    const { clock, advance } = fakeClock();
    const body = packageBody("NPM", "react", [["19.0.0"]]);
    const { fetch, urls } = fakeFetch({ headers: HOUR, body }, { headers: HOUR, body });
    const client = createDepsDevClient({ fetch, clock });
    const [first, second] = await Promise.all([
      client.versions("npm", "react"),
      client.versions("npm", "react"),
    ]);
    expect(second).toEqual(first);
    advance(3_599_000);
    await client.versions("npm", "react");
    expect(urls).toHaveLength(1);
    advance(1_000);
    await client.versions("npm", "react");
    expect(urls).toHaveLength(2);
  });

  test("a failure is not cached", async () => {
    const { clock } = fakeClock();
    const { fetch, urls } = fakeFetch(
      { status: 404 },
      { body: packageBody("NPM", "react", [["19.0.0"]]) },
    );
    const client = createDepsDevClient({ fetch, clock });
    expect((await client.versions("npm", "react")).ok).toBe(false);
    expect((await client.versions("npm", "react")).ok).toBe(true);
    expect(urls).toHaveLength(2);
  });
});
