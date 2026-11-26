// The history read (#930): one query over the unit history files, tested
// against real files in a temporary state directory — order, filters, paging,
// the limit's cap, how far back a rotated history reaches, and the lines a
// reader skips.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DeploymentReport, FleetCell } from "./contracts/deployment.ts";
import type { AgentRunRecord, UnitRecord } from "./contracts/unit-record.ts";
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  historySourcesOf,
  parseHistoryQuery,
  queryHistory,
  summarizeHistory,
  type HistorySource,
} from "./history.ts";
import { UNITS_FILE, UNITS_ROTATED_FILE } from "./unit-record.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-20T00:00:00.000Z");
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function agentRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    startedAt: at(0),
    durationMs: 60_000,
    exitCode: 0,
    promptSha: "a".repeat(64),
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 1000,
    cacheWriteTokens: 50,
    reasoningTokens: null,
    costUsd: 0.5,
    turns: 3,
    providerDurationMs: 55_000,
    stopReason: "end_turn",
    reportedModels: ["claude-opus-5-5"],
    usageComplete: true,
    toolCalls: { Bash: 2 },
    costBasis: "api",
    ...overrides,
  };
}

function unitRecord(overrides: Partial<UnitRecord> = {}): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issues", id: "1" },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: at(0),
    settledAt: at(10),
    durationMs: 600_000,
    runBudgetMs: 3_600_000,
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    branch: "phoebe/issue-1",
    headSha: "abc1234",
    prNumber: 2,
    engineCommit: null,
    agentRuns: [agentRun()],
    ...overrides,
  };
}

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-history-"));
  dirs.push(dir);
  return dir;
}

/** Write one cell's history: `current` to `units.jsonl`, `rotated` to `units.1.jsonl`. */
function cell(
  base: string,
  name: string,
  current: readonly (UnitRecord | string)[],
  rotated: readonly (UnitRecord | string)[] = [],
): HistorySource {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const text = (lines: readonly (UnitRecord | string)[]): string =>
    lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join("");
  if (current.length > 0) writeFileSync(join(dir, UNITS_FILE), text(current));
  if (rotated.length > 0) writeFileSync(join(dir, UNITS_ROTATED_FILE), text(rotated));
  return { cell: `/etc/phoebe#${name}`, dir };
}

const ids = (page: { records: { unit: { id: string } }[] }): string[] =>
  page.records.map((record) => record.unit.id);

