// `phoebe history` (#930): a thin verb over queryHistory. The in-container arm
// against a real data volume in a temporary directory, the text view's cost and
// footer, the flags, and the host arm's exec through an injected runner.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { deploymentReportPath } from "../bootstrap/deployment-report.ts";
import type { DeploymentReport, FleetCell } from "./contracts/deployment.ts";
import type { HistoryPage } from "./contracts/history.ts";
import { HISTORY_CSV_COLUMNS } from "./contracts/history-export.mjs";
import type { AgentRunRecord, UnitRecord } from "./contracts/unit-record.ts";
import type { CommandResult, CommandRunner } from "./deployment-compose.ts";
import {
  formatHistoryPage,
  historyExecArgv,
  parseHistoryArgs,
  runHistoryCli,
} from "./history-command.ts";
import { historySourcesOf, parseHistoryQuery, queryHistory, summarizeHistory } from "./history.ts";
import { unitsPathFor } from "./unit-record.ts";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const hoursAgo = (n: number): string => new Date(NOW - n * 3_600_000).toISOString();

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    startedAt: hoursAgo(1),
    durationMs: 60_000,
    exitCode: 0,
    promptSha: "a".repeat(64),
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    costUsd: 0.42,
    turns: 3,
    providerDurationMs: null,
    stopReason: null,
    reportedModels: [],
    usageComplete: true,
    toolCalls: {},
    costBasis: "api",
    ...overrides,
  };
}

function record(overrides: Partial<UnitRecord> = {}): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issues", id: "1" },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: hoursAgo(1),
    settledAt: hoursAgo(0.5),
    durationMs: 1_800_000,
    runBudgetMs: null,
    provider: "claude",
    model: "claude-opus-5-5",
    effort: null,
    branch: null,
    headSha: null,
    prNumber: null,
    engineCommit: null,
    agentRuns: [run()],
    ...overrides,
  };
}

function cellOf(slug: string, pipeline: string): FleetCell {
  return {
    id: `/etc/phoebe/${slug}#${pipeline}`,
    pipeline,
    tenant: { id: `/etc/phoebe/${slug}`, slug, path: `/etc/phoebe/${slug}` },
  } as unknown as FleetCell;
}

let base: string;
let report: DeploymentReport;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "phoebe-history-cli-"));
  report = {
    fleet: { cells: [cellOf("acme/widget", "work"), cellOf("acme/gadget", "work")] },
  } as unknown as DeploymentReport;
  mkdirSync(join(base, "state"), { recursive: true });
  writeFileSync(deploymentReportPath(base), JSON.stringify(report));
  const write = (slug: string, records: UnitRecord[]): void => {
    const path = unitsPathFor(join(base, slug, "state"), "work");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, records.map((line) => `${JSON.stringify(line)}\n`).join(""));
  };
  write("acme/widget", [
    record({ unit: { kind: "issues", id: "1" }, startedAt: hoursAgo(3) }),
    record({
      unit: { kind: "reviews", id: "2" },
      startedAt: hoursAgo(2),
      outcome: "failed",
      agentRuns: [run({ costUsd: 1.5, costBasis: "subscription-estimate" })],
    }),
  ]);
  write("acme/gadget", [
    record({
      tenant: "acme/gadget",
      unit: { kind: "issues", id: "7" },
      startedAt: hoursAgo(1),
      provider: "codex",
      model: "gpt-5",
      agentRuns: [run({ costUsd: null, costBasis: null, outputTokens: null })],
    }),
  ]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  process.exitCode = 0;
});

async function inContainer(
  argv: string[],
  seen?: { stderr: string[]; reads: string[] },
): Promise<string> {
  const out: string[] = [];
  await runHistoryCli(argv, {
    inContainer: true,
    env: { PHOEBE_DATA_DIR: base },
    now: NOW,
    ...(seen !== undefined
      ? {
          read: (path: string) => {
            seen.reads.push(path);
            return readFileSync(path, "utf8");
          },
        }
      : {}),
    io: { stdout: (text) => out.push(text), stderr: (line) => seen?.stderr.push(line) },
  });
  return out.join("");
}

