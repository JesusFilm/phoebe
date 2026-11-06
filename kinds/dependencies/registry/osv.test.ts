// The OSV client against a fake fetch: a batch answer read into advisories,
// back-off on 429 and 5xx, failures as results, batch splitting and paging,
// and the advisory cache keyed on id and `modified`.

import { describe, expect, test } from "vite-plus/test";
import type { Clock, Fetch } from "./http.ts";
import { MAX_BATCH_QUERIES, createOsvClient, cvss3BaseScore } from "./osv.ts";

function fakeClock() {
  const sleeps: number[] = [];
  let now = Date.parse("2026-11-06T12:00:00Z");
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { clock, sleeps };
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Route = (url: string, body: unknown) => Reply;

function fakeFetch(route: Route) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: Fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: input, body });
    const reply = route(input, body);
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetch, calls };
}

const LODASH_VULN = {
  id: "GHSA-p6mc-m468-83gw",
  modified: "2026-10-01T00:00:00Z",
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { ecosystem: "npm", name: "lodash" },
      ranges: [
        {
          type: "SEMVER",
          events: [
            { introduced: "0" },
            { fixed: "4.17.12" },
            { introduced: "4.17.13" },
            { fixed: "4.17.21" },
          ],
        },
      ],
    },
  ],
};

const JINJA_VULN = {
  id: "PYSEC-2024-1",
  modified: "2026-09-01T00:00:00Z",
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
  affected: [
    {
      package: { ecosystem: "PyPI", name: "Jinja2" },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "3.1.5" }] }],
    },
  ],
};

const VULNS: Record<string, unknown> = {
  [LODASH_VULN.id]: LODASH_VULN,
  [JINJA_VULN.id]: JINJA_VULN,
};

function ref(vuln: { id: string; modified: string }) {
  return { id: vuln.id, modified: vuln.modified };
}

/** OSV as it answers today: lodash 4.17.15 and jinja2 3.1.4 are affected, nothing else. */
function osv(url: string, body: unknown): Reply {
  if (url.endsWith("/querybatch")) {
    const queries = (body as { queries: { package?: { name: string }; version?: string }[] })
      .queries;
    return {
      body: {
        results: queries.map((q) =>
          q.package?.name === "lodash" && q.version === "4.17.15"
            ? { vulns: [ref(LODASH_VULN)] }
            : q.package?.name === "jinja2"
              ? { vulns: [ref(JINJA_VULN)] }
              : {},
        ),
      },
    };
  }
  const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
  return VULNS[id] === undefined ? { status: 404 } : { body: VULNS[id] };
}

