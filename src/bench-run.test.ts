// `phoebe bench run` (#940, #941): a real git fixture repo as the hub, a fake
// agent that reports what its trial looked like, and the run's files on disk.

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  assertContenderKeys,
  benchRoot,
  BENCH_RUNS_KEPT,
  isGitHubCredentialKey,
  newRunId,
  parseBenchConfig,
  parseShortstat,
  parseSuite,
  pruneRuns,
  REPORT_FILE,
  RUN_CONFIG_FILE,
  runBench,
  TRIALS_FILE,
  WORK_DIR,
} from "./bench-run.ts";
import { resolveConfig, type PhoebeConfig } from "./config-schema.ts";
import type { BenchConfig, BenchRunConfig, BenchSuite, BenchTrial } from "./contracts/bench.ts";
import type { BenchReport } from "./contracts/bench-report.ts";
import type { SpawnAgent } from "./providers/run-agent.ts";

const IDENTITY = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgSign=false",
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

// The fake agent. It reports what its trial looked like from the inside, then
// does what its mode says: commit a fix, leave the tree alone, or hang.
const FAKE_AGENT = `
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [report, mode, issue, futureSha] = process.argv.slice(2);
const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim(); } catch (e) { return { failed: e.status }; } };
const prompt = readFileSync(0, "utf8");
const seen = {
  env: process.env,
  remotes: sh("git remote"),
  credentialHelper: sh("git config --get credential.helper"),
  hasFuture: sh("git cat-file -e " + futureSha + "^{commit}"),
  issue: JSON.parse(sh("gh issue view " + issue + " --json number,title,body")),
  prCreate: sh("gh pr create --base main --title t --body 'Closes #" + issue + "'"),
  push: sh("git push origin HEAD"),
  prompt,
};
writeFileSync(report, JSON.stringify(seen));
if (mode === "commit") {
  writeFileSync("fixed.txt", "fixed\\n");
  execSync("git add fixed.txt && git commit -q -m 'Phoebe: fix'");
}
if (mode === "sleep") setTimeout(() => {}, 60_000);
`;

// The fake judge. It reports what it was handed, then answers as its mode
// says, on Claude's stream: a verdict, a verdict off the scale, or a crash.
const FAKE_JUDGE = `
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const [report, mode] = process.argv.slice(2);
writeFileSync(report, JSON.stringify({
  env: process.env,
  files: Object.fromEntries(readdirSync(".").map((name) => [name, readFileSync(name, "utf8")])),
  prompt: readFileSync(0, "utf8"),
}));
if (mode === "crash") process.exit(2);
const verdict = mode === "off-scale" ? "great" : mode;
const result = "Read all three.\\n" + JSON.stringify({ verdict, rationale: "Same fix, same file." });
console.log(JSON.stringify({
  type: "result",
  result,
  total_cost_usd: 0.75,
  modelUsage: { "judge-model": { inputTokens: 4000, outputTokens: 500 } },
}));
`;

