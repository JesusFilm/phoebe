// The fleet's unit history as the stats button and page add it up (#933):
// which deployments count, what a too-old one reads as, cost kept apart by
// basis, and the records read on demand for what a summary cannot answer.

import type { HistoryQuery, HistoryWindow } from "phoebe-agent/contracts";
import { describe, expect, test } from "vite-plus/test";
import {
  byModel,
  didNotComplete,
  fleetTotals,
  leftOutNote,
  priciest,
  readWindow,
  statsDeployments,
  unitsPerDay,
  type StatsDeployment,
} from "./fleet-stats.ts";
import type { HistoryFetch } from "./history.ts";
import {
  agentRun,
  ago,
  historyPage,
  historyRecord,
  install,
  localReport,
  NOW,
  remote,
  report,
  stored,
} from "./test-fixture.ts";

function window(overrides: Partial<HistoryWindow> = {}): HistoryWindow {
  return {
    units: 10,
    outcomes: { completed: 7, unproductive: 0, failed: 1, "timed-out": 1, abandoned: 1 },
    quarantined: 0,
    costUsd: { api: 2.5, subscriptionEstimate: 4 },
    unitsWithoutCost: 1,
    unitsWithPartialUsage: 2,
    tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function summary(day: HistoryWindow, week: HistoryWindow) {
  return { asOf: ago(60), last24h: day, last7d: week };
}

const OLD_ENGINE = report();
const NEW_ENGINE = report({
  fleet: { ...report().fleet, history: summary(window({ units: 2 }), window()) },
});

describe("statsDeployments", () => {
  test("a report with a summary counts; one without is too old; no report is unknown", () => {
    const fresh = install({ dir: "/repos/a", name: "a" });
    const old = install({ dir: "/repos/b", name: "b" });
    const stopped = install({ dir: "/repos/c", name: "c", state: "stopped" });
    const listed = statsDeployments(
      [fresh, old, stopped],
      {
        "/repos/a": localReport({ facts: fresh, report: stored(NEW_ENGINE) }),
        "/repos/b": localReport({ facts: old, report: stored(OLD_ENGINE) }),
        "/repos/c": localReport({ facts: stopped, reason: "the container is stopped" }),
      },
      [],
    );
    expect(listed.map((deployment) => [deployment.name, deployment.history.kind])).toEqual([
      ["a", "summary"],
      ["b", "too-old"],
      ["c", "unknown"],
    ]);
    expect(listed[0]!.where).toBe("this machine");
    expect(listed[2]!.history).toEqual({ kind: "unknown", why: "the container is stopped" });
  });

  test("a paired deployment reads its last report, and one joined to a folder here is listed once", () => {
    const paired = remote({
      deploymentId: "dep_P",
      name: "partner",
      lastReport: stored(NEW_ENGINE),
    });
    const joined = remote({ deploymentId: "dep_J", name: "joined" });
    const listed = statsDeployments([], {}, [paired, joined], { dep_J: install() });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      key: "remote:dep_P",
      name: "partner",
      where: "youtube-studio.tail4f2c.ts.net",
      arm: { kind: "remote", deploymentId: "dep_P" },
      history: { kind: "summary" },
    });
  });
});

function deployment(name: string, history: StatsDeployment["history"]): StatsDeployment {
  return {
    key: `local:/repos/${name}`,
    name,
    where: "this machine",
    arm: { kind: "local", dir: `/repos/${name}` },
    history,
  };
}

describe("fleetTotals", () => {
  const counted = (day: HistoryWindow, week: HistoryWindow): StatsDeployment["history"] => ({
    kind: "summary",
    windows: { last24h: day, last7d: week },
    asOf: ago(60),
  });

  test("adds the reporting deployments up and keeps API spend apart from the estimate", () => {
    const totals = fleetTotals(
      [
        deployment("a", counted(window({ units: 1 }), window())),
        deployment(
          "b",
          counted(window({ units: 3 }), window({ costUsd: { api: 1, subscriptionEstimate: 0.5 } })),
        ),
      ],
      "last7d",
    );
    expect(totals.counted).toBe(2);
    expect(totals.window.units).toBe(20);
    expect(totals.window.costUsd).toEqual({ api: 3.5, subscriptionEstimate: 4.5 });
    expect(didNotComplete(totals.window)).toBe(6);
    expect(
      fleetTotals([deployment("a", counted(window({ units: 1 }), window()))], "last24h").window
        .units,
    ).toBe(1);
  });

  test("a deployment too old to report history is left out, not counted as zero", () => {
    const totals = fleetTotals(
      [
        deployment("a", counted(window(), window())),
        deployment("old", { kind: "too-old" }),
        deployment("dark", { kind: "unknown", why: "nothing heard from it yet" }),
      ],
      "last7d",
    );
    expect(totals).toMatchObject({ counted: 1, tooOld: 1, unknown: 1 });
    expect(totals.window.units).toBe(10);
    expect(leftOutNote({ kind: "too-old" })).toBe("too old to report history, so not counted");
    expect(leftOutNote({ kind: "unknown", why: "nothing heard from it yet" })).toBe(
      "not counted: nothing heard from it yet",
    );
  });
});