describe("the in-container arm", () => {
  test("--json prints the HistoryPage the query builds for the same filters", async () => {
    const printed = JSON.parse(await inContainer(["--json", "--kind", "issues"])) as HistoryPage;
    expect(printed).toEqual(
      queryHistory(historySourcesOf(report, base), parseHistoryQuery({ kind: "issues" })),
    );
    expect(printed.records.map((line) => line.unit.id)).toEqual(["7", "1"]);
  });

  test("--tenant and --pipeline narrow to the cells they name; a cell the deployment lacks is an error", async () => {
    const page = JSON.parse(
      await inContainer(["--json", "--tenant", "acme/widget", "--pipeline=work"]),
    ) as HistoryPage;
    expect(page.records.map((line) => line.unit.id)).toEqual(["2", "1"]);
    expect(Object.keys(page.retained)).toEqual(["/etc/phoebe/acme/widget#work"]);
    await expect(inContainer(["--tenant", "acme/nothing"])).rejects.toThrow(
      /no cell for tenant acme\/nothing/,
    );
  });

  test("--limit and --before page through the records", async () => {
    const first = JSON.parse(await inContainer(["--json", "--limit", "2"])) as HistoryPage;
    expect(first.records.map((line) => line.unit.id)).toEqual(["7", "2"]);
    const second = JSON.parse(
      await inContainer(["--json", "--limit", "2", "--before", first.nextBefore!]),
    ) as HistoryPage;
    expect(second.records.map((line) => line.unit.id)).toEqual(["1"]);
    expect(second.nextBefore).toBeNull();
  });

  test("the text view lists newest first, marks estimates, dashes a missing cost, and says how far back it reaches", async () => {
    const text = await inContainer([]);
    const rows = text.split("\n");
    expect(rows[0]).toMatch(
      /^age\s+pipeline\s+unit\s+outcome\s+model\s+took\s+cost\s+tokens in\/out$/,
    );
    expect(rows[1]).toMatch(
      /^1h ago\s+acme\/gadget work\s+issues #7\s+completed\s+gpt-5\s+30m\s+—\s+1\.2k\/—$/,
    );
    expect(rows[2]).toMatch(
      /reviews #2\s+failed\s+claude-opus-5-5\s+30m\s+\$1\.50 est\.\s+1\.2k\/300$/,
    );
    expect(rows[3]).toMatch(
      /issues #1\s+completed\s+claude-opus-5-5\s+30m\s+\$0\.42\s+1\.2k\/300$/,
    );
    expect(text).toContain(
      "[phoebe] matched   3 units, 2 completed, 1 failed  $0.42 api + $1.50 est.  (1 without cost)",
    );
    expect(text).toContain(
      `[phoebe] retained  /etc/phoebe/acme/widget#work  since ${hoursAgo(3)} (3h ago)`,
    );
    expect(text).not.toContain("--before");
  });

  describe("--export", () => {
    /** A cell with more units than three pages hold, every other one failed. */
    function manyUnits(): void {
      const records = Array.from({ length: 450 }, (_, i) =>
        record({
          unit: { kind: "issues", id: String(1000 + i) },
          startedAt: new Date(NOW - (i + 10) * 60_000).toISOString(),
          outcome: i % 2 === 0 ? "completed" : "failed",
        }),
      );
      const path = unitsPathFor(join(base, "acme/widget", "state"), "work");
      writeFileSync(path, records.map((line) => `${JSON.stringify(line)}\n`).join(""));
    }

    test("csv walks every page and writes each unit the filters match, once", async () => {
      manyUnits();
      const seen = { stderr: [] as string[], reads: [] as string[] };
      const text = await inContainer(
        ["--export", "csv", "--tenant", "acme/widget", "--outcome=completed"],
        seen,
      );
      const lines = text.trimEnd().split("\n");
      expect(lines[0]).toBe(HISTORY_CSV_COLUMNS.join(","));
      const rows = lines.slice(1).map((line) => line.split(","));
      expect(rows).toHaveLength(225);
      expect(new Set(rows.map((row) => row[2])).size).toBe(225);
      expect(rows.every((row) => row[3] === "completed")).toBe(true);
      expect(rows.every((row) => row[0] === "/etc/phoebe/acme/widget#work")).toBe(true);
      // Newest first, the same order the pages hold.
      expect(rows[0]![2]).toBe("1000");
      expect(rows.at(-1)![2]).toBe("1448");
      // Two pages of at most 200, so the files were read once per page.
      const unitsReads = seen.reads.filter((path) => path.endsWith("units.jsonl"));
      expect(unitsReads.length).toBe(2);
      expect(seen.stderr).toEqual(["[phoebe] exported 225 units."]);
    });

    test("jsonl writes one full record per line, across pages, and starts from --before", async () => {
      manyUnits();
      const all = (await inContainer(["--export=jsonl", "--tenant", "acme/widget"]))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryPage["records"][number]);
      const cell = "/etc/phoebe/acme/widget#work";
      const firstPage = queryHistory(historySourcesOf(report, base), { cell, limit: 100 });
      expect(all).toHaveLength(450);
      expect(all.slice(0, 100)).toEqual(firstPage.records);
      const cursor = firstPage.nextBefore!;
      const rest = (
        await inContainer(["--export=jsonl", "--tenant", "acme/widget", "--before", cursor])
      )
        .trimEnd()
        .split("\n");
      expect(rest).toHaveLength(350);
    });

    test("an export nothing matches is the CSV header alone", async () => {
      const seen = { stderr: [] as string[], reads: [] as string[] };
      expect(await inContainer(["--export", "csv", "--kind", "nothing"], seen)).toBe(
        `${HISTORY_CSV_COLUMNS.join(",")}\n`,
      );
      expect(seen.stderr).toEqual(["[phoebe] exported 0 units."]);
    });
  });

  test("no deployment report is an error that says why", async () => {
    rmSync(deploymentReportPath(base));
    await expect(inContainer([])).rejects.toThrow(/No deployment report/);
  });
});

