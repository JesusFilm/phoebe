// The bench kind end to end against real git, the GitHub stub and a fake
// `runBench`: an origin whose PR branches change the prompt, the governing
// config or only `AGENTS.md`, the hub clone the engine works from, and a
// runtime root holding the suite. The settings read runs the real child.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { buildBenchReport } from "../../src/bench-report.ts";
import type { runBench } from "../../src/bench-run.ts";
import { asBranchRef, asPrNumber, asSha } from "../../src/branded.ts";
import { resolveConfig, type PhoebeUserConfig } from "../../src/config-schema.ts";
import type {
  BenchContender,
  BenchFixture,
  BenchRunConfig,
  BenchSuite,
  BenchTrial,
} from "../../src/contracts/bench.ts";
import type { AgentRunRecord } from "../../src/contracts/unit-record.ts";
import type { LabeledPr, UnitTarget } from "../../src/github-client.ts";
import { stubGitHub } from "../../src/github-stub.ts";
import { selectPipeline } from "../../src/pipeline.ts";
import type { WorkKindCtx, WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { validateWorkKindDefinition } from "../../src/work-kinds/validate.ts";
import benchKind, {
  BENCH_PROMPT_FILE,
  createBenchKind,
  trimSuite,
  type BenchUnit,
} from "./index.ts";
import { resolveBenchOptions } from "./options.ts";
import { defaultRunSettingsChild, type RunSettingsChild } from "./sides.ts";

const saved: Record<string, string | undefined> = {};
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-bench-kind-"));
  const globalConfig = join(root, "gitconfig");
  writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n");
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: "Phoebe",
    GIT_AUTHOR_EMAIL: "phoebe@example.com",
    GIT_COMMITTER_NAME: "Phoebe",
    GIT_COMMITTER_EMAIL: "phoebe@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function governingConfig(model: string): string {
  return (
    "export default {\n" +
    '  repoSlug: "acme/widget",\n' +
    '  repoUrl: "https://github.com/acme/widget.git",\n' +
    '  installCommand: "npm ci",\n' +
    '  checkCommand: "npm run check",\n' +
    '  testCommand: "npm test",\n' +
    '  defaultProvider: "claude",\n' +
    `  model: "${model}",\n` +
    "};\n"
  );
}

const MAIN_PROMPT = "# Issues\n\nDo the work for #{{ISSUE_NUMBER}}.\n";
const PR_PROMPT = "# Issues\n\nRead AGENTS.md first, then do the work for #{{ISSUE_NUMBER}}.\n";

const ORIGIN_FILES: Record<string, string> = {
  "phoebe.config.ts": governingConfig("claude-sonnet-5-5"),
  "prompts/issues-prompt.md": MAIN_PROMPT,
  "AGENTS.md": "# AGENTS.md\n",
  "src/index.ts": "export {};\n",
};

/** The PR branches on origin, each one commit over main. */
const BRANCHES: Record<string, Record<string, string>> = {
  "prompt-change": { "prompts/issues-prompt.md": PR_PROMPT, "AGENTS.md": "# AGENTS.md\n\nMore.\n" },
  "model-change": { "phoebe.config.ts": governingConfig("claude-opus-5-5") },
  "agents-only": { "AGENTS.md": "# AGENTS.md\n\nRead the tests.\n" },
};

function fixtureOf(issue: number, pr: number): BenchFixture {
  return {
    issue: { number: issue, title: `Issue ${issue}`, body: "Do it.", comments: [] },
    pr: { number: pr, headSha: "a".repeat(40), mergeSha: "b".repeat(40) },
    baseSha: "c".repeat(40),
    baselinePassedAt: "2026-11-24T00:00:00.000Z",
  };
}

const SUITE: BenchSuite = {
  v: 1,
  repo: "acme/widget",
  selectedAt: "2026-11-24T00:00:00.000Z",
  selection: { by: "query", since: null, limit: 20 },
  fixtures: [fixtureOf(1, 10), fixtureOf(3, 30), fixtureOf(2, 20)],
  skipped: [],
};