describe("runBench", () => {
  let root: string;
  let runtimeRoot: string;
  let deploymentDir: string;
  let config: PhoebeConfig;
  let baseSha: string;
  let futureSha: string;
  let agentScript: string;
  let judgeScript: string;
  let reportsDir: string;

  const PARENT_ENV: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    GH_TOKEN: "not-a-real-token",
    GITHUB_TOKEN: "not-a-real-token",
    GH_APP_ID: "123",
    GH_APP_PRIVATE_KEY: "not-a-real-key",
    ANTHROPIC_API_KEY: "provider-key-for-test",
  };

  function fixture(issue: number): BenchSuite["fixtures"][number] {
    return {
      issue: { number: issue, title: `Issue ${issue}`, body: `Fix ${issue}.`, comments: [] },
      pr: { number: issue * 10, headSha: futureSha, mergeSha: futureSha },
      baseSha,
    };
  }

  function suite(...issues: number[]): BenchSuite {
    return {
      v: 1,
      repo: "acme/widget",
      selectedAt: "2026-11-25T00:00:00.000Z",
      selection: { by: "issues", issues },
      fixtures: issues.map(fixture),
      skipped: [],
    };
  }

  /** Spawn the fake agent in place of the provider CLI, in the mode its issue asks for. */
  function fakeAgent(
    modes: Record<number, string>,
    onSpawn: (issue: number) => void = () => {},
  ): SpawnAgent {
    return (_file, _args, opts) => {
      const issue = Number(/issue-(\d+)-/.exec(opts.cwd)?.[1]);
      const trialId = /(issue-[^/]+)[/\\]repo/.exec(opts.cwd)?.[1];
      onSpawn(issue);
      return spawn(
        process.execPath,
        [
          agentScript,
          join(reportsDir, trialId === undefined ? `${issue}.json` : `${trialId}.prompt.json`),
          modes[issue] ?? "none",
          String(issue),
          futureSha,
        ],
        { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] },
      );
    };
  }

  function seen(
    issue: number,
    trialId = `issue-${issue}-tenant-0`,
  ): {
    env: Record<string, string>;
    remotes: string;
    credentialHelper: unknown;
    hasFuture: unknown;
    issue: { number: number; title: string };
    prCreate: string;
    push: unknown;
    prompt: string;
  } {
    return JSON.parse(readFileSync(join(reportsDir, `${trialId}.prompt.json`), "utf8"));
  }

  function trialsOf(runDir: string): BenchTrial[] {
    const path = join(runDir, TRIALS_FILE);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as BenchTrial);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phoebe-bench-run-"));
    runtimeRoot = join(root, "runtime");
    deploymentDir = join(root, "deployment");
    mkdirSync(join(deploymentDir, "bench"), { recursive: true });
    writeFileSync(
      join(deploymentDir, "bench", "candidate.md"),
      "Candidate prompt for #{{ISSUE_NUMBER}}.\n",
    );
    config = resolveConfig(
      {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "true",
        checkCommand: "test -f fixed.txt",
        testCommand: "exit 3",
      },
      { dataBase: join(root, "data") },
    );
    const hub = config.paths.repoDir;
    mkdirSync(hub, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", hub]);
    writeFileSync(join(hub, "seed"), "seed\n");
    git(hub, "add", ".");
    git(hub, "commit", "-q", "-m", "seed");
    baseSha = git(hub, "rev-parse", "HEAD");
    writeFileSync(join(hub, "fixed.txt"), "the merged answer\n");
    git(hub, "add", ".");
    git(hub, "commit", "-q", "-m", "Phoebe: the merged fix");
    futureSha = git(hub, "rev-parse", "HEAD");

    const promptPath = join(runtimeRoot, config.promptFiles.issue);
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(
      promptPath,
      "Work issue #{{ISSUE_NUMBER}}.\n!`gh issue view {{ISSUE_NUMBER}} --json title`\n",
    );
    reportsDir = join(root, "reports");
    mkdirSync(reportsDir);
    agentScript = join(root, "fake-agent.mjs");
    writeFileSync(agentScript, FAKE_AGENT);
    judgeScript = join(root, "fake-judge.mjs");
    writeFileSync(judgeScript, FAKE_JUDGE);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function run(
    issues: number[],
    modes: Record<number, string>,
    extra: {
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      onSpawn?: (issue: number) => void;
      benchConfig?: BenchConfig;
      concurrency?: number;
      /** What the judge answers for each issue; `equivalent` when unlisted. */
      judgeModes?: Record<number, string>;
    } = {},
  ) {
    const agent = fakeAgent(modes, extra.onSpawn);
    const judgeRuns: number[] = [];
    const spawnAgent: SpawnAgent = (file, args, opts) => {
      const judged = /(issue-(\d+)-[^/\\]+)-judge[/\\]inputs$/.exec(opts.cwd);
      if (judged === null) return agent(file, args, opts);
      const issue = Number(judged[2]);
      judgeRuns.push(issue);
      return spawn(
        process.execPath,
        [
          judgeScript,
          join(reportsDir, `${judged[1]}.judge.json`),
          extra.judgeModes?.[issue] ?? "equivalent",
        ],
        { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] },
      );
    };
    const lines: string[] = [];
    const result = await runBench({
      config,
      env: { ...PARENT_ENV, ...extra.env },
      suite: suite(...issues),
      suitePath: "bench/suite.json",
      runtimeRoot,
      ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
      ...(extra.benchConfig !== undefined
        ? { benchConfig: extra.benchConfig, benchConfigPath: "bench/bench.json" }
        : {}),
      ...(extra.concurrency !== undefined ? { concurrency: extra.concurrency } : {}),
      deploymentDir,
      deps: {
        spawnAgent,
        log: (line) => lines.push(line),
        engineCommit: "e".repeat(40),
      },
    });
    return { ...result, lines, judgeRuns };
  }

  test("a trial's agent holds no GitHub credential, its clone has no remote, and gh is the shim", async () => {
    const { trials } = await run([7], { 7: "commit" });
    const inside = seen(7);

    expect(Object.keys(inside.env).filter(isGitHubCredentialKey)).toEqual([]);
    expect(inside.env["ANTHROPIC_API_KEY"]).toBe("provider-key-for-test");
    expect(inside.env["HOME"]).toContain(join(WORK_DIR, "f0-issue-7-tenant-0", "home"));
    expect(inside.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(inside.remotes).toBe("");
    expect(inside.credentialHelper).toEqual({ failed: 1 });
    expect(inside.push).toMatchObject({ failed: expect.any(Number) });
    // The merged answer is not in the trial's repository.
    expect(inside.hasFuture).toMatchObject({ failed: expect.any(Number) });

    // gh issue view returned the snapshot, to the agent and to the prompt.
    expect(inside.issue).toEqual({ number: 7, title: "Issue 7", body: "Fix 7." });
    expect(inside.prompt).toContain("Work issue #7.");
    expect(inside.prompt).toContain('"title": "Issue 7"');

    // gh pr create answered with a success and was recorded.
    expect(inside.prCreate).toBe("https://github.com/acme/widget/pull/70");
    expect(trials[0]!.wouldHave.map((write) => write.command)).toEqual(["pr create"]);
  });

  test("records each trial with bench's own gate results, its diff and its patch", async () => {
    const { runDir, trials, report } = await run([7, 8], { 7: "commit", 8: "none" });

    expect(trialsOf(runDir)).toEqual(trials);
    const [fixed, untouched] = trials;
    expect(fixed).toMatchObject({
      v: 1,
      tenant: "acme/widget",
      pipeline: "bench",
      unit: { kind: "issues", id: "issue:7" },
      outcome: "failed",
      detail: "testCommand exited 3",
      provider: "claude",
      engineCommit: "e".repeat(40),
      branch: "phoebe/issue-7",
      prNumber: null,
      fixture: { issue: 7, pr: 70, baseSha },
      contender: "tenant",
      repeat: 0,
      change: "committed",
      diff: { commits: 1, filesChanged: 1, insertions: 1, deletions: 0 },
      patch: "patches/f0-issue-7-tenant-0.patch",
    });
    expect(fixed!.gates.install).toMatchObject({ command: "true", exitCode: 0 });
    expect(fixed!.gates.check).toMatchObject({ command: "test -f fixed.txt", exitCode: 0 });
    expect(fixed!.gates.test).toMatchObject({ command: "exit 3", exitCode: 3 });
    for (const gate of [fixed!.gates.install, fixed!.gates.check, fixed!.gates.test]) {
      expect(gate!.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(fixed!.agentRuns).toHaveLength(1);
    expect(fixed!.agentRuns[0]).toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(runDir, fixed!.patch!), "utf8")).toContain("+fixed");

    // No commits: no change, and no gate after install.
    expect(untouched).toMatchObject({
      outcome: "completed",
      change: "none",
      diff: null,
      patch: null,
      gates: { check: null, test: null },
    });
    expect(readdirSync(join(runDir, "patches"))).toEqual(["f0-issue-7-tenant-0.patch"]);

    // The trees went with their trials.
    expect(existsSync(join(runDir, WORK_DIR))).toBe(false);

    const runConfig = JSON.parse(
      readFileSync(join(runDir, RUN_CONFIG_FILE), "utf8"),
    ) as BenchRunConfig;
    expect(runConfig).toMatchObject({
      repo: "acme/widget",
      suite: { path: "bench/suite.json", fixtures: [7, 8] },
      contenders: [{ name: "tenant", provider: "claude", promptFile: config.promptFiles.issue }],
      repeat: 1,
      installCommand: "true",
      checkCommand: "test -f fixed.txt",
      testCommand: "exit 3",
    });
    expect(report).toMatchObject({
      interrupted: false,
      benchConfig: null,
      repeat: 1,
      concurrency: 1,
      planned: 2,
      recorded: 2,
      outcomes: { completed: 1, failed: 1, timedOut: 0, noChange: 1 },
    });
    expect(report.contenders).toHaveLength(1);
    expect(report.contenders[0]).toMatchObject({
      contender: { name: "tenant" },
      trials: 2,
      noChange: 1,
      check: { passed: 1, of: 2, rate: 0.5 },
      test: { passed: 0, of: 2, rate: 0 },
    });
  });

  test("stops the gates at the first failure", async () => {
    config = { ...config, checkCommand: "exit 2" };
    const { trials } = await run([7], { 7: "commit" });
    expect(trials[0]!.gates.check).toMatchObject({ exitCode: 2 });
    expect(trials[0]!.gates.test).toBeNull();
    expect(trials[0]!.detail).toBe("checkCommand exited 2");
  });

  test("writes nothing to any pipeline's units.jsonl", async () => {
    await run([7], { 7: "commit" });
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.startsWith("units")) found.push(join(dir, entry.name));
      }
    };
    walk(join(root, "data"));
    expect(found).toEqual([]);
  });

  test("a timed-out trial is recorded and the run goes on", async () => {
    const { trials } = await run(
      [8, 7],
      { 8: "sleep", 7: "commit" },
      {
        env: { PHOEBE_ISSUES_RUN_TIMEOUT_MS: "1500" },
      },
    );
    expect(trials.map((trial) => [trial.fixture.issue, trial.outcome])).toEqual([
      [8, "timed-out"],
      [7, "failed"],
    ]);
    expect(trials[0]!.runBudgetMs).toBe(1500);
    expect(trials[0]!.gates.check).toBeNull();
  }, 20_000);

  test("a fixture that cannot be set up fails alone", async () => {
    const result = await runBench({
      config,
      env: PARENT_ENV,
      suite: { ...suite(7), fixtures: [{ ...fixture(9), baseSha: "0".repeat(40) }, fixture(7)] },
      suitePath: "bench/suite.json",
      runtimeRoot,
      deps: { spawnAgent: fakeAgent({ 7: "commit" }), log: () => {}, engineCommit: null },
    });
    expect(result.trials.map((trial) => [trial.fixture.issue, trial.outcome])).toEqual([
      [9, "failed"],
      [7, "failed"],
    ]);
    expect(result.trials[0]!.detail).toMatch(/could not set up the trial/);
  });

  test("an interrupt drops the trial in flight and leaves a partial report", async () => {
    const controller = new AbortController();
    const {
      runDir,
      trials,
      report: returned,
    } = await run(
      [7, 8, 9],
      { 7: "commit", 8: "sleep" },
      {
        signal: controller.signal,
        onSpawn: (issue) => {
          if (issue === 8) setTimeout(() => controller.abort(), 300);
        },
      },
    );
    expect(trials.map((trial) => trial.fixture.issue)).toEqual([7]);
    expect(trialsOf(runDir).map((trial) => trial.fixture.issue)).toEqual([7]);
    const report = JSON.parse(readFileSync(join(runDir, REPORT_FILE), "utf8")) as BenchReport;
    expect(report).toEqual(returned);
    expect(report).toMatchObject({ interrupted: true, planned: 3, recorded: 1 });
    expect(existsSync(join(runDir, WORK_DIR))).toBe(false);
    expect(existsSync(join(reportsDir, "issue-9-tenant-0.prompt.json"))).toBe(false);
  }, 20_000);

  test("two contenders over one suite give one row each, the tenant filling what each left unset", async () => {
    config = { ...config, model: "tenant-model", effort: "medium" };
    const { runDir, trials, report } = await run(
      [7, 8],
      { 7: "commit", 8: "none" },
      {
        benchConfig: {
          contenders: [
            { name: "current" },
            { name: "candidate", model: "other-model", promptFile: "bench/candidate.md" },
          ],
        },
      },
    );

    expect(trials.map((trial) => [trial.fixture.issue, trial.contender])).toEqual([
      [7, "current"],
      [7, "candidate"],
      [8, "current"],
      [8, "candidate"],
    ]);
    const [current, candidate] = report.contenders;
    expect(current!.contender).toMatchObject({
      name: "current",
      provider: "claude",
      model: "tenant-model",
      effort: "medium",
      promptFile: config.promptFiles.issue,
    });
    // Only the model and prompt are the contender's; provider and effort are the tenant's.
    expect(candidate!.contender).toMatchObject({
      name: "candidate",
      provider: "claude",
      model: "other-model",
      effort: "medium",
      promptFile: "bench/candidate.md",
    });
    expect(candidate!.contender.promptSha).not.toBe(current!.contender.promptSha);
    expect(trials.find((t) => t.contender === "candidate")!.agentRuns[0]!.promptSha).toBe(
      candidate!.contender.promptSha,
    );
    expect(seen(7, "issue-7-candidate-0").prompt).toContain("Candidate prompt for #7.");
    expect(seen(7, "issue-7-current-0").prompt).toContain("Work issue #7.");

    for (const row of report.contenders) {
      expect(row).toMatchObject({
        trials: 2,
        noChange: 1,
        check: { passed: 1, of: 2, rate: 0.5 },
        test: { passed: 0, of: 2, rate: 0 },
      });
      expect(row.medianDurationMs).toEqual(expect.any(Number));
      expect(Object.keys(row).sort()).toEqual(
        [
          "apiCostUsd",
          "check",
          "contender",
          "medianDurationMs",
          "medianTokens",
          "noChange",
          "outcomes",
          "subscriptionEstimateUsd",
          "test",
          "trials",
          "verdicts",
        ].sort(),
      );
    }
    expect(report).toMatchObject({ planned: 4, recorded: 4, benchConfig: "bench/bench.json" });
    expect(JSON.parse(readFileSync(join(runDir, REPORT_FILE), "utf8"))).toEqual(report);
    const runConfig = JSON.parse(
      readFileSync(join(runDir, RUN_CONFIG_FILE), "utf8"),
    ) as BenchRunConfig;
    expect(runConfig.contenders).toEqual(report.contenders.map((row) => row.contender));
  });

  test("a contender's provider brings that provider's own defaults, not the tenant's model", async () => {
    const { report } = await run(
      [8],
      { 8: "none" },
      {
        env: { OPENAI_KEY: "provider-key-for-test" },
        benchConfig: { contenders: [{ name: "codex", provider: "codex", effort: null }] },
      },
    );
    expect(report.contenders[0]!.contender).toMatchObject({
      provider: "codex",
      model: config.defaultModels.codex,
      effort: null,
    });
  });

  test("repeat replays each pair with distinct repeat indexes, concurrently when asked", async () => {
    const { trials, report } = await run(
      [7],
      { 7: "commit" },
      {
        benchConfig: { contenders: [{ name: "a" }, { name: "b" }], repeat: 3 },
        concurrency: 2,
      },
    );
    const pairs = trials.map((trial) => `${trial.contender}#${trial.repeat}`).sort();
    expect(pairs).toEqual(["a#0", "a#1", "a#2", "b#0", "b#1", "b#2"]);
    expect(new Set(trials.map((trial) => trial.patch)).size).toBe(6);
    expect(report).toMatchObject({ repeat: 3, concurrency: 2, planned: 6, recorded: 6 });
    expect(report.contenders.map((row) => row.trials)).toEqual([3, 3]);
  }, 30_000);

  test("refuses, before any trial, a contender with a missing prompt file or provider key", async () => {
    await expect(
      run(
        [7],
        {},
        { benchConfig: { contenders: [{ name: "x", promptFile: "bench/missing.md" }] } },
      ),
    ).rejects.toThrow(/Contender `x`: Could not find prompt file bench\/missing.md/);
    await expect(
      run([7], {}, { benchConfig: { contenders: [{ name: "x", provider: "cursor" }] } }),
    ).rejects.toThrow(/x: cursor needs CURSOR_API_KEY, which is unset/);
    expect(existsSync(benchRoot(config))).toBe(false);
  });

  test("without a judge, nothing is judged and the report has no verdicts", async () => {
    const { trials, report, judgeRuns } = await run([7], { 7: "commit" });
    expect(judgeRuns).toEqual([]);
    expect(trials[0]!.judgement).toBeNull();
    expect(report.judge).toBeNull();
    expect(report.contenders[0]!.verdicts).toBeNull();
  });

  test("a judge gives each trial with commits one verdict, its cost kept apart", async () => {
    const judge = { provider: "claude", model: "judge-model" };
    const { runDir, trials, report, judgeRuns } = await run(
      [7, 8, 9],
      { 7: "commit", 8: "none", 9: "commit" },
      {
        benchConfig: { contenders: [{ name: "tenant" }], judge },
        judgeModes: { 7: "better", 9: "off-scale" },
      },
    );

    // Only the trials with commits were judged, once each.
    expect(judgeRuns).toEqual([7, 9]);
    const [seven, eight, nine] = trials;
    expect(seven!.judgement).toMatchObject({
      provider: "claude",
      model: "judge-model",
      verdict: "better",
      rationale: "Same fix, same file.",
      error: null,
      run: { exitCode: 0, costUsd: 0.75, costBasis: "api", inputTokens: 4000, outputTokens: 500 },
    });
    expect(eight!.judgement).toBeNull();
    // A verdict off the scale is no verdict.
    expect(nine!.judgement).toMatchObject({
      verdict: null,
      rationale: null,
      error: "the judge's reply held no verdict on the scale",
    });

    // The judge read the issue, the merged PR's diff and the trial's patch,
    // with no GitHub credential and no repository.
    const inside = JSON.parse(
      readFileSync(join(reportsDir, "issue-7-tenant-0.judge.json"), "utf8"),
    ) as { env: Record<string, string>; files: Record<string, string>; prompt: string };
    expect(Object.keys(inside.files).sort()).toEqual(["issue.md", "merged.diff", "trial.patch"]);
    expect(inside.files["issue.md"]).toContain("# #7: Issue 7");
    expect(inside.files["merged.diff"]).toContain("+the merged answer");
    expect(inside.files["trial.patch"]).toBe(readFileSync(join(runDir, seven!.patch!), "utf8"));
    expect(Object.keys(inside.env).filter(isGitHubCredentialKey)).toEqual([]);
    expect(inside.env["HOME"]).toContain(join(WORK_DIR, "f0-issue-7-tenant-0-judge", "home"));
    expect(inside.prompt).toContain("Issue #7 was solved by a pull request");
    expect(inside.prompt).toContain("(PR #70)");

    // The judge's usage is on the judgement, never in the contender's runs or columns.
    expect(seven!.agentRuns).toHaveLength(1);
    expect(seven!.agentRuns[0]!.costUsd).toBeNull();
    const [row] = report.contenders;
    expect(row).toMatchObject({
      apiCostUsd: null,
      subscriptionEstimateUsd: null,
      medianTokens: null,
      verdicts: { better: 1, equivalent: 0, worse: 0, wrong: 0, unjudged: 1 },
    });
    expect(report.judge).toEqual({
      ...judge,
      runs: 2,
      tokens: 9000,
      apiCostUsd: 1.5,
      subscriptionEstimateUsd: null,
    });
    const runConfig = JSON.parse(
      readFileSync(join(runDir, RUN_CONFIG_FILE), "utf8"),
    ) as BenchRunConfig;
    expect(runConfig.judge).toEqual(judge);
    expect(existsSync(join(runDir, WORK_DIR))).toBe(false);
  });

  test("a judge that crashes leaves the trial recorded with no verdict", async () => {
    config = { ...config, testCommand: "true" };
    const { trials } = await run(
      [7],
      { 7: "commit" },
      {
        benchConfig: {
          contenders: [{ name: "tenant" }],
          judge: { provider: "claude", model: "j" },
        },
        judgeModes: { 7: "crash" },
      },
    );
    expect(trials[0]).toMatchObject({
      outcome: "completed",
      judgement: {
        verdict: null,
        error: "the judge exited 2 with no verdict",
        run: { exitCode: 2 },
      },
    });
  });

  test("refuses, before any trial, a judge whose provider key is unset", async () => {
    await expect(
      run(
        [7],
        {},
        {
          benchConfig: {
            contenders: [{ name: "tenant" }],
            judge: { provider: "cursor", model: "j" },
          },
        },
      ),
    ).rejects.toThrow(/judge: cursor needs CURSOR_API_KEY, which is unset/);
    expect(existsSync(benchRoot(config))).toBe(false);
  });

  test("only the last 10 run directories remain after a new run starts", async () => {
    const bench = benchRoot(config);
    const old = Array.from({ length: 12 }, (_, i) => newRunId(new Date(Date.UTC(2026, 0, i + 1))));
    for (const id of old) mkdirSync(join(bench, id), { recursive: true });
    const { runId } = await run([8], { 8: "none" });
    const left = readdirSync(bench).sort();
    expect(left).toHaveLength(BENCH_RUNS_KEPT);
    expect(left).toEqual([...old.slice(-(BENCH_RUNS_KEPT - 1)), runId]);
  });
});

