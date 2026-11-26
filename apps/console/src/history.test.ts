// How the History tab reads one record and asks for a page (#931): the query
// a filter becomes, the path a remote is asked on, how each kind of cost reads,
// and where a unit's GitHub link points.

import { describe, expect, test } from "vite-plus/test";
import type {
  HistoryQuery,
  HistoryRecord,
  RemotePassthrough,
  UnitRecordOutcome,
} from "phoebe-agent/contracts";
import {
  filterChoices,
  githubHref,
  historyPath,
  historyQueryOf,
  localHistory,
  readNeedsALook,
  summaryCost,
  unfinishedOf,
  type HistoryReader,
  NO_CHOICES,
  retainedSince,
  runCost,
  unitCost,
  unitLabel,
  unitTokens,
  usd,
  withChoicesOf,
} from "./history.ts";
import { createRemoteClient } from "./remote-client.ts";
import { agentRun, bridge, historyPage, historyRecord } from "./test-fixture.ts";

describe("asking for a page", () => {
  test("every filter goes into the query, and the cursor when there is one", () => {
    expect(historyQueryOf({})).toEqual({});
    expect(
      historyQueryOf(
        { cell: "/etc/phoebe#work", kind: "issues", outcome: "failed", model: "gpt-5" },
        "2026-09-18T10:00:00.000Z~issues~issue:88",
      ),
    ).toEqual({
      cell: "/etc/phoebe#work",
      kind: "issues",
      outcome: "failed",
      model: "gpt-5",
      before: "2026-09-18T10:00:00.000Z~issues~issue:88",
    });
  });

  test("a remote is asked on /api/history with the query in its query string", () => {
    expect(historyPath({})).toBe("/api/history");
    expect(historyPath({ cell: "/etc/phoebe#work", outcome: "failed", limit: 50 })).toBe(
      "/api/history?cell=%2Fetc%2Fphoebe%23work&outcome=failed&limit=50",
    );
  });

  test("a remote's 404 is a deployment too old to serve history", async () => {
    const asked: RemotePassthrough[] = [];
    const respond = (status: number, body: unknown) => ({
      ...bridge(),
      remotes: {
        ...bridge().remotes,
        request: (_id: string, passthrough: RemotePassthrough) => {
          asked.push(passthrough);
          return Promise.resolve({ status, body });
        },
      },
    });

    const page = historyPage([historyRecord()]);
    const read = createRemoteClient(respond(200, page), "dep_YT").history;
    expect(await read({ kind: "issues" })).toEqual({ kind: "page", page });
    expect(asked[0]).toEqual({ method: "GET", path: "/api/history?kind=issues" });

    const old = createRemoteClient(respond(404, { error: "not-found" }), "dep_YT").history;
    expect(await old({})).toEqual({ kind: "too-old" });

    const refused = createRemoteClient(respond(400, { error: "bad-request" }), "dep_YT").history;
    await expect(refused({})).rejects.toThrow("400 bad-request");
  });

  test("a local install's null page is too old", async () => {
    const page = historyPage([]);
    const queries: { dir: string; query: object }[] = [];
    const read = localHistory(
      bridge({ history: [page, null], historyQueries: queries }),
      "/repos/one",
    );

    expect(await read({ outcome: "failed" })).toEqual({ kind: "page", page });
    expect(await read({})).toEqual({ kind: "too-old" });
    expect(queries[0]).toEqual({ dir: "/repos/one", query: { outcome: "failed" } });
  });
});

describe("the filters' choices", () => {
  test("gather every kind and model seen, and keep the one selected", () => {
    const seen = withChoicesOf(NO_CHOICES, [
      historyRecord({ unit: { kind: "reviews", id: "pr:3" }, model: "gpt-5" }),
      historyRecord(),
      historyRecord({ model: null }),
    ]);
    expect(seen).toEqual({ kinds: ["issues", "reviews"], models: ["claude-opus-5-5", "gpt-5"] });
    expect(filterChoices(seen, { kind: "checks" }).kinds).toEqual(["checks", "issues", "reviews"]);
  });
});

describe("how a cost reads", () => {
  test("API spend is dollars", () => {
    expect(unitCost(historyRecord())).toEqual({ kind: "cost", api: 0.42, estimate: null });
  });

  test("a subscription estimate stays apart from API spend", () => {
    const record = historyRecord({
      agentRuns: [
        agentRun({ costUsd: 1.5, costBasis: "subscription-estimate" }),
        agentRun({ costUsd: 0.25 }),
      ],
    });
    expect(unitCost(record)).toEqual({ kind: "cost", api: 0.25, estimate: 1.5 });
    expect(runCost(record, record.agentRuns[0]!)).toEqual({
      kind: "cost",
      api: null,
      estimate: 1.5,
    });
  });

  test("no cost names the provider that reported tokens without one", () => {
    const record = historyRecord({
      provider: "codex",
      agentRuns: [agentRun({ costUsd: null, costBasis: null })],
    });
    expect(unitCost(record)).toEqual({ kind: "none", why: "codex reports tokens but no cost." });
  });

  test("no agent run is no cost, said so", () => {
    expect(unitCost(historyRecord({ agentRuns: [] }))).toEqual({
      kind: "none",
      why: "No agent ran for this unit.",
    });
  });

  test("a figure under a cent never reads as nothing", () => {
    expect(usd(0.004)).toBe("<$0.01");
    expect(usd(0)).toBe("$0.00");
    expect(usd(12.345)).toBe("$12.35");
  });
});

