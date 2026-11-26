// The observer kind end to end against the GitHub stub, a fake history read
// and a fake agent: registration, the `every` gate across a restart, and runs
// that file, fold, skip and cap proposals and say so in their summary.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { UnitRecord } from "../../src/contracts/unit-record.ts";
import { resolveConfig, type PhoebeUserConfig } from "../../src/config-schema.ts";
import { asBranchRef, asPrNumber, asSha } from "../../src/branded.ts";
import type { GitRunner } from "../../src/git-model.ts";
import type { MentioningIssue, ObservedPr } from "../../src/github-client.ts";
import { stubGitHub, type GitHubStubOverrides } from "../../src/github-stub.ts";
import { selectPipeline } from "../../src/pipeline.ts";
import type { WorkKindCtx, WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { validateWorkKindDefinition } from "../../src/work-kinds/validate.ts";
import { unitKeyOf } from "./evidence.ts";
import observerKind, {
  createObserverKind,
  OBSERVER_PROMPT_FILE,
  type ObserverUnit,
} from "./index.ts";
import { resolveObserverOptions } from "./options.ts";
import { parseFindingMarker, renderFindingMarker, renderUnitsMarker } from "./proposals.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-11-25T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

function unitRecord(overrides: Partial<UnitRecord> = {}): UnitRecord {
  return {
    v: 1,
    tenant: "acme/widget",
    pipeline: "work",
    unit: { kind: "issues", id: "issue:1" },
    outcome: "completed",
    quarantined: false,
    detail: null,
    startedAt: daysAgo(1),
    settledAt: daysAgo(1),
    durationMs: 1_000,
    runBudgetMs: 3_600_000,
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: null,
    branch: null,
    headSha: null,
    prNumber: null,
    engineCommit: null,
    agentRuns: [],
    ...overrides,
  };
}

const OBSERVER_BLOCK = { path: "phoebe-agent/kinds/observer", every: "7d" };

function config(pipelines?: PhoebeUserConfig["pipelines"], pipeline = "observe") {
  return selectPipeline(
    resolveConfig({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      defaultProvider: "claude",
      pipelines: pipelines ?? {
        intake: { kinds: { triage: { path: "./triage.ts" } } },
        observe: { kinds: { observer: OBSERVER_BLOCK } },
      },
    }),
    pipeline,
  );
}

/** Histories keyed by pipeline; every read is noted. */
function histories(byPipeline: Record<string, UnitRecord[]>) {
  const reads: string[] = [];
  return {
    reads,
    readHistory: (dir: string) => {
      const pipeline = basename(dir);
      reads.push(pipeline);
      return byPipeline[pipeline] ?? [];
    },
  };
}

function baseCtx(github: GitHubStubOverrides, logged: string[]): WorkKindCtx {
  return {
    kind: "observer",
    config: config(),
    options: undefined,
    env: {},
    github: stubGitHub(github).forCycle() as unknown as WorkKindCtx["github"],
    origin: {
      fetch: () => {},
      branchHead: () => {
        throw new Error("unused");
      },
      commitsBehind: () => 0,
    },
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: { now: () => NOW, sleep: async () => {} },
    inFlight: new Set(),
    quarantined: new Set(),
    log: (line) => logged.push(line),
  };
}

describe("registration", () => {
  test("registers as a readonly kind with its own prompt", () => {
    const definition = validateWorkKindDefinition(
      observerKind(config(), { every: "7d" }),
      "kinds.observer",
    );
    expect(definition.name).toBe("observer");
    expect(definition.workspace).toBe("readonly");
    expect(definition.promptFile).toBe(OBSERVER_PROMPT_FILE);
    expect(existsSync(OBSERVER_PROMPT_FILE)).toBe(true);
    expect(definition.requiredEnv).toBeUndefined();
  });

  test("an unknown option fails registration; either mode registers", () => {
    expect(() => observerKind(config(), { every: "7d", lookbak: "30d" })).toThrow(
      "kinds.observer: unknown option `lookbak`",
    );
    expect(() => observerKind(config(), { mode: "pr" })).not.toThrow();
    expect(() => observerKind(config(), { mode: "issues" })).not.toThrow();
  });

  test("a pipeline that runs anything else is refused", () => {
    const shared = config({ work: { kinds: { observer: OBSERVER_BLOCK } } }, "work");
    expect(() => observerKind(shared, {})).toThrow(
      "kinds.observer: the observer needs a pipeline of its own, and `pipelines.work` also runs",
    );
  });
});

describe("the schedule", () => {
  async function pick(
    options: Record<string, unknown>,
    own: UnitRecord[],
    ctxExtra: Partial<WorkKindCtx> = {},
  ) {
    const history = histories({ observe: own });
    const kind = createObserverKind(config(), resolveObserverOptions(options, "kinds.observer"), {
      readHistory: history.readHistory,
    });
    const ctx = { ...baseCtx({}, []), ...ctxExtra };
    const selection = kind.select(await kind.fetch(ctx), ctx);
    return { selection, reads: history.reads };
  }

  const observerRun = (overrides: Partial<UnitRecord>) =>
    unitRecord({ pipeline: "observe", unit: { kind: "observer", id: "observer" }, ...overrides });

  test("with no `every` it never offers a run", async () => {
    const { selection, reads } = await pick({}, []);
    expect(selection).toEqual({ unit: null, skipped: [], total: 0 });
    expect(reads).toEqual([]);
  });

  test("never run, it is due, and fetch reads only its own history", async () => {
    const { selection, reads } = await pick({ every: "7d" }, []);
    expect(selection.unit).toEqual({ ref: "observer", revision: "never" });
    expect(reads).toEqual(["observe"]);
  });

  test("a restart inside the window finds the last completed run on disk and waits", async () => {
    const own = [observerRun({ settledAt: daysAgo(3) })];
    // Two engines built one after the other over the same history: a restart.
    expect((await pick({ every: "7d" }, own)).selection.unit).toBeNull();
    expect((await pick({ every: "7d" }, own)).selection.unit).toBeNull();
    expect((await pick({ every: "2d" }, own)).selection.unit).toEqual({
      ref: "observer",
      revision: daysAgo(3),
    });
  });

  test("a run already in flight is not offered again", async () => {
    const { selection } = await pick({ every: "7d" }, [], { inFlight: new Set(["observer"]) });
    expect(selection).toEqual({
      unit: null,
      skipped: [{ reason: "in flight", count: 1 }],
      total: 1,
    });
  });
});

describe("a run in issue mode", () => {
  type Created = { number: number; title: string; body: string };

  function harness(opts: {
    byPipeline: Record<string, UnitRecord[]>;
    options?: Record<string, unknown>;
    proposals?: MentioningIssue[];
    comments?: Record<number, string[]>;
    findings?: (flagged: Array<{ id: string; ref: string }>) => unknown;
    github?: GitHubStubOverrides;
    git?: GitRunner;
  }) {
    const scratch = mkdtempSync(join(tmpdir(), "observer-test-"));
    const history = histories(opts.byPipeline);
    const logged: string[] = [];
    const created: Created[] = [];
    const labels: Array<{ number: number; label: string }> = [];
    const posted: Array<{ id: number; body: string }> = [];
    const agentCalls: Record<string, string>[] = [];
    let nextIssue = 41;
    const base = baseCtx(
      {
        listIssuesMentioning: () => opts.proposals ?? [],
        listPrsMentioning: () => [],
        issueCommentBodies: (n) => opts.comments?.[n] ?? [],
        createIssue: (issue) => {
          const number = nextIssue++;
          created.push({ number, ...issue });
          return number;
        },
        addIssueLabel: (number, label) => {
          labels.push({ number, label });
        },
        postUnitComment: (target, body) => {
          posted.push({ id: target.id, body });
        },
        ...opts.github,
      },
      logged,
    );
    const ctx: WorkKindRunCtx = {
      ...base,
      workspace: { mode: "readonly", dir: scratch, scratch },
      signal: new AbortController().signal,
      agent: {
        run: async (runOpts) => {
          const args = runOpts?.promptArgs ?? {};
          agentCalls.push(args);
          if (opts.findings === undefined) return;
          const flagged = JSON.parse(readFileSync(args["FLAGGED_JSON"]!, "utf8")) as Array<{
            id: string;
            ref: string;
          }>;
          writeFileSync(args["FINDINGS_JSON"]!, JSON.stringify(opts.findings(flagged)));
        },
        prWorkflow: async () => {
          throw new Error("unused");
        },
        issueWorkflow: async () => {
          throw new Error("unused");
        },
        cleanMerge: () => "failed",
      },
    };
    const kind = createObserverKind(
      config(),
      resolveObserverOptions(
        { mode: "issues", ...(opts.options ?? { every: "7d" }) },
        "kinds.observer",
      ),
      { readHistory: history.readHistory, ...(opts.git ? { git: opts.git } : {}) },
    );
    const unit: ObserverUnit = { ref: "observer", revision: "never" };
    return {
      run: () => kind.run(unit, ctx),
      reads: history.reads,
      logged,
      created,
      labels,
      posted,
      agentCalls,
    };
  }

  /** Twenty days of `work` history and nine of `intake`, with failures in both. */
  const failing = (id: string, days: number, overrides: Partial<UnitRecord> = {}) =>
    unitRecord({
      unit: { kind: "issues", id },
      outcome: "failed",
      detail: `pnpm install failed for ${id}`,
      startedAt: daysAgo(days),
      ...overrides,
    });
  const byPipeline = (): Record<string, UnitRecord[]> => ({
    work: [
      unitRecord({ unit: { kind: "issues", id: "issue:old" }, startedAt: daysAgo(20) }),
      failing("issue:1", 5),
      failing("issue:2", 4),
      failing("issue:3", 3),
      failing("issue:4", 2, {
        outcome: "timed-out",
        quarantined: true,
        detail: "3600s budget exceeded",
      }),
      unitRecord({ unit: { kind: "issues", id: "issue:5" }, startedAt: daysAgo(1) }),
    ],
    intake: [
      unitRecord({
        pipeline: "intake",
        unit: { kind: "triage", id: "t:1" },
        startedAt: daysAgo(9.5),
      }),
      unitRecord({
        pipeline: "intake",
        unit: { kind: "triage", id: "t:2" },
        outcome: "abandoned",
        settledAt: null,
        startedAt: daysAgo(1),
      }),
    ],
    // Its own history holds a failure too, which it must never read in a run.
    observe: [
      unitRecord({
        pipeline: "observe",
        unit: { kind: "observer", id: "observer" },
        outcome: "failed",
      }),
    ],
  });

  const ids = (flagged: Array<{ id: string; ref: string }>, ...refs: string[]) =>
    flagged.filter((unit) => refs.includes(unit.ref)).map((unit) => unit.id);

  test("with nothing flagged it spends no agent run and says what it covered", async () => {
    const h = harness({
      byPipeline: { work: [unitRecord({ startedAt: daysAgo(20) })], intake: [] },
    });
    const result = await h.run();
    expect(h.agentCalls).toEqual([]);
    expect(result).toEqual({
      summary: "no flagged units, nothing filed; coverage work 14d, intake none",
    });
  });

  test("reads every other pipeline and never its own, and shows the agent only flagged units", async () => {
    const h = harness({ byPipeline: byPipeline(), findings: () => ({ findings: [] }) });
    const result = await h.run();
    expect(h.reads.sort()).toEqual(["intake", "work"]);
    expect(h.agentCalls).toHaveLength(1);
    const flagged = JSON.parse(readFileSync(h.agentCalls[0]!["FLAGGED_JSON"]!, "utf8")) as Array<{
      ref: string;
      flags: string[];
    }>;
    expect(flagged.map((unit) => [unit.ref, unit.flags])).toEqual([
      ["t:2", ["abandoned"]],
      ["issue:4", ["timed-out", "quarantined"]],
      ["issue:3", ["failed"]],
      ["issue:2", ["failed"]],
      ["issue:1", ["failed"]],
    ]);
    expect(h.agentCalls[0]!["OBSERVER_COVERAGE"]).toBe("coverage work 14d, intake 9d");
    expect(result).toEqual({ summary: "nothing filed; coverage work 14d, intake 9d" });
  });

  test("flags units from what became of their PRs, and never a unit on a proposal", async () => {
    const observed = (overrides: Partial<ObservedPr>): ObservedPr => ({
      number: asPrNumber(70),
      state: "merged",
      createdAt: daysAgo(3),
      mergedAt: daysAgo(2.9),
      closedAt: daysAgo(2.9),
      headRefName: asBranchRef("phoebe/issue-6"),
      mergeCommitOid: asSha("e".repeat(40)),
      body: "Closes #6",
      labels: [],
      closingIssues: [6],
      changesRequested: 0,
      reviewThreads: 0,
      commits: [],
      commitsTruncated: false,
      ...overrides,
    });
    const prs = [
      observed({}),
      observed({ number: asPrNumber(71), state: "closed", mergedAt: null, closingIssues: [7] }),
      observed({ number: asPrNumber(72), closingIssues: [41], mergeCommitOid: null }),
    ];
    const gitCalls: string[][] = [];
    const h = harness({
      byPipeline: {
        work: [
          // Opened #70 on its branch; the record has no PR number.
          unitRecord({
            unit: { kind: "issues", id: "issue:6" },
            branch: "phoebe/issue-6",
            startedAt: daysAgo(3.1),
            settledAt: daysAgo(3),
          }),
          unitRecord({
            unit: { kind: "reviews", id: "pr:71" },
            prNumber: 71,
            startedAt: daysAgo(2),
          }),
          // Works proposal #41 and failed: still not evidence.
          unitRecord({
            unit: { kind: "checks", id: "pr:72" },
            prNumber: 72,
            outcome: "failed",
            startedAt: daysAgo(1),
          }),
          unitRecord({
            unit: { kind: "issues", id: "issue:41" },
            outcome: "failed",
            startedAt: daysAgo(1),
          }),
        ],
        intake: [],
      },
      proposals: [
        {
          number: 41,
          body: renderFindingMarker("ticket:acceptance-criteria"),
          state: "open",
          stateReason: null,
          closedAt: null,
          labels: ["phoebe:observer"],
        },
      ],
      github: {
        branchPrs: (branches) =>
          new Map(
            branches.map((branch) => [
              branch,
              branch === "phoebe/issue-6"
                ? [{ number: asPrNumber(70), createdAt: daysAgo(3), closedAt: daysAgo(2.9) }]
                : [],
            ]),
          ),
        observedPrs: (numbers) => prs.filter((pr) => numbers.includes(pr.number)),
        revertPrs: () => [],
        branchWorkflowRuns: () => [],
      },
      git: (args) => {
        gitCalls.push(args);
        return `${"f".repeat(40)}\x1fRevert\n\nThis reverts commit ${"e".repeat(40)}.\n\x1e`;
      },
      findings: () => ({ findings: [] }),
    });
    await h.run();
    expect(gitCalls[0]?.slice(2, 3)).toEqual(["log"]);
    const flagged = JSON.parse(readFileSync(h.agentCalls[0]!["FLAGGED_JSON"]!, "utf8")) as Array<{
      ref: string;
      flags: string[];
      prNumber: number | null;
      pr: { revertedBy: string | null } | null;
    }>;
    expect(flagged.map((unit) => [unit.ref, unit.flags, unit.prNumber])).toEqual([
      ["pr:71", ["closed-unmerged"], 71],
      ["issue:6", ["reverted"], 70],
    ]);
    expect(flagged[1]!.pr?.revertedBy).toBe("fffffff");
  });

  test("files each finding as an issue with the label and the marker", async () => {
    const h = harness({
      byPipeline: byPipeline(),
      findings: (flagged) => ({
        findings: [
          {
            category: "factory",
            target: "phoebe.config.ts",
            title: "Installs fail before any work starts",
            problem: "Every failed run died in `pnpm install`.",
            fix: "Set `installCommand` to `pnpm install --frozen-lockfile`.",
            units: ids(flagged, "issue:1", "issue:2", "issue:3"),
          },
          {
            category: "engine",
            target: "worktree-cleanup",
            title: "Triage runs are abandoned",
            units: ids(flagged, "t:2"),
          },
        ],
      }),
    });
    const result = await h.run();
    expect(h.created.map((issue) => [issue.number, issue.title])).toEqual([
      [41, "Observer: Installs fail before any work starts"],
      [42, "Observer: Triage runs are abandoned"],
    ]);
    const body = h.created[0]!.body;
    expect(body.startsWith("<!-- phoebe-observer finding=factory:phoebe.config.ts -->\n")).toBe(
      true,
    );
    expect(body).toContain("**Category:** factory defect");
    expect(body).toContain("## Suggested fix");
    expect(body).toContain("3 unit(s) in the last 14d:");
    expect(body).toContain("- `work` `issues` `issue:1`, failed, started");
    expect(body).toContain(": pnpm install failed for issue:1");
    expect(body).toContain(
      renderUnitsMarker(
        byPipeline()
          .work!.filter((record) => ["issue:3", "issue:2", "issue:1"].includes(record.unit.id))
          .reverse()
          .map((record) => unitKeyOf("work", record)),
      ),
    );
    expect(h.labels).toEqual([
      { number: 41, label: "phoebe:observer" },
      { number: 42, label: "phoebe:observer" },
    ]);
    expect(h.labels.some((entry) => entry.label === "ready-for-agent")).toBe(false);
    expect(result).toEqual({
      summary: "2 proposals filed (#41, #42); coverage work 14d, intake 9d",
    });
  });

  test("new evidence for an open proposal is a comment listing only the units it lacks", async () => {
    const records = byPipeline();
    const listed = records.work!.find((record) => record.unit.id === "issue:1")!;
    const h = harness({
      byPipeline: records,
      proposals: [
        {
          number: 38,
          body: `${renderFindingMarker("factory:phoebe.config.ts")}\n${renderUnitsMarker([unitKeyOf("work", listed)])}`,
          state: "open",
          stateReason: null,
          closedAt: null,
          labels: ["phoebe:observer"],
        },
      ],
      comments: { 38: ["a person's comment"] },
      findings: (flagged) => ({
        findings: [
          {
            category: "factory",
            target: "phoebe.config.ts",
            title: "Installs fail",
            units: ids(flagged, "issue:1", "issue:2"),
          },
        ],
      }),
    });
    const result = await h.run();
    expect(h.created).toEqual([]);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.id).toBe(38);
    expect(h.posted[0]!.body).toContain("in 1 more unit(s):");
    expect(h.posted[0]!.body).toContain("`issue:2`");
    expect(h.posted[0]!.body).not.toContain("`issue:1`");
    expect(result).toEqual({ summary: "1 folded into #38; coverage work 14d, intake 9d" });
  });

  test("an open proposal that already lists every unit gets nothing", async () => {
    const records = byPipeline();
    const unit = records.work!.find((record) => record.unit.id === "issue:2")!;
    const h = harness({
      byPipeline: records,
      proposals: [
        {
          number: 38,
          body: renderFindingMarker("factory:phoebe.config.ts"),
          state: "open",
          stateReason: null,
          closedAt: null,
          labels: [],
        },
      ],
      comments: { 38: [renderUnitsMarker([unitKeyOf("work", unit)])] },
      findings: (flagged) => ({
        findings: [
          {
            category: "factory",
            target: "phoebe.config.ts",
            title: "x",
            units: ids(flagged, "issue:2"),
          },
        ],
      }),
    });
    expect(await h.run()).toEqual({ summary: "1 skipped; coverage work 14d, intake 9d" });
    expect(h.posted).toEqual([]);
  });

  test("a key turned down within 90 days is skipped; a completed one is filed as a regression", async () => {
    const h = harness({
      byPipeline: byPipeline(),
      proposals: [
        {
          number: 30,
          body: renderFindingMarker("ticket:acceptance-criteria"),
          state: "closed",
          stateReason: "not_planned",
          closedAt: daysAgo(30),
          labels: [],
        },
        {
          number: 31,
          body: renderFindingMarker("factory:phoebe.config.ts"),
          state: "closed",
          stateReason: "completed",
          closedAt: daysAgo(4.5),
          labels: [],
        },
      ],
      findings: (flagged) => ({
        findings: [
          {
            category: "factory",
            target: "phoebe.config.ts",
            title: "Installs fail again",
            units: ids(flagged, "issue:1", "issue:2", "issue:3"),
          },
          {
            category: "ticket",
            target: "acceptance-criteria",
            title: "Tickets lack criteria",
            units: ids(flagged, "issue:4"),
          },
        ],
      }),
    });
    const result = await h.run();
    expect(h.created).toHaveLength(1);
    const body = h.created[0]!.body;
    expect(body).toContain("**Regression of #31.**");
    // Only the units that ran after the fix closed are its evidence.
    expect(body).toContain("2 unit(s) in the last 14d:");
    expect(body).not.toContain("`issue:1`");
    expect(h.logged).toContain(
      "ticket:acceptance-criteria: skipped, turned down within 90 days (#30).",
    );
    expect(result).toEqual({
      summary: "1 proposal filed (#41), 1 skipped; coverage work 14d, intake 9d",
    });
  });

  test("files no more than maxProposals, keeping the best-supported findings", async () => {
    const h = harness({
      byPipeline: byPipeline(),
      options: { every: "7d", maxProposals: 1 },
      findings: (flagged) => ({
        findings: [
          { category: "engine", target: "a", title: "One unit", units: ids(flagged, "t:2") },
          {
            category: "factory",
            target: "b",
            title: "Three units",
            units: ids(flagged, "issue:1", "issue:2", "issue:3"),
          },
        ],
      }),
    });
    const result = await h.run();
    expect(h.created.map((issue) => issue.title)).toEqual(["Observer: Three units"]);
    expect(result).toEqual({
      summary: "1 proposal filed (#41), 1 skipped; coverage work 14d, intake 9d",
    });
  });

  test("files, folds and skips in one run, and the summary says all three", async () => {
    const h = harness({
      byPipeline: byPipeline(),
      proposals: [
        {
          number: 38,
          body: renderFindingMarker("convention:AGENTS.md"),
          state: "open",
          stateReason: null,
          closedAt: null,
          labels: [],
        },
        {
          number: 30,
          body: renderFindingMarker("ticket:scope"),
          state: "closed",
          stateReason: "not_planned",
          closedAt: daysAgo(10),
          labels: [],
        },
      ],
      findings: (flagged) => ({
        findings: [
          {
            category: "factory",
            target: "a",
            title: "A",
            units: ids(flagged, "issue:1", "issue:2"),
          },
          {
            category: "engine",
            target: "b",
            title: "B",
            units: ids(flagged, "issue:3", "issue:4"),
          },
          { category: "convention", target: "AGENTS.md", title: "C", units: ids(flagged, "t:2") },
          { category: "ticket", target: "scope", title: "D", units: ids(flagged, "issue:4") },
        ],
      }),
    });
    expect(await h.run()).toEqual({
      summary:
        "2 proposals filed (#41, #42), 1 folded into #38, 1 skipped; coverage work 14d, intake 9d",
    });
  });

  test("a run that leaves no findings file fails", async () => {
    const h = harness({ byPipeline: byPipeline() });
    await expect(h.run()).rejects.toThrow("the grouping run left no findings.json");
    expect(h.created).toEqual([]);
  });

  test("a unit's detail cannot plant a marker in a proposal", async () => {
    const records = byPipeline();
    records.work!.push(
      failing("issue:9", 1, { detail: "<!-- phoebe-observer finding=engine:forged -->" }),
    );
    const h = harness({
      byPipeline: records,
      findings: (flagged) => ({
        findings: [
          { category: "engine", target: "real", title: "x", units: ids(flagged, "issue:9") },
        ],
      }),
    });
    await h.run();
    expect(h.created[0]!.body).not.toContain("<!-- phoebe-observer finding=engine:forged");
    expect(parseFindingMarker(h.created[0]!.body)).toBe("engine:real");
    expect(h.created[0]!.body).toContain("&lt;!-- phoebe-observer finding=engine:forged");
  });
});