describe("the flags", () => {
  test("every filter, --limit and --before land in the query", () => {
    const parsed = parseHistoryArgs([
      "--cell",
      "/etc/phoebe#work",
      "--kind=issues",
      "--outcome",
      "failed",
      "--provider",
      "claude",
      "--model",
      "claude-opus-5-5",
      "--since",
      "2026-11-01",
      "--before",
      "2026-11-20T00:00:00.000Z~issues~3",
      "--limit",
      "500",
      "--json",
    ]);
    expect(parsed.json).toBe(true);
    expect(parseHistoryQuery(parsed.query)).toEqual({
      cell: "/etc/phoebe#work",
      kind: "issues",
      outcome: "failed",
      provider: "claude",
      model: "claude-opus-5-5",
      since: "2026-11-01T00:00:00.000Z",
      before: "2026-11-20T00:00:00.000Z~issues~3",
      limit: 500,
    });
  });

  test("refuses an unknown flag, a bad filter value, and --cell with --tenant", () => {
    expect(() => parseHistoryArgs(["--verbose"])).toThrow(/Unknown flag `--verbose`/);
    expect(() => parseHistoryArgs(["--outcome", "skipped"])).toThrow(/outcome/);
    expect(() => parseHistoryArgs(["--limit"])).toThrow(/needs a value/);
    expect(() => parseHistoryArgs(["--cell", "x#work", "--tenant", "acme/widget"])).toThrow(
      /does not combine/,
    );
  });

  test("--export takes csv or jsonl, and neither --json nor --limit", () => {
    expect(parseHistoryArgs(["--export", "csv"]).export).toBe("csv");
    expect(parseHistoryArgs(["--export=jsonl"]).export).toBe("jsonl");
    expect(() => parseHistoryArgs(["--export", "xlsx"])).toThrow(/one of csv, jsonl/);
    expect(() => parseHistoryArgs(["--export"])).toThrow(/needs a value/);
    expect(() => parseHistoryArgs(["--export", "csv", "--json"])).toThrow(/pick one/);
    expect(() => parseHistoryArgs(["--export", "csv", "--limit", "5"])).toThrow(/no `--limit`/);
  });

  test("an unproductive unit shows its own count, never a completed one, and its quarantine (#985)", () => {
    const records = [
      { ...record({ outcome: "unproductive", quarantined: true }), cell: "/etc/phoebe#work" },
      { ...record({ unit: { kind: "issues", id: "2" } }), cell: "/etc/phoebe#work" },
    ];
    expect(parseHistoryQuery({ outcome: "unproductive" })).toEqual({ outcome: "unproductive" });
    const text = formatHistoryPage(
      {
        records,
        summary: summarizeHistory(records),
        nextBefore: null,
        retained: {},
      },
      NOW,
    );
    expect(text).toMatch(/issues #1\s+unproductive \(quarantined\)\s+claude-opus-5-5/);
    expect(text).toContain(
      "[phoebe] matched   2 units, 1 completed, 1 unproductive, 1 quarantined  $0.84 api",
    );
  });

  test("the footer offers the next page when there is one", () => {
    const text = formatHistoryPage(
      {
        records: [],
        summary: queryHistory([], {}).summary,
        nextBefore: "2026-11-20T00:00:00.000Z~issues~3",
        retained: {},
      },
      NOW,
    );
    expect(text).toContain("[phoebe] no units match.");
    expect(text).toContain("phoebe history --before 2026-11-20T00:00:00.000Z~issues~3");
  });
});

describe("the host arm", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phoebe-history-host-"));
    mkdirSync(join(root, "container"));
    writeFileSync(join(root, "container", "compose.yml"), "services: {}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("execs itself in the running container with the same flags, stdio passed through", async () => {
    const calls: Array<Parameters<CommandRunner>[0]> = [];
    const answers: CommandResult[] = [
      {
        code: 0,
        stdout: `${JSON.stringify({ Service: "phoebe", State: "running" })}\n`,
        stderr: "",
      },
      { code: 0, stdout: "", stderr: "" },
    ];
    const runner: CommandRunner = (spec) => {
      calls.push(spec);
      return Promise.resolve(answers.shift()!);
    };
    await runHistoryCli(["--tenant", "acme/widget", "--outcome", "failed", "--json"], {
      cwd: root,
      inContainer: false,
      dockerAvailable: true,
      runner,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.inheritStdio).toBe(true);
    expect(calls[1]!.args.slice(3)).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "history",
      "--tenant",
      "acme/widget",
      "--outcome=failed",
      "--json",
    ]);
  });

  test("a stopped container is reported before any exec", async () => {
    const runner: CommandRunner = () =>
      Promise.resolve({
        code: 0,
        stdout: `${JSON.stringify({ Service: "phoebe", State: "exited" })}\n`,
        stderr: "",
      });
    await expect(
      runHistoryCli([], { cwd: root, inContainer: false, dockerAvailable: true, runner }),
    ).rejects.toThrow(/container not running/);
  });

  test("the exec argv carries --export into the container", () => {
    expect(historyExecArgv(parseHistoryArgs(["--kind", "issues", "--export", "csv"]))).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "history",
      "--kind=issues",
      "--export=csv",
    ]);
  });

  test("the exec argv is rebuilt from the parsed flags", () => {
    expect(historyExecArgv(parseHistoryArgs(["--before=2026-11-20", "--limit", "5"]))).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "history",
      "--before=2026-11-20",
      "--limit=5",
    ]);
  });
});