/** An origin with PR branches, its hub clone, and a runtime root that is no git tree. */
function fixture(opts: { suite?: boolean } = {}) {
  const base = mkdtempSync(join(root, "fx-"));
  const seed = join(base, "seed");
  const origin = join(base, "origin.git");
  const dataBase = join(base, "data");
  const runtimeRoot = join(base, "runtime");
  mkdirSync(seed);
  git(seed, ["init", "--quiet", "-b", "main"]);
  write(seed, ORIGIN_FILES);
  git(seed, ["add", "--all"]);
  git(seed, ["commit", "--quiet", "-m", "init"]);
  const heads: Record<string, string> = {};
  for (const [branch, files] of Object.entries(BRANCHES)) {
    git(seed, ["checkout", "--quiet", "-b", branch, "main"]);
    write(seed, files);
    git(seed, ["commit", "--quiet", "-am", branch]);
    heads[branch] = git(seed, ["rev-parse", "HEAD"]).trim();
  }
  git(seed, ["checkout", "--quiet", "main"]);
  git(base, ["clone", "--quiet", "--bare", seed, origin]);
  const repoDir = join(dataBase, "acme/widget/repo");
  mkdirSync(dirname(repoDir), { recursive: true });
  git(base, ["clone", "--quiet", origin, repoDir]);
  write(runtimeRoot, {
    "phoebe.config.ts": governingConfig("claude-sonnet-5-5"),
    "prompts/issues-prompt.md": MAIN_PROMPT,
    ...(opts.suite === false ? {} : { "bench/suite.json": JSON.stringify(SUITE) }),
  });
  return { dataBase, runtimeRoot, repoDir, heads };
}

const BENCH_BLOCK = { path: "phoebe-agent/kinds/bench", suite: "bench/suite.json" };

function config(
  dataBase: string = join(root, "data"),
  pipelines?: PhoebeUserConfig["pipelines"],
  pipeline = "bench",
) {
  return selectPipeline(
    resolveConfig(
      {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "npm ci",
        checkCommand: "npm run check",
        testCommand: "npm test",
        defaultProvider: "claude",
        pipelines: pipelines ?? { bench: { kinds: { bench: BENCH_BLOCK } } },
      },
      { dataBase },
    ),
    pipeline,
  );
}

// --- the fake bench ---------------------------------------------------------

function agentRun(costUsd: number, tokens: number): AgentRunRecord {
  return {
    startedAt: "2026-11-25T12:00:00.000Z",
    durationMs: 1000,
    exitCode: 0,
    promptSha: "s".repeat(64),
    costBasis: "api",
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd,
    turns: null,
    providerDurationMs: null,
    stopReason: null,
    reportedModels: [],
    usageComplete: true,
    toolCalls: {},
  };
}

const PASS = { command: "x", exitCode: 0, durationMs: 1 };
const FAIL = { command: "x", exitCode: 1, durationMs: 1 };
const RUN_ID = "2026-11-26T12-00-00-000Z";

type BenchOpts = Parameters<typeof runBench>[0];

/**
 * A `runBench` that runs nothing: `main` passes one fixture's test and `pr`
 * passes every one. It reads each contender's prompt file, as the real one
 * does before the first trial.
 */