describe("queryHistory", () => {
  test("lists records newest first by startedAt, across files and cells, each tagged with its cell", () => {
    const base = stateDir();
    const work = cell(
      base,
      "work",
      [unitRecord({ unit: { kind: "issues", id: "3" }, startedAt: at(30) })],
      [unitRecord({ unit: { kind: "issues", id: "1" }, startedAt: at(10) })],
    );
    const intake = cell(base, "intake", [
      unitRecord({ pipeline: "intake", unit: { kind: "triage", id: "2" }, startedAt: at(20) }),
    ]);
    const page = queryHistory([work, intake], {});
    expect(ids(page)).toEqual(["3", "2", "1"]);
    expect(page.records.map((record) => record.cell)).toEqual([
      "/etc/phoebe#work",
      "/etc/phoebe#intake",
      "/etc/phoebe#work",
    ]);
    expect(page.nextBefore).toBeNull();
  });

  test("every filter narrows, and they combine with AND", () => {
    const base = stateDir();
    const work = cell(base, "work", [
      unitRecord({ unit: { kind: "issues", id: "1" }, startedAt: at(1) }),
      unitRecord({ unit: { kind: "reviews", id: "2" }, startedAt: at(2) }),
      unitRecord({ unit: { kind: "issues", id: "3" }, startedAt: at(3), outcome: "failed" }),
      unitRecord({
        unit: { kind: "issues", id: "4" },
        startedAt: at(4),
        provider: "codex",
        model: "gpt-5",
      }),
    ]);
    const intake = cell(base, "intake", [
      unitRecord({ unit: { kind: "issues", id: "5" }, startedAt: at(5) }),
    ]);
    const sources = [work, intake];
    expect(ids(queryHistory(sources, { cell: work.cell }))).toEqual(["4", "3", "2", "1"]);
    expect(ids(queryHistory(sources, { kind: "reviews" }))).toEqual(["2"]);
    expect(ids(queryHistory(sources, { outcome: "failed" }))).toEqual(["3"]);
    expect(ids(queryHistory(sources, { provider: "codex" }))).toEqual(["4"]);
    expect(ids(queryHistory(sources, { model: "gpt-5" }))).toEqual(["4"]);
    expect(ids(queryHistory(sources, { since: at(3) }))).toEqual(["5", "4", "3"]);
    expect(
      ids(queryHistory(sources, { cell: work.cell, kind: "issues", provider: "claude" })),
    ).toEqual(["3", "1"]);
  });

  test("pages with the before cursor, and the summary covers the whole match on every page", () => {
    const base = stateDir();
    const records = Array.from({ length: 5 }, (_, i) =>
      unitRecord({ unit: { kind: "issues", id: String(i + 1) }, startedAt: at(i) }),
    );
    // Two units that started in the same millisecond still have an order.
    records.push(unitRecord({ unit: { kind: "reviews", id: "9" }, startedAt: at(2) }));
    const sources = [cell(base, "work", records)];

    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = queryHistory(sources, { limit: 2, ...(before !== undefined ? { before } : {}) });
      expect(page.summary.units).toBe(6);
      seen.push(...ids(page));
      before = page.nextBefore ?? undefined;
      pages += 1;
    } while (before !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(["5", "4", "9", "3", "2", "1"]);
  });

  test("records that share a start, kind and id in two cells both appear across pages", () => {
    const base = stateDir();
    const same = unitRecord({ unit: { kind: "issues", id: "1" }, startedAt: at(1) });
    const sources = [cell(base, "a", [same]), cell(base, "b", [same])];
    let before: string | undefined;
    let seen = 0;
    do {
      const page = queryHistory(sources, { limit: 1, ...(before !== undefined ? { before } : {}) });
      seen += page.records.length;
      before = page.nextBefore ?? undefined;
    } while (before !== undefined);
    expect(seen).toBe(2);
  });

  test("a record with a null agent run is skipped and its neighbour still reads", () => {
    const base = stateDir();
    const bad = JSON.stringify({ ...unitRecord({ startedAt: at(1) }), agentRuns: [null] });
    const sources = [
      cell(base, "work", [
        bad,
        unitRecord({ unit: { kind: "issues", id: "2" }, startedAt: at(2) }),
      ]),
    ];
    expect(ids(queryHistory(sources, {}))).toEqual(["2"]);
  });

  test("a bare timestamp as before means strictly earlier", () => {
    const base = stateDir();
    const sources = [
      cell(base, "work", [
        unitRecord({ unit: { kind: "issues", id: "1" }, startedAt: at(1) }),
        unitRecord({ unit: { kind: "issues", id: "2" }, startedAt: at(2) }),
      ]),
    ];
    expect(ids(queryHistory(sources, parseHistoryQuery({ before: at(2) })))).toEqual(["1"]);
  });

  test("the limit defaults to 50 and a larger one is clamped to 200", () => {
    const base = stateDir();
    const records = Array.from({ length: 250 }, (_, i) =>
      unitRecord({ unit: { kind: "issues", id: String(i) }, startedAt: at(i) }),
    );
    const sources = [cell(base, "work", records)];
    expect(queryHistory(sources, {}).records).toHaveLength(HISTORY_DEFAULT_LIMIT);
    const page = queryHistory(sources, { limit: 1000 });
    expect(page.records).toHaveLength(HISTORY_MAX_LIMIT);
    expect(page.nextBefore).not.toBeNull();
  });

  test("retained is the oldest record each matched cell still holds, rotated file included", () => {
    const base = stateDir();
    const work = cell(
      base,
      "work",
      [unitRecord({ startedAt: at(50) })],
      [unitRecord({ startedAt: at(40) }), unitRecord({ startedAt: at(5) })],
    );
    const empty = cell(base, "intake", []);
    const page = queryHistory([work, empty], { outcome: "failed" });
    expect(page.records).toEqual([]);
    expect(page.retained).toEqual({ [work.cell]: at(5), [empty.cell]: null });
    expect(queryHistory([work, empty], { cell: work.cell }).retained).toEqual({
      [work.cell]: at(5),
    });
  });

  test("a line with an unknown v, a torn line and junk are skipped, not fatal", () => {
    const base = stateDir();
    const sources = [
      cell(base, "work", [
        unitRecord({ unit: { kind: "issues", id: "1" }, startedAt: at(1) }),
        JSON.stringify({ ...unitRecord({ startedAt: at(0) }), v: 2 }),
        "not json",
        "[]",
        '{"v":1,"tenant":"acme/widget","pipe',
      ]),
    ];
    const page = queryHistory(sources, {});
    expect(ids(page)).toEqual(["1"]);
    expect(page.retained).toEqual({ [sources[0]!.cell]: at(1) });
  });

  test("a cell with no history files is an empty one", () => {
    const page = queryHistory([{ cell: "x#work", dir: join(stateDir(), "missing") }], {});
    expect(page).toEqual({
      records: [],
      summary: summarizeHistory([]),
      nextBefore: null,
      retained: { "x#work": null },
    });
  });
});