describe("one unit", () => {
  test("tokens sum across runs, and a partial run marks the unit partial", () => {
    const record = historyRecord({
      agentRuns: [
        agentRun({ inputTokens: 100, outputTokens: null }),
        agentRun({ inputTokens: 50, outputTokens: null, usageComplete: false }),
      ],
    });
    expect(unitTokens(record)).toMatchObject({ input: 150, output: null, partial: true });
  });

  test("links to its PR when it has one, else to what its id names", () => {
    expect(githubHref(historyRecord())).toBe(
      "https://github.com/JesusFilm/youtube-studio/issues/88",
    );
    expect(githubHref(historyRecord({ unit: { kind: "reviews", id: "pr:21" } }))).toBe(
      "https://github.com/JesusFilm/youtube-studio/pull/21",
    );
    expect(githubHref(historyRecord({ prNumber: 90 }))).toBe(
      "https://github.com/JesusFilm/youtube-studio/pull/90",
    );
    expect(githubHref(historyRecord({ unit: { kind: "issues", id: "931" } }))).toBe(
      "https://github.com/JesusFilm/youtube-studio/issues/931",
    );
    expect(githubHref(historyRecord({ unit: { kind: "sweep", id: "nightly" } }))).toBeNull();
  });

  test("reads as a person names it", () => {
    expect(unitLabel(historyRecord())).toBe("issue #88");
    expect(unitLabel(historyRecord({ unit: { kind: "checks", id: "pr:21" } }))).toBe("PR #21");
    expect(unitLabel(historyRecord({ unit: { kind: "sweep", id: "nightly" } }))).toBe("nightly");
  });

  test("history reaches back to the oldest record any cell holds", () => {
    expect(
      retainedSince({
        retained: { a: "2026-09-10T00:00:00.000Z", b: null, c: "2026-09-01T00:00:00.000Z" },
      }),
    ).toBe("2026-09-01T00:00:00.000Z");
    expect(retainedSince({ retained: { a: null } })).toBeNull();
  });
});

describe("a summed cost (#932)", () => {
  const summed = (api: number, subscriptionEstimate: number, units = 3, unitsWithoutCost = 0) => ({
    units,
    unitsWithoutCost,
    costUsd: { api, subscriptionEstimate },
  });

  test("reads by basis, and leaves out a basis with nothing on it", () => {
    expect(summaryCost(summed(1.25, 0))).toEqual({ kind: "cost", api: 1.25, estimate: null });
    expect(summaryCost(summed(0, 3))).toEqual({ kind: "cost", api: null, estimate: 3 });
    expect(summaryCost(summed(1, 2))).toEqual({ kind: "cost", api: 1, estimate: 2 });
  });

  test("units that reported no cost read as tokens only, and no units as nothing", () => {
    expect(summaryCost(summed(0, 0, 3, 3))).toEqual({ kind: "tokens-only" });
    expect(summaryCost(summed(0, 0, 3, 0))).toEqual({ kind: "cost", api: 0, estimate: null });
    expect(summaryCost(summed(0, 0, 0))).toEqual({ kind: "no-units" });
  });

  test("did not complete counts unproductive, failed, timed out and abandoned", () => {
    expect(
      unfinishedOf({ completed: 9, unproductive: 4, failed: 1, "timed-out": 2, abandoned: 3 }),
    ).toBe(10);
  });
});

describe("the units that need a look (#932)", () => {
  const SINCE = "2026-09-11T12:00:00.000Z";

  test("asks once per outcome that did not complete, and keeps the newest six of all four", async () => {
    const asked: HistoryQuery[] = [];
    const at = (hours: number) => new Date(Date.UTC(2026, 8, 18, 12 - hours)).toISOString();
    const of = (outcome: UnitRecordOutcome, hours: number[]) =>
      hours.map((h) =>
        historyRecord({ outcome, startedAt: at(h), unit: { kind: "issues", id: `issue:${h}` } }),
      );
    const pages: Record<string, HistoryRecord[]> = {
      unproductive: of("unproductive", [6]),
      failed: of("failed", [1, 4, 7, 8, 9, 10]),
      "timed-out": of("timed-out", [2, 5]),
      abandoned: of("abandoned", [3]),
    };
    const read: HistoryReader = (query) => {
      asked.push(query);
      const records = pages[query.outcome!]!;
      return Promise.resolve({
        kind: "page",
        page: historyPage(records, {
          summary: { ...historyPage(records).summary, units: records.length + 1 },
        }),
      });
    };

    const fetched = await readNeedsALook(read, SINCE);

    expect(asked).toEqual([
      { outcome: "unproductive", since: SINCE, limit: 6 },
      { outcome: "failed", since: SINCE, limit: 6 },
      { outcome: "timed-out", since: SINCE, limit: 6 },
      { outcome: "abandoned", since: SINCE, limit: 6 },
    ]);
    expect(fetched.kind).toBe("units");
    if (fetched.kind !== "units") return;
    expect(fetched.records.map((record) => record.unit.id)).toEqual([
      "issue:1",
      "issue:2",
      "issue:3",
      "issue:4",
      "issue:5",
      "issue:6",
    ]);
    expect(fetched.total).toBe(14);
  });

  test("a deployment too old for one read is too old for the feed", async () => {
    const read: HistoryReader = (query) =>
      Promise.resolve(
        query.outcome === "abandoned"
          ? { kind: "too-old" }
          : { kind: "page", page: historyPage([]) },
      );
    expect(await readNeedsALook(read, SINCE)).toEqual({ kind: "too-old" });
  });
});