function fakeBench(opts: { interrupted?: boolean } = {}) {
  const calls: BenchOpts[] = [];
  const prompts: Record<string, string> = {};
  const bench: typeof runBench = async (run) => {
    calls.push(run);
    const benchConfig = run.benchConfig!;
    const contenders: BenchContender[] = benchConfig.contenders.map((spec) => {
      prompts[spec.name] = readFileSync(spec.promptFile!, "utf8");
      return {
        name: spec.name,
        provider: spec.provider ?? "claude",
        model: spec.model ?? "tenant-model",
        effort: spec.effort ?? null,
        promptFile: spec.promptFile!,
        promptSha: "s".repeat(64),
      };
    });
    const runConfig: BenchRunConfig = {
      v: 1,
      runId: RUN_ID,
      repo: "acme/widget",
      startedAt: "2026-11-26T12:00:00.000Z",
      suite: {
        path: run.suitePath,
        selectedAt: run.suite.selectedAt,
        fixtures: run.suite.fixtures.map((f) => f.issue.number),
      },
      benchConfig: null,
      contenders,
      repeat: benchConfig.repeat ?? 1,
      judge: benchConfig.judge ?? null,
      concurrency: 1,
      runTimeoutMs: 2_700_000,
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      engineCommit: null,
    };
    const trials: BenchTrial[] = contenders.flatMap((contender) =>
      run.suite.fixtures.map((fixture, index): BenchTrial => {
        const passes = contender.name === "pr" || index === 0;
        return {
          v: 1,
          tenant: "acme/widget",
          pipeline: "bench",
          unit: { kind: "issues", id: `issue:${fixture.issue.number}` },
          outcome: "completed",
          quarantined: false,
          detail: null,
          startedAt: "2026-11-26T12:00:00.000Z",
          settledAt: "2026-11-26T12:01:00.000Z",
          durationMs: 60_000,
          runBudgetMs: 2_700_000,
          provider: contender.provider,
          model: contender.model,
          effort: null,
          branch: `phoebe/issue-${fixture.issue.number}`,
          headSha: null,
          prNumber: null,
          engineCommit: null,
          agentRuns: [agentRun(contender.name === "pr" ? 0.4 : 0.5, 1_000_000)],
          runId: RUN_ID,
          fixture: { issue: fixture.issue.number, pr: fixture.pr.number, baseSha: fixture.baseSha },
          contender: contender.name,
          repeat: 0,
          change: "committed",
          gates: { install: PASS, check: PASS, test: passes ? PASS : FAIL },
          diff: null,
          patch: "patches/x.patch",
          wouldHave: [],
          judgement:
            runConfig.judge === null
              ? null
              : {
                  ...runConfig.judge,
                  verdict: passes ? "equivalent" : "worse",
                  rationale: "r",
                  error: null,
                  run: agentRun(0.1, 1000),
                },
        };
      }),
    );
    const report = buildBenchReport({
      runConfig,
      trials,
      baselines: {},
      unstable: [],
      finishedAt: new Date("2026-11-26T13:00:00.000Z"),
      interrupted: opts.interrupted === true,
    });
    return { runId: RUN_ID, runDir: "/nowhere", trials, report };
  };
  return { bench, calls, prompts };
}

// --- the harness ------------------------------------------------------------

function labeled(number: number, headSha: string): LabeledPr {
  return {
    number: asPrNumber(number),
    title: `PR ${number}`,
    headRefName: asBranchRef(`feature-${number}`),
    headSha: asSha(headSha),
  };
}

const NO_AGENT = {
  run: async () => {
    throw new Error("the bench kind never starts an agent of its own");
  },
  prWorkflow: async () => {
    throw new Error("unused");
  },
  issueWorkflow: async () => {
    throw new Error("unused");
  },
  cleanMerge: () => "failed" as const,
};

