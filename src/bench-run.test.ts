// `phoebe bench run` (#940): a real git fixture repo as the hub, a fake agent
// that reports what its trial looked like, and the run's files on disk.

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
  benchRoot,
  BENCH_RUNS_KEPT,
  isGitHubCredentialKey,
  newRunId,
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
import type { BenchRunConfig, BenchRunSummary, BenchSuite, BenchTrial } from "./contracts/bench.ts";
import type { SpawnAgent } from "./providers/run-agent.ts";

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

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

describe("runBench", () => {
  let root: string;
  let runtimeRoot: string;
  let config: PhoebeConfig;
  let baseSha: string;
  let futureSha: string;
  let agentScript: string;
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
      onSpawn(issue);
      return spawn(
        process.execPath,
        [
          agentScript,
          join(reportsDir, `${issue}.json`),
          modes[issue] ?? "none",
          String(issue),
          futureSha,
        ],
        { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] },
      );
    };
  }

  function seen(issue: number): {
    env: Record<string, string>;
    remotes: string;
    credentialHelper: unknown;
    hasFuture: unknown;
    issue: { number: number; title: string };
    prCreate: string;
    push: unknown;
    prompt: string;
  } {
    return JSON.parse(readFileSync(join(reportsDir, `${issue}.json`), "utf8"));
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
    } = {},
  ) {
    const lines: string[] = [];
    const result = await runBench({
      config,
      env: { ...PARENT_ENV, ...extra.env },
      suite: suite(...issues),
      suitePath: "bench/suite.json",
      runtimeRoot,
      ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
      deps: {
        spawnAgent: fakeAgent(modes, extra.onSpawn),
        log: (line) => lines.push(line),
        engineCommit: "e".repeat(40),
      },
    });
    return { ...result, lines };
  }

  test("a trial's agent holds no GitHub credential, its clone has no remote, and gh is the shim", async () => {
    const { trials } = await run([7], { 7: "commit" });
    const inside = seen(7);

    expect(Object.keys(inside.env).filter(isGitHubCredentialKey)).toEqual([]);
    expect(inside.env["ANTHROPIC_API_KEY"]).toBe("provider-key-for-test");
    expect(inside.env["HOME"]).toContain(join(WORK_DIR, "issue-7-tenant-0", "home"));
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
    const { runDir, trials, summary } = await run([7, 8], { 7: "commit", 8: "none" });

    expect(trialsOf(runDir)).toEqual(trials);
    const [fixed, untouched] = trials;
    expect(fixed).toMatchObject({
      v: 1,
      tenant: "acme/widget",
      pipeline: "bench",
      unit: { kind: "issues", id: "issue:7" },
      outcome: "completed",
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
      patch: "patches/issue-7-tenant-0.patch",
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
    expect(readdirSync(join(runDir, "patches"))).toEqual(["issue-7-tenant-0.patch"]);

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
    expect(summary).toMatchObject({
      interrupted: false,
      planned: 2,
      recorded: 2,
      outcomes: { completed: 2, failed: 0, timedOut: 0, noChange: 1 },
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
      [7, "completed"],
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
      [7, "completed"],
    ]);
    expect(result.trials[0]!.detail).toMatch(/could not set up the trial/);
  });

  test("an interrupt drops the trial in flight and leaves a partial report", async () => {
    const controller = new AbortController();
    const { runDir, trials, summary } = await run(
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
    const report = JSON.parse(readFileSync(join(runDir, REPORT_FILE), "utf8")) as BenchRunSummary;
    expect(report).toEqual(summary);
    expect(report).toMatchObject({ interrupted: true, planned: 3, recorded: 1 });
    expect(existsSync(join(runDir, WORK_DIR))).toBe(false);
    expect(existsSync(join(reportsDir, "9.json"))).toBe(false);
  }, 20_000);

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

  test("parseSuite refuses a suite for another repo, or none at all", () => {
    const fixture = {
      issue: { number: 7, title: "t", body: "b", comments: [] },
      pr: { number: 8, headSha: "a".repeat(40), mergeSha: "b".repeat(40) },
      baseSha: "c".repeat(40),
    };
    const suite = JSON.stringify({ v: 1, repo: "acme/widget", fixtures: [fixture], skipped: [] });
    expect(() =>
      parseSuite(JSON.stringify({ v: 1, repo: "acme/widget", fixtures: [{}] }), "acme/widget"),
    ).toThrow(/Fixture 0 .* no issue/);
    expect(parseSuite(suite, "acme/widget").repo).toBe("acme/widget");
    expect(() => parseSuite(suite, "acme/gadget")).toThrow(/for acme\/widget, not acme\/gadget/);
    expect(() => parseSuite("{", "acme/widget")).toThrow(/not JSON/);
    expect(() => parseSuite('{"v":2}', "acme/widget")).toThrow(/expected `v: 1`/);
    expect(() =>
      parseSuite(JSON.stringify({ v: 1, repo: "acme/widget", fixtures: [] }), "acme/widget"),
    ).toThrow(/no fixtures/);
  });
});
