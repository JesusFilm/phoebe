import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNIT_RECORD_DETAIL_MAX, type AgentRunUsage } from "./contracts/unit-record.ts";
import { noUsage } from "./providers/usage.ts";
import {
  agentRunRecord,
  appendUnitLine,
  createRecordUnit,
  readEngineCommit,
  unitsPathFor,
  UNITS_ROTATED_FILE,
  type AgentRunTrack,
  type UnitRecordInput,
} from "./unit-record.ts";

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-unit-record-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A settled unit with no agent run, as a clean merge leaves. */
function input(overrides: Partial<UnitRecordInput> = {}): UnitRecordInput {
  return {
    unit: { kind: "conflicts", id: "pr:21" },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: "2026-11-25T10:00:00.000Z",
    settledAt: "2026-11-25T10:01:00.000Z",
    durationMs: 60_000,
    runBudgetMs: 2_700_000,
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: null,
    branch: null,
    headSha: null,
    prNumber: 21,
    agentRuns: [],
    ...overrides,
  };
}

function writer(path: string, log: string[] = []) {
  return createRecordUnit({
    deployment: "fleet",
    tenant: "acme/widget",
    pipeline: "work",
    unitsPath: path,
    engineCommit: "abc123",
    log: (line) => log.push(line),
  });
}

function lines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

describe("recordUnit", () => {
  test("appends one versioned line per unit under the pipeline's state dir", () => {
    const path = unitsPathFor(stateDir(), "work");
    const record = writer(path);

    record(input());
    record(input({ outcome: "failed", detail: "push rejected" }));

    expect(lines(path)).toEqual([
      {
        v: 1,
        tenant: "acme/widget",
        pipeline: "work",
        engineCommit: "abc123",
        ...input(),
      },
      expect.objectContaining({ v: 1, outcome: "failed", detail: "push rejected" }),
    ]);
  });

  test("cuts detail to 500 characters", () => {
    const path = unitsPathFor(stateDir(), "work");
    writer(path)(input({ outcome: "failed", detail: "x".repeat(2_000) }));

    const [line] = lines(path) as { detail: string }[];
    expect(line?.detail).toHaveLength(UNIT_RECORD_DETAIL_MAX);
  });

  test("a failing append is one log line and never a throw", () => {
    const dir = stateDir();
    // A file where the pipeline's directory should be: nothing can be written under it.
    writeFileSync(join(dir, "work"), "");
    const log: string[] = [];

    expect(() => writer(unitsPathFor(dir, "work"), log)(input())).not.toThrow();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(
      /^\[fleet:acme\/widget:work\] could not append to units\.jsonl for conflicts pr:21 — /,
    );
  });

  test("tells the supervisor a record landed, and only when one did", () => {
    const dir = stateDir();
    let appended = 0;
    const deps = {
      deployment: "fleet",
      tenant: "acme/widget",
      pipeline: "work",
      engineCommit: null,
      log: () => {},
      onAppended: () => (appended += 1),
    };

    createRecordUnit({ ...deps, unitsPath: unitsPathFor(dir, "work") })(input());
    expect(appended).toBe(1);

    writeFileSync(join(dir, "blocked"), "");
    createRecordUnit({ ...deps, unitsPath: unitsPathFor(dir, "blocked") })(input());
    expect(appended).toBe(1);
  });
});

describe("appendUnitLine", () => {
  test("past the cap, renames the file over units.1.jsonl and starts a new one", () => {
    const dir = join(stateDir(), "work");
    const path = join(dir, "units.jsonl");
    const rotated = join(dir, UNITS_ROTATED_FILE);

    appendUnitLine(path, "first\n", 10);
    appendUnitLine(path, "second\n", 10);
    // 13 bytes on disk now, past the cap of 10, so this one starts a generation.
    appendUnitLine(path, "third\n", 10);
    expect(readFileSync(rotated, "utf8")).toBe("first\nsecond\n");
    expect(readFileSync(path, "utf8")).toBe("third\n");

    appendUnitLine(path, "fourth-line\n", 10);
    appendUnitLine(path, "fifth\n", 10);
    // Two generations, never three: the old units.1.jsonl is gone.
    expect(readFileSync(rotated, "utf8")).toBe("third\nfourth-line\n");
    expect(readFileSync(path, "utf8")).toBe("fifth\n");
  });

  test("stays under the cap's two generations at the real 1 MiB", () => {
    const dir = join(stateDir(), "work");
    const path = join(dir, "units.jsonl");
    const line = `${"x".repeat(1023)}\n`;
    for (let i = 0; i < 3_000; i++) appendUnitLine(path, line);

    const total =
      readFileSync(path).byteLength + readFileSync(join(dir, UNITS_ROTATED_FILE)).byteLength;
    expect(total).toBeLessThanOrEqual(2 * (1024 * 1024 + 1024));
  });
});

describe("agentRunRecord", () => {
  const usage = (overrides: Partial<AgentRunUsage> = {}): AgentRunUsage => ({
    ...noUsage(),
    inputTokens: 10,
    costUsd: 0.2,
    usageComplete: true,
    ...overrides,
  });

  const track = (overrides: Partial<AgentRunTrack> = {}): AgentRunTrack => ({
    startedAt: new Date("2026-11-25T10:00:00.000Z"),
    promptSha: "f00d",
    costBasis: "api",
    meter: { observe: () => {}, read: () => usage() },
    endedAt: new Date("2026-11-25T10:00:30.000Z"),
    exitCode: 0,
    ...overrides,
  });

  test("an exited run carries its exit code, its duration and its meter's usage", () => {
    expect(agentRunRecord(track(), new Date("2026-11-25T10:05:00.000Z"))).toEqual({
      ...usage(),
      startedAt: "2026-11-25T10:00:00.000Z",
      durationMs: 30_000,
      exitCode: 0,
      promptSha: "f00d",
      costBasis: "api",
    });
  });

  test("a run still going when its unit settled is incomplete, whatever its meter says", () => {
    const record = agentRunRecord(
      track({ endedAt: null, exitCode: null }),
      new Date("2026-11-25T10:01:00.000Z"),
    );
    expect(record).toMatchObject({ exitCode: null, durationMs: 60_000, usageComplete: false });
  });

  test("no cost figure has no basis", () => {
    const record = agentRunRecord(
      track({ meter: { observe: () => {}, read: () => usage({ costUsd: null }) } }),
      new Date(),
    );
    expect(record.costBasis).toBeNull();
  });
});

describe("readEngineCommit", () => {
  test("is null for an engine that is not a git checkout", () => {
    const root = stateDir();
    mkdirSync(join(root, "src"));
    expect(readEngineCommit(join(root, "src"), () => "deadbeef\n")).toBeNull();
  });

  test("asks git for HEAD of the checkout the engine was loaded from", () => {
    const root = stateDir();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    const asked: string[][] = [];
    const commit = readEngineCommit(join(root, "src"), (args) => {
      asked.push(args);
      return "deadbeef\n";
    });
    expect(commit).toBe("deadbeef");
    expect(asked).toEqual([["-C", root, "rev-parse", "HEAD"]]);
  });

  test("is null when git cannot answer", () => {
    const root = stateDir();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    expect(
      readEngineCommit(join(root, "src"), () => {
        throw new Error("not a git repository");
      }),
    ).toBeNull();
  });
});