describe("pieces", () => {
  test("pruneRuns keeps the newest, leaving room for one more", () => {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-bench-prune-"));
    try {
      const ids = [
        "2026-01-01T00-00-00-000Z",
        "2026-01-02T00-00-00-000Z",
        "2026-01-03T00-00-00-000Z",
        "2026-01-04T00-00-00-000Z",
      ];
      for (const name of [...ids, ".cache", "2025-fixtures"]) mkdirSync(join(dir, name));
      expect(pruneRuns(dir, 3)).toEqual(ids.slice(0, 2));
      expect(readdirSync(dir).sort()).toEqual([".cache", "2025-fixtures", ...ids.slice(2)]);
      expect(pruneRuns(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run ids sort by start time", () => {
    expect(newRunId(new Date("2026-11-25T12:34:56.789Z"))).toBe("2026-11-25T12-34-56-789Z");
  });

  test("parseShortstat reads git's summary", () => {
    expect(parseShortstat(" 3 files changed, 10 insertions(+), 1 deletion(-)\n", 2)).toEqual({
      commits: 2,
      filesChanged: 3,
      insertions: 10,
      deletions: 1,
    });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)\n", 1)).toMatchObject({ deletions: 0 });
  });

  test("parseBenchConfig reads contenders and repeat, and refuses what it would guess at", () => {
    expect(
      parseBenchConfig(
        JSON.stringify({
          contenders: [
            { name: "a" },
            { name: "b.2", provider: "codex", model: "m", effort: null, promptFile: "p.md" },
          ],
          repeat: 2,
        }),
        "bench.json",
      ),
    ).toEqual({
      contenders: [
        { name: "a" },
        { name: "b.2", provider: "codex", model: "m", effort: null, promptFile: "p.md" },
      ],
      repeat: 2,
    });
    const refuse =
      (value: unknown): (() => BenchConfig) =>
      () =>
        parseBenchConfig(JSON.stringify(value), "bench.json");
    expect(() => parseBenchConfig("{", "bench.json")).toThrow(/bench.json is not JSON/);
    expect(refuse({ contenders: [] })).toThrow(/at least one/);
    expect(refuse({ contenders: [{ name: "a" }], repeat: 0 })).toThrow(/`repeat` must be/);
    expect(refuse({ contenders: [{ name: "a" }], judges: {} })).toThrow(/unknown field `judges`/);
    expect(refuse({ contenders: [{ name: "a" }], judge: {} })).toThrow(/judge.provider must be/);
    expect(refuse({ contenders: [{ name: "a" }], judge: { provider: "claude" } })).toThrow(
      /judge.model must be/,
    );
    expect(refuse({ contenders: [{ name: "a" }], judge: { provider: "gpt", model: "m" } })).toThrow(
      /judge.provider `gpt` is not one of/,
    );
    expect(
      refuse({
        contenders: [{ name: "a" }],
        judge: { provider: "claude", model: "m", effort: "x" },
      }),
    ).toThrow(/judge has unknown field `effort`/);
    expect(
      parseBenchConfig(
        JSON.stringify({ contenders: [{ name: "a" }], judge: { provider: "codex", model: " m " } }),
        "bench.json",
      ),
    ).toEqual({ contenders: [{ name: "a" }], judge: { provider: "codex", model: "m" } });
    expect(refuse({ contenders: [{ name: "a/b" }] })).toThrow(/name must be/);
    expect(refuse({ contenders: [{ name: "a" }, { name: "a" }] })).toThrow(/two contenders/);
    expect(refuse({ contenders: [{ name: "a", provider: "gpt" }] })).toThrow(/not one of/);
    expect(refuse({ contenders: [{ name: "a", model: "" }] })).toThrow(/non-empty string/);
  });

  test("assertContenderKeys names every contender whose key is unset", () => {
    const contender = (name: string, provider: string) => ({
      name,
      provider,
      model: "m",
      effort: null,
      promptFile: "p",
      promptSha: "s",
    });
    const config = {
      repoSlug: "acme/widget",
      providerEnv: { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_KEY", cursor: "CURSOR_API_KEY" },
    };
    expect(() =>
      assertContenderKeys({
        contenders: [contender("a", "claude"), contender("b", "codex")],
        config,
        env: { ANTHROPIC_API_KEY: "k", OPENAI_KEY: " " },
      }),
    ).toThrow(/a contender on acme\/widget:\n {2}b: codex needs OPENAI_KEY/);
    expect(() =>
      assertContenderKeys({
        contenders: [contender("a", "claude")],
        config,
        env: { ANTHROPIC_API_KEY: "k" },
      }),
    ).not.toThrow();
  });

  test("parseSuite refuses a suite for another repo, or none at all", () => {
    const fixture = {
      issue: { number: 7, title: "t", body: "b", comments: [] },
      pr: { number: 8, headSha: "a".repeat(40), mergeSha: "b".repeat(40) },
      baseSha: "c".repeat(40),
    };
    const selectedAt = "2026-11-25T00:00:00.000Z";
    const suite = JSON.stringify({
      v: 1,
      repo: "acme/widget",
      selectedAt,
      fixtures: [fixture],
      skipped: [],
    });
    expect(() =>
      parseSuite(
        JSON.stringify({ v: 1, repo: "acme/widget", selectedAt, fixtures: [{}] }),
        "acme/widget",
      ),
    ).toThrow(/Fixture 0 .* no issue/);
    expect(parseSuite(suite, "acme/widget").repo).toBe("acme/widget");
    expect(() => parseSuite(suite, "acme/gadget")).toThrow(/for acme\/widget, not acme\/gadget/);
    expect(() => parseSuite("{", "acme/widget")).toThrow(/not JSON/);
    expect(() => parseSuite('{"v":2}', "acme/widget")).toThrow(/expected `v: 1`/);
    expect(() =>
      parseSuite(
        JSON.stringify({ v: 1, repo: "acme/widget", selectedAt, fixtures: [] }),
        "acme/widget",
      ),
    ).toThrow(/no fixtures/);
    expect(() =>
      parseSuite(JSON.stringify({ v: 1, repo: "acme/widget", fixtures: [fixture] }), "acme/widget"),
    ).toThrow(/selectedAt/);
  });
});