describe("summarizeHistory", () => {
  test("counts outcomes, keeps API spend and estimates apart, and counts units without cost or with partial usage", () => {
    const totals = summarizeHistory([
      unitRecord({ agentRuns: [agentRun({ costUsd: 1.25 }), agentRun({ costUsd: 0.25 })] }),
      unitRecord({
        outcome: "timed-out",
        quarantined: true,
        agentRuns: [
          agentRun({ costUsd: 2, costBasis: "subscription-estimate", usageComplete: false }),
        ],
      }),
      unitRecord({
        outcome: "failed",
        agentRuns: [agentRun({ costUsd: null, costBasis: null, inputTokens: null })],
      }),
      unitRecord({
        outcome: "abandoned",
        settledAt: null,
        durationMs: null,
        agentRuns: [],
      }),
    ]);
    expect(totals).toEqual({
      units: 4,
      byOutcome: { completed: 1, failed: 1, "timed-out": 1, abandoned: 1 },
      quarantined: 1,
      costUsd: { api: 1.5, subscriptionEstimate: 2 },
      unitsWithoutCost: 2,
      unitsWithPartialUsage: 1,
      tokens: { input: 300, output: 80, cacheRead: 4000, cacheWrite: 200 },
    });
  });
});

describe("parseHistoryQuery", () => {
  test("puts timestamps in ISO form, reads the limit, and treats an empty field as absent", () => {
    expect(
      parseHistoryQuery({
        cell: "/etc/phoebe#work",
        kind: "issues",
        outcome: "failed",
        provider: "claude",
        model: "",
        since: "2026-11-20",
        before: "2026-11-21T00:00:00Z~issues~4",
        limit: "500",
      }),
    ).toEqual({
      cell: "/etc/phoebe#work",
      kind: "issues",
      outcome: "failed",
      provider: "claude",
      since: "2026-11-20T00:00:00.000Z",
      before: "2026-11-21T00:00:00.000Z~issues~4",
      limit: 500,
    });
  });

  test("refuses an unknown outcome, a date that will not parse, and a limit that is not a positive integer", () => {
    expect(() => parseHistoryQuery({ outcome: "skipped" })).toThrow(/outcome/);
    expect(() => parseHistoryQuery({ since: "last tuesday" })).toThrow(/since/);
    expect(() => parseHistoryQuery({ before: "soon~issues~1" })).toThrow(/before/);
    expect(() => parseHistoryQuery({ limit: "0" })).toThrow(/limit/);
    expect(() => parseHistoryQuery({ limit: "ten" })).toThrow(/limit/);
  });
});

describe("historySourcesOf", () => {
  test("one source per cell with a slug, at the pipeline's dir under the tenant's state", () => {
    const cellOf = (id: string, slug: string | null, pipeline: string): FleetCell =>
      ({ id, pipeline, tenant: { slug } }) as unknown as FleetCell;
    const report = {
      fleet: {
        cells: [
          cellOf("/etc/phoebe#work", "acme/widget", "work"),
          cellOf("/etc/phoebe/held#work", null, "work"),
        ],
      },
    } as unknown as DeploymentReport;
    expect(historySourcesOf(report, "/data")).toEqual([
      { cell: "/etc/phoebe#work", dir: join("/data", "acme/widget", "state", "work") },
    ]);
    expect(historySourcesOf(null, "/data")).toEqual([]);
  });
});