describe("readWindow", () => {
  test("reads page after page from the window's start until the last page", async () => {
    const asked: HistoryQuery[] = [];
    const pages: HistoryFetch[] = [
      { kind: "page", page: historyPage([historyRecord()], { nextBefore: "cursor-1" }) },
      { kind: "page", page: historyPage([historyRecord({ startedAt: ago(9000) })]) },
    ];
    const read = await readWindow((query) => {
      asked.push(query);
      return Promise.resolve(pages[asked.length - 1]!);
    }, ago(86_400));
    expect(asked).toEqual([
      { since: ago(86_400), limit: 200 },
      { since: ago(86_400), limit: 200, before: "cursor-1" },
    ]);
    expect(read).toMatchObject({ kind: "records", capped: false });
    expect(read.kind === "records" ? read.records : []).toHaveLength(2);
  });

  test("stops at the cap and says so", async () => {
    const asked: HistoryQuery[] = [];
    const read = await readWindow(
      (query) => {
        asked.push(query);
        return Promise.resolve({
          kind: "page",
          page: historyPage([historyRecord(), historyRecord()], { nextBefore: "more" }),
        });
      },
      ago(86_400),
      3,
    );
    expect(asked.map((query) => query.limit)).toEqual([3, 1]);
    expect(read).toMatchObject({ kind: "records", capped: true });
  });

  test("a deployment that cannot serve history reads as too old", async () => {
    expect(await readWindow(() => Promise.resolve({ kind: "too-old" }), ago(60))).toEqual({
      kind: "too-old",
    });
  });
});

describe("the records", () => {
  const api = (usd: number, id: string) =>
    historyRecord({ unit: { kind: "issues", id }, agentRuns: [agentRun({ costUsd: usd })] });
  const estimate = (usd: number, id: string) =>
    historyRecord({
      unit: { kind: "issues", id },
      model: "claude-sonnet-5-5",
      agentRuns: [agentRun({ costUsd: usd, costBasis: "subscription-estimate" })],
    });
  const uncosted = historyRecord({
    unit: { kind: "issues", id: "issue:1" },
    provider: "codex",
    model: "gpt-5",
    outcome: "failed",
    agentRuns: [agentRun({ costUsd: null, costBasis: null })],
  });

  test("the most expensive five, largest first, leaving out units with no cost", () => {
    const records = [
      api(0.5, "issue:2"),
      estimate(3, "issue:3"),
      uncosted,
      api(1, "issue:4"),
      api(2, "issue:5"),
      api(0.1, "issue:6"),
      api(0.2, "issue:7"),
    ];
    expect(priciest(records).map((record) => record.unit.id)).toEqual([
      "issue:3",
      "issue:5",
      "issue:4",
      "issue:2",
      "issue:7",
    ]);
  });

  test("by model: units, the ones that did not complete, and cost by basis", () => {
    const rows = byModel([api(1, "issue:2"), api(2, "issue:3"), estimate(3, "issue:4"), uncosted]);
    expect(rows).toEqual([
      {
        model: "claude-opus-5-5",
        units: 2,
        didNotComplete: 0,
        api: 3,
        estimate: 0,
        withoutCost: 0,
        input: 24_600,
        output: 9_000,
      },
      {
        model: "claude-sonnet-5-5",
        units: 1,
        didNotComplete: 0,
        api: 0,
        estimate: 3,
        withoutCost: 0,
        input: 12_300,
        output: 4_500,
      },
      {
        model: "gpt-5",
        units: 1,
        didNotComplete: 1,
        api: 0,
        estimate: 0,
        withoutCost: 1,
        input: 12_300,
        output: 4_500,
      },
    ]);
  });

  test("units per day: seven local days, today last, split by whether they completed", () => {
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    const at = (daysBack: number, hours: number): string =>
      new Date(today.getTime() - daysBack * 86_400_000 + hours * 3_600_000).toISOString();
    const days = unitsPerDay(
      [
        historyRecord({ startedAt: at(0, 1) }),
        historyRecord({ startedAt: at(0, 2), outcome: "failed" }),
        historyRecord({ startedAt: at(6, 1) }),
        historyRecord({ startedAt: at(9, 1) }),
      ],
      NOW,
    );
    expect(days).toHaveLength(7);
    expect(days[6]).toMatchObject({ completed: 1, didNotComplete: 1 });
    expect(days[0]).toMatchObject({ completed: 1, didNotComplete: 0 });
    expect(days.slice(1, 6).every((day) => day.completed + day.didNotComplete === 0)).toBe(true);
  });
});