describe("advisories", () => {
  test("reads id, severity and the first fixed version above the queried one, in query order", async () => {
    const { clock } = fakeClock();
    const { fetch, calls } = fakeFetch(osv);
    const result = await createOsvClient({ fetch, clock }).advisories([
      { ecosystem: "npm", name: "lodash", version: "4.17.15" },
      { ecosystem: "crates.io", name: "serde", version: "1.0.0" },
      { ecosystem: "PyPI", name: "jinja2", version: "3.1.4" },
    ]);
    expect(result).toEqual({
      ok: true,
      value: [
        [{ id: "GHSA-p6mc-m468-83gw", severity: "high", fixedIn: "4.17.21" }],
        [],
        [{ id: "PYSEC-2024-1", severity: "critical", fixedIn: "3.1.5" }],
      ],
    });
    expect(calls[0]).toEqual({
      url: "https://api.osv.dev/v1/querybatch",
      body: {
        queries: [
          { package: { ecosystem: "npm", name: "lodash" }, version: "4.17.15" },
          { package: { ecosystem: "crates.io", name: "serde" }, version: "1.0.0" },
          { package: { ecosystem: "PyPI", name: "jinja2" }, version: "3.1.4" },
        ],
      },
    });
    expect(
      calls
        .slice(1)
        .map((c) => c.url)
        .sort(),
    ).toEqual([
      "https://api.osv.dev/v1/vulns/GHSA-p6mc-m468-83gw",
      "https://api.osv.dev/v1/vulns/PYSEC-2024-1",
    ]);
  });

  test("asks about a GitHub Action by commit and reports its fixed tag", async () => {
    const { clock } = fakeClock();
    const vuln = {
      id: "CVE-2025-30066",
      modified: "2026-01-01T00:00:00Z",
      affected: [
        {
          package: { ecosystem: "GitHub Actions", name: "tj-actions/changed-files" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "46.0.1" }] }],
        },
      ],
    };
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith("/querybatch")
        ? { body: { results: [{ vulns: [ref(vuln)] }] } }
        : { body: vuln },
    );
    const result = await createOsvClient({ fetch, clock }).advisories([
      { ecosystem: "GitHub Actions", name: "tj-actions/changed-files", commit: "a284dc18" },
    ]);
    expect(calls[0]!.body).toEqual({ queries: [{ commit: "a284dc18" }] });
    expect(result).toEqual({
      ok: true,
      value: [[{ id: "CVE-2025-30066", severity: "moderate", fixedIn: "46.0.1" }]],
    });
  });

  test("waits out a 429's retry-after on the batch, then answers", async () => {
    const { clock, sleeps } = fakeClock();
    let limited = true;
    const { fetch } = fakeFetch((url, body) => {
      if (url.endsWith("/querybatch") && limited) {
        limited = false;
        return { status: 429, headers: { "retry-after": "Fri, 06 Nov 2026 12:00:05 GMT" } };
      }
      return osv(url, body);
    });
    const result = await createOsvClient({ fetch, clock }).advisories([
      { ecosystem: "npm", name: "lodash", version: "4.17.15" },
    ]);
    expect(sleeps).toEqual([5_000]);
    expect(result.ok).toBe(true);
  });

  test("returns a 5xx that outlasts the retries as a failed result", async () => {
    const { clock, sleeps } = fakeClock();
    const { fetch, calls } = fakeFetch(() => ({ status: 503 }));
    const result = await createOsvClient({ fetch, clock }).advisories([
      { ecosystem: "npm", name: "lodash", version: "4.17.15" },
    ]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(result).toEqual({
      ok: false,
      source: "osv",
      status: 503,
      error: "https://api.osv.dev/v1/querybatch: HTTP 503",
    });
  });

  test("a failed advisory fetch fails the call, and is asked again next time", async () => {
    const { clock } = fakeClock();
    let broken = true;
    const { fetch, calls } = fakeFetch((url, body) =>
      url.includes("/vulns/") && broken ? { status: 404 } : osv(url, body),
    );
    const client = createOsvClient({ fetch, clock });
    const query = { ecosystem: "npm", name: "lodash", version: "4.17.15" } as const;
    expect(await client.advisories([query])).toMatchObject({
      ok: false,
      source: "osv",
      status: 404,
    });
    broken = false;
    expect((await client.advisories([query])).ok).toBe(true);
    expect(calls.filter((c) => c.url.includes("/vulns/"))).toHaveLength(2);
  });

  test("a query asked twice is sent once, and an unchanged advisory is fetched once", async () => {
    const { clock } = fakeClock();
    const { fetch, calls } = fakeFetch(osv);
    const client = createOsvClient({ fetch, clock });
    const query = { ecosystem: "npm", name: "lodash", version: "4.17.15" } as const;
    const first = await client.advisories([query, query]);
    expect(first.ok && first.value).toHaveLength(2);
    expect(calls[0]!.body).toEqual({
      queries: [{ package: { ecosystem: "npm", name: "lodash" }, version: "4.17.15" }],
    });
    await client.advisories([query]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.osv.dev/v1/querybatch",
      "https://api.osv.dev/v1/vulns/GHSA-p6mc-m468-83gw",
      "https://api.osv.dev/v1/querybatch",
    ]);
  });

  test("an advisory whose modified stamp moves is fetched again", async () => {
    const { clock } = fakeClock();
    let modified = LODASH_VULN.modified;
    const { fetch, calls } = fakeFetch((url, body) =>
      url.endsWith("/querybatch")
        ? { body: { results: [{ vulns: [{ id: LODASH_VULN.id, modified }] }] } }
        : osv(url, body),
    );
    const client = createOsvClient({ fetch, clock });
    const query = { ecosystem: "npm", name: "lodash", version: "4.17.15" } as const;
    await client.advisories([query]);
    modified = "2026-11-01T00:00:00Z";
    await client.advisories([query]);
    expect(calls.filter((c) => c.url.includes("/vulns/"))).toHaveLength(2);
  });

  test("splits past 1,000 queries and follows page tokens", async () => {
    const { clock } = fakeClock();
    const { fetch, calls } = fakeFetch((url, body) => {
      if (!url.endsWith("/querybatch")) return osv(url, body);
      const queries = (body as { queries: { package: { name: string }; page_token?: string }[] })
        .queries;
      return {
        body: {
          results: queries.map((q) =>
            q.package.name !== "lodash"
              ? {}
              : q.page_token === undefined
                ? { next_page_token: "page-2" }
                : { vulns: [ref(LODASH_VULN)] },
          ),
        },
      };
    });
    const queries = Array.from({ length: MAX_BATCH_QUERIES }, (_, i) => ({
      ecosystem: "npm" as const,
      name: `pkg-${i}`,
      version: "1.0.0",
    }));
    queries.push({ ecosystem: "npm", name: "lodash", version: "4.17.15" });
    const result = await createOsvClient({ fetch, clock }).advisories(queries);
    const batches = calls.filter((c) => c.url.endsWith("/querybatch"));
    expect(batches.map((c) => (c.body as { queries: unknown[] }).queries.length)).toEqual([
      1_000, 1, 1,
    ]);
    expect((batches[2]!.body as { queries: unknown[] }).queries).toEqual([
      { package: { ecosystem: "npm", name: "lodash" }, version: "4.17.15", page_token: "page-2" },
    ]);
    expect(result.ok && result.value.at(-1)).toEqual([
      { id: "GHSA-p6mc-m468-83gw", severity: "high", fixedIn: "4.17.21" },
    ]);
  });
});

describe("cvss3BaseScore", () => {
  test.each([
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10],
    ["CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N", 4.3],
    ["CVSS:3.0/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N", 0],
    ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", null],
  ])("%s scores %s", (vector, score) => {
    expect(cvss3BaseScore(vector)).toBe(score);
  });
});