function harness(opts: {
  branch: keyof typeof BRANCHES;
  suite?: boolean;
  options?: Record<string, unknown>;
  interrupted?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const fx = fixture({ suite: opts.suite });
  const scratch = mkdtempSync(join(root, "scratch-"));
  const cfg = config(fx.dataBase);
  const logged: string[] = [];
  const comments: Array<{ target: UnitTarget; body: string }> = [];
  const removed: Array<{ target: UnitTarget; label: string }> = [];
  const childEnvs: Array<Record<string, string>> = [];
  const prNumber = 42;
  const headSha = fx.heads[opts.branch]!;
  const github = stubGitHub({
    listLabeledPrs: (label) => (label === "phoebe:bench" ? [labeled(prNumber, headSha)] : []),
    postUnitComment: (target, body) => {
      comments.push({ target, body });
    },
    removeUnitLabel: (target, label) => {
      removed.push({ target, label });
    },
  }).forCycle() as unknown as WorkKindRunCtx["github"];
  const ctx: WorkKindRunCtx = {
    kind: "bench",
    config: cfg,
    options: undefined,
    env: opts.env ?? {},
    github,
    origin: {
      fetch: () => {
        git(fx.repoDir, ["fetch", "--quiet", "--prune", "origin"]);
      },
      branchHead: (branch) => asSha(git(fx.repoDir, ["rev-parse", `origin/${branch}`]).trim()),
      commitsBehind: () => 0,
    },
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: { now: () => new Date("2026-11-26T12:00:00.000Z"), sleep: async () => {} },
    inFlight: new Set(),
    quarantined: new Set(),
    log: (line) => logged.push(line),
    workspace: { mode: "scratch", dir: scratch, scratch },
    signal: new AbortController().signal,
    agent: NO_AGENT,
  };
  const fake = fakeBench({ interrupted: opts.interrupted });
  const runSettingsChild: RunSettingsChild = (child) => {
    childEnvs.push(child.env);
    return defaultRunSettingsChild(child);
  };
  const kind = createBenchKind(
    cfg,
    resolveBenchOptions({ ...BENCH_BLOCK_OPTIONS, ...opts.options }, "kinds.bench", {}),
    { runBench: fake.bench, runtimeRoot: fx.runtimeRoot, runSettingsChild },
  );
  const unit: BenchUnit = {
    ref: `pr:${prNumber}`,
    github: { objectType: "pr", id: prNumber },
    revision: headSha,
    pr: { number: prNumber, title: "PR", headSha, headRefName: opts.branch },
  };
  return {
    kind,
    ctx,
    run: () => kind.run(unit, ctx),
    fx,
    headSha,
    logged,
    comments,
    removed,
    childEnvs,
    bench: fake,
  };
}

const BENCH_BLOCK_OPTIONS = { suite: "bench/suite.json" };

// --- registration -----------------------------------------------------------

describe("registration", () => {
  test("registers as a scratch kind with its own placeholder prompt", () => {
    const definition = validateWorkKindDefinition(
      benchKind(config(), { suite: "bench/suite.json" }),
      "kinds.bench",
    );
    expect(definition.name).toBe("bench");
    expect(definition.workspace).toBe("scratch");
    expect(definition.promptFile).toBe(BENCH_PROMPT_FILE);
    expect(readFileSync(BENCH_PROMPT_FILE, "utf8")).toContain("never starts an agent");
  });

  test("a pipeline that runs anything else, or more than one slot, is refused", () => {
    const shared = config(undefined, { work: { kinds: { bench: BENCH_BLOCK } } }, "work");
    expect(() => benchKind(shared, { suite: "s.json" })).toThrow(
      "kinds.bench: bench needs a pipeline of its own, and `pipelines.work` also runs",
    );
    const wide = config(undefined, { bench: { concurrency: 2, kinds: { bench: BENCH_BLOCK } } });
    expect(() => benchKind(wide, { suite: "s.json" })).toThrow(
      "`pipelines.bench.concurrency` is 2",
    );
  });

  test("the suite is required, and an unknown option fails", () => {
    expect(() => benchKind(config(), {})).toThrow("kinds.bench: `suite` is required");
    expect(() => benchKind(config(), { suite: "s.json", maxFixture: 3 })).toThrow(
      "unknown option `maxFixture`",
    );
  });
});

// --- fetch and select -------------------------------------------------------

describe("fetch and select", () => {
  test("one unit per labelled PR, and a PR already in flight is skipped", async () => {
    const kind = createBenchKind(config(), resolveBenchOptions(BENCH_BLOCK_OPTIONS, "k", {}), {
      runBench: fakeBench().bench,
    });
    const asked: string[] = [];
    const ctx = {
      github: stubGitHub({
        listLabeledPrs: (label) => {
          asked.push(label);
          return [labeled(7, "1".repeat(40)), labeled(9, "2".repeat(40))];
        },
      }).forCycle(),
      inFlight: new Set(["pr:7"]),
      quarantined: new Set<string>(),
    } as unknown as WorkKindCtx;
    const gathered = await kind.fetch(ctx);
    expect(asked).toEqual(["phoebe:bench"]);
    expect(gathered.units.map((unit) => [unit.ref, unit.revision])).toEqual([
      ["pr:7", "1".repeat(40)],
      ["pr:9", "2".repeat(40)],
    ]);
    expect(gathered.units[0]!.github).toEqual({ objectType: "pr", id: 7 });

    const selection = kind.select(gathered, ctx);
    expect(selection.unit?.ref).toBe("pr:9");
    expect(selection.total).toBe(2);

    const busy = kind.select(gathered, {
      ...ctx,
      inFlight: new Set(["pr:7", "pr:9"]),
    } as WorkKindCtx);
    expect(busy).toEqual({ unit: null, skipped: [{ reason: "in flight", count: 2 }], total: 2 });
  });
});

// --- run --------------------------------------------------------------------

describe("run", () => {
  test("a prompt change gets one comment with both contenders' figures, and loses its label", async () => {
    const h = harness({ branch: "prompt-change" });
    const result = await h.run();

    expect(h.bench.calls).toHaveLength(1);
    const call = h.bench.calls[0]!;
    expect(call.benchConfig!.contenders.map((spec) => spec.name)).toEqual(["main", "pr"]);
    expect(h.bench.prompts).toEqual({ main: MAIN_PROMPT, pr: PR_PROMPT });
    // The settings came from each tree's config, and did not change.
    for (const spec of call.benchConfig!.contenders) {
      expect([spec.provider, spec.model]).toEqual(["claude", "claude-sonnet-5-5"]);
    }
    expect(call.signal).toBe(h.ctx.signal);

    expect(h.comments).toHaveLength(1);
    const { target, body } = h.comments[0]!;
    expect(target).toEqual({ objectType: "pr", id: 42 });
    expect(body).toContain(`<!-- phoebe-bench run=${RUN_ID} head=${h.headSha} -->`);
    expect(body).toContain(`Head \`${h.headSha.slice(0, 12)}\`, run \`${RUN_ID}\``);
    expect(body).toContain("| | `main` | `pr` |");
    expect(body).toContain("| Test pass rate | 33% (1/3) | 100% (3/3) |");
    expect(body).toContain("| No change | 0 | 0 |");
    expect(body).toContain("| Median tokens | 1.00M | 1.00M |");
    expect(body).toContain("| Median cost | $0.50 | $0.40 |");
    expect(body).toContain(
      "| Prompt | `prompts/issues-prompt.md` | `prompts/issues-prompt.md`, changed |",
    );
    expect(body).toContain("Total cost: $2.70.");
    expect(body).not.toContain("Judge verdicts");
    // The PR touches AGENTS.md too, which bench does not measure.
    expect(body).toContain("This PR also changes `AGENTS.md`. Bench does not measure");

    expect(h.removed).toEqual([{ target: { objectType: "pr", id: 42 }, label: "phoebe:bench" }]);
    expect(result).toEqual({
      summary: `PR #42: run ${RUN_ID}, test pass main 33%, pr 100%, over 3 fixture(s)`,
    });
  });

  test("maxFixtures trims to the newest fixtures; repeat and judge pass through", async () => {
    const judge = { provider: "claude", model: "claude-opus-5-5" };
    const h = harness({
      branch: "prompt-change",
      options: { maxFixtures: 2, repeat: 3, judge },
    });
    await h.run();

    const call = h.bench.calls[0]!;
    expect(call.suite.fixtures.map((f) => f.pr.number)).toEqual([30, 20]);
    expect(call.suitePath).toBe("bench/suite.json");
    expect(call.benchConfig!.repeat).toBe(3);
    expect(call.benchConfig!.judge).toEqual(judge);
    const body = h.comments[0]!.body;
    expect(body).toContain("2 fixture(s) (the newest 2 of 3), 3 repeat(s) each.");
    expect(body).toContain(
      "| Judge verdicts | 0 better, 1 equivalent, 1 worse, 0 wrong | " +
        "0 better, 2 equivalent, 0 worse, 0 wrong |",
    );
    expect(body).toContain("the judge's 4 run(s) included");
  });

  test("a deployment with no suite comments the select command and runs nothing", async () => {
    const h = harness({ branch: "prompt-change", suite: false });
    const result = await h.run();

    expect(h.bench.calls).toEqual([]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]!.body).toContain("phoebe bench select > bench/suite.json");
    expect(h.comments[0]!.body).toContain("no suite at `bench/suite.json`");
    expect(h.removed).toEqual([{ target: { objectType: "pr", id: 42 }, label: "phoebe:bench" }]);
    expect(h.childEnvs).toEqual([]);
    expect(result).toEqual({ summary: "PR #42: no suite at bench/suite.json, nothing ran" });
  });

  test("a PR with nothing measurable comments that and runs nothing", async () => {
    const h = harness({ branch: "agents-only" });
    const result = await h.run();

    expect(h.bench.calls).toEqual([]);
    expect(h.comments).toHaveLength(1);
    const body = h.comments[0]!.body;
    expect(body).toContain("there is nothing to measure");
    expect(body).toContain("It changes `AGENTS.md`, which bench does not measure yet.");
    expect(h.removed).toHaveLength(1);
    expect(result).toEqual({ summary: "PR #42: nothing to measure, nothing ran" });
  });

  test("the pr contender's settings come from a child whose env holds no GitHub token", async () => {
    const h = harness({
      branch: "model-change",
      env: {
        PATH: process.env["PATH"],
        HOME: "/home/phoebe",
        GH_TOKEN: "ghs_not-a-real-token", // gitleaks:allow
        GITHUB_TOKEN: "ghs_not-a-real-token-either", // gitleaks:allow
        GH_APP_ID: "12345",
        GH_APP_PRIVATE_KEY: "not-a-key",
        ANTHROPIC_API_KEY: "sk-not-a-key",
        OPENAI_API_KEY: "sk-not-a-key-either",
        PHOEBE_GH_LOGIN: "phoebe-bot",
      },
    });
    await h.run();

    const [main, pr] = h.bench.calls[0]!.benchConfig!.contenders;
    expect(main).toMatchObject({ name: "main", provider: "claude", model: "claude-sonnet-5-5" });
    expect(pr).toMatchObject({ name: "pr", provider: "claude", model: "claude-opus-5-5" });
    // The prompt did not change, only the model.
    expect(h.bench.prompts["pr"]).toBe(MAIN_PROMPT);

    expect(h.childEnvs).toHaveLength(2);
    for (const env of h.childEnvs) {
      for (const key of Object.keys(env)) {
        expect(key, key).not.toMatch(/^(GH_TOKEN|GITHUB_TOKEN|GH_APP_.*)$/);
      }
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(env["OPENAI_API_KEY"]).toBeUndefined();
      expect(env["HOME"]).not.toBe("/home/phoebe");
      expect(env["PATH"]).toBe(process.env["PATH"]);
    }
    expect(h.comments[0]!.body).toContain(
      "| Settings | claude `claude-sonnet-5-5` | claude `claude-opus-5-5` |",
    );
    expect(h.comments[0]!.body).toContain("| Prompt | `prompts/issues-prompt.md` | same as main |");
  });

  test("an interrupted bench posts nothing and keeps its label, so it runs again", async () => {
    const h = harness({ branch: "prompt-change", interrupted: true });
    await expect(h.run()).rejects.toThrow("was interrupted after");
    expect(h.comments).toEqual([]);
    expect(h.removed).toEqual([]);
  });

  test("the kind never starts an agent, so no trial reaches a unit record", async () => {
    // `NO_AGENT.run` throws; a run that reached it would reject.
    const h = harness({ branch: "prompt-change" });
    await expect(h.run()).resolves.toBeDefined();
  });
});

describe("trimSuite", () => {
  test("keeps the newest fixtures by PR number, newest first", () => {
    expect(trimSuite(SUITE, 1).fixtures.map((f) => f.pr.number)).toEqual([30]);
    expect(trimSuite(SUITE, 10).fixtures.map((f) => f.pr.number)).toEqual([30, 20, 10]);
  });
});
