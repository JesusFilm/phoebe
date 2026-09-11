// The Sentry-protocol adapter: the list URL each collector policy builds, the
// client-side gates, pagination, and the event read that feeds the prompt.

import { describe, expect, test } from "vite-plus/test";
import type { FetchLike } from "../../src/sentry-protocol.ts";
import {
  buildListUrl,
  createSentrySource,
  passesGates,
  readEvent,
  windowMs,
  type SentryGroup,
} from "./adapter.ts";
import { resolveSentryOptions, type SentryKindOptions } from "./options.ts";

const NOW = new Date("2026-09-11T12:00:00Z");

function options(overrides: Record<string, unknown> = {}): SentryKindOptions {
  return resolveSentryOptions({ org: "acme", project: 4507, ...overrides }, "kinds.sentry");
}

function group(overrides: Partial<SentryGroup> = {}): SentryGroup {
  return {
    id: "1",
    shortId: "ACME-1",
    title: "TypeError: x is undefined",
    culprit: "app/main.ts in boot",
    level: "error",
    count: 12,
    firstSeen: "2026-09-10T00:00:00Z",
    lastSeen: "2026-09-11T11:00:00Z",
    permalink: "https://sentry.io/organizations/acme/issues/1/",
    raw: {},
    ...overrides,
  };
}

describe("windowMs", () => {
  test("reads every unit of the period grammar", () => {
    expect(windowMs("30s")).toBe(30_000);
    expect(windowMs("24h")).toBe(86_400_000);
    expect(windowMs("2w")).toBe(2 * 604_800_000);
  });
});

describe("buildListUrl", () => {
  test("sentry: the gates go server-side as statsPeriod, environment and the search grammar", () => {
    const url = new URL(buildListUrl(options(), NOW));
    expect(url.pathname).toBe("/api/0/organizations/acme/issues/");
    expect(url.searchParams.get("project")).toBe("4507");
    expect(url.searchParams.get("statsPeriod")).toBe("24h");
    expect(url.searchParams.getAll("environment")).toEqual(["production"]);
    expect(url.searchParams.get("query")).toBe("is:unresolved timesSeen:>=2 level:[error,fatal]");
    expect(url.searchParams.get("sort")).toBe("freq");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  test("a single level is a plain term", () => {
    const url = new URL(buildListUrl(options({ levels: ["fatal"] }), NOW));
    expect(url.searchParams.get("query")).toBe("is:unresolved timesSeen:>=2 level:fatal");
  });

  test("glitchtip: start/end instead of statsPeriod, its own sort, only is:unresolved", () => {
    const url = new URL(buildListUrl(options({ collector: "glitchtip", window: "2h" }), NOW));
    expect(url.searchParams.get("statsPeriod")).toBeNull();
    expect(url.searchParams.get("start")).toBe("2026-09-11T10:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-09-11T12:00:00.000Z");
    expect(url.searchParams.get("query")).toBe("is:unresolved");
    expect(url.searchParams.get("sort")).toBe("-count");
  });
});

describe("passesGates", () => {
  test("level, event floor and window apply client-side whatever the collector", () => {
    const opts = options();
    expect(passesGates(group(), opts, NOW)).toBe(true);
    expect(passesGates(group({ level: "warning" }), opts, NOW)).toBe(false);
    expect(passesGates(group({ count: 1 }), opts, NOW)).toBe(false);
    expect(passesGates(group({ lastSeen: "2026-09-09T00:00:00Z" }), opts, NOW)).toBe(false);
  });

  test("a count or lastSeen that cannot be read fails closed", () => {
    expect(passesGates(group({ lastSeen: "" }), options(), NOW)).toBe(false);
    expect(passesGates(group({ count: Number.NaN }), options(), NOW)).toBe(false);
  });
});

describe("readEvent", () => {
  test("reads release, environment, transaction and the innermost exception's frames", () => {
    const event = readEvent({
      eventID: "abc",
      release: { version: "app@1.2.3" },
      dateCreated: "2026-09-11T11:00:00Z",
      tags: [
        { key: "environment", value: "production" },
        { key: "transaction", value: "GET /boot" },
      ],
      entries: [
        { type: "breadcrumbs" },
        {
          type: "exception",
          data: {
            values: [
              { stacktrace: { frames: [{ filename: "outer.ts", lineNo: 1 }] } },
              {
                stacktrace: {
                  frames: [
                    { filename: "node_modules/x.js", function: "wrap", lineNo: 5, inApp: false },
                    {
                      filename: "app/main.ts",
                      function: "boot",
                      lineNo: 42,
                      colNo: 7,
                      inApp: true,
                      context: [
                        [41, "const x = y;"],
                        [42, "x.z();"],
                        ["bad", "row"],
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    expect(event.eventId).toBe("abc");
    expect(event.release).toBe("app@1.2.3");
    expect(event.environment).toBe("production");
    expect(event.transaction).toBe("GET /boot");
    expect(event.frames).toHaveLength(2);
    expect(event.frames[1]).toEqual({
      filename: "app/main.ts",
      function: "boot",
      lineNo: 42,
      colNo: 7,
      inApp: true,
      context: [
        [41, "const x = y;"],
        [42, "x.z();"],
      ],
    });
  });

  test("a string release, a release tag, and no release at all", () => {
    expect(readEvent({ release: "r1" }).release).toBe("r1");
    expect(readEvent({ tags: [{ key: "release", value: "r2" }] }).release).toBe("r2");
    expect(readEvent({ release: null, culprit: "c" })).toMatchObject({
      release: null,
      transaction: "c",
      frames: [],
    });
  });
});

describe("createSentrySource", () => {
  test("lists across pages, applies the gates, and reads the latest event", async () => {
    const requested: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requested.push(url);
      if (url.includes("/events/latest/")) {
        return new Response(JSON.stringify({ eventID: "e1", release: "r1" }), { status: 200 });
      }
      if (url.includes("cursor=2")) {
        return new Response(
          JSON.stringify([{ id: 3, level: "error", count: "9", lastSeen: NOW.toISOString() }]),
          {
            status: 200,
            headers: { Link: '<https://x/?cursor=3>; rel="next"; results="false"' },
          },
        );
      }
      return new Response(
        JSON.stringify([
          { id: 1, level: "error", count: "20", lastSeen: NOW.toISOString(), title: "T" },
          { id: 2, level: "info", count: "50", lastSeen: NOW.toISOString() },
        ]),
        {
          status: 200,
          headers: {
            Link: '<https://sentry.io/api/0/organizations/acme/issues/?cursor=2>; rel="next"; results="true"',
          },
        },
      );
    };
    const source = createSentrySource({ options: options(), token: "t", fetchFn, now: () => NOW });
    const groups = await source.listUnresolvedGroups();
    expect(groups.map((g) => g.id)).toEqual(["1", "3"]);
    expect(groups[0]?.title).toBe("T");
    expect(groups[0]?.count).toBe(20);
    expect(requested).toHaveLength(2);

    const event = await source.latestEvent("1");
    expect(event.release).toBe("r1");
    expect(requested[2]).toBe("https://sentry.io/api/0/organizations/acme/issues/1/events/latest/");
  });
});
