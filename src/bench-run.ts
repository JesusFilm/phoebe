// `phoebe bench run <suite>` (#940, #941; spec #925, decisions #921): replay
// every fixture in a suite with every contender, `repeat` times each, offline,
// record each trial under `bench/<runId>/`, and end with a report.
//
// The contenders come from a bench config the operator keeps. Each sets any of
// `provider`, `model`, `effort` and `promptFile`; the tenant's `issues`
// settings fill the rest. With no bench config the one contender is the
// tenant's own settings.
//
// Before any trial, every fixture's baseline (#988) runs, `concurrency` at a
// time: the merged PR's head, checked out of the hub clone into a tree of its
// own, through `installCommand`, `checkCommand` and `testCommand` with no agent.
// A fixture whose baseline fails is unstable for the run, and none of its
// trials run: a result nobody can score is not worth the agent's money.
//
// A trial is one contender replaying one fixture once:
//
//   1. A fresh repository holding the history up to `baseSha`, fetched from the
//      hub clone, with no remote. Nothing the agent pushes can go anywhere, and
//      the merged PR it is being compared against is not in it.
//   2. A trial-scoped HOME with nothing in it but a git identity, and a `gh` on
//      PATH that serves the issue from the suite's snapshot and records every
//      write as "would have" (src/bench-gh-shim.ts).
//   3. `installCommand`, then the agent under the tenant's `issues` run budget,
//      with an environment that holds no GitHub credential. Provider keys pass
//      as they do in production.
//   4. When the agent left commits: `checkCommand`, then `testCommand`, run by
//      bench itself so a result never depends on what the agent claimed. The
//      first failure stops the gates. No commits is "no change" and no gates.
//   5. One line in `trials.jsonl` — a unit record under the `bench` pipeline,
//      plus the fixture, contender, repeat, gates, diff and would-have writes —
//      and the patch, when there are commits. Then the trial's tree goes.
//   6. When the bench config names a judge and the trial left commits, one
//      judge run compares the patch with the merged PR (src/bench-judge.ts),
//      after the trial's clock has stopped. Its verdict and usage go on the
//      line's `judgement`, apart from the contender's own.
//
// Nothing here writes to a pipeline's `units.jsonl` and nothing reaches
// GitHub: the engine's push and PR code never runs. "Offline" means exactly
// that, cut off from GitHub. Trials keep outbound network, which the provider
// API and the package registry need.

import { execSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { buildAgentEnv } from "./agent-env.ts";
import {
  GH_SHIM_SNAPSHOT_FILE,
  GH_SHIM_WOULD_HAVE_FILE,
  type GhShimSnapshot,
} from "./bench-gh-shim.ts";
import { judgeTrial, parseBenchJudge } from "./bench-judge.ts";
import {
  baselineFailure,
  buildBenchReport,
  describeBaselineFailure,
  REPORT_FILE,
} from "./bench-report.ts";
import {
  DEFAULT_PIPELINE_NAME,
  PROVIDER_NAMES,
  type PhoebeConfig,
  type ProviderName,
} from "./config-schema.ts";
import type {
  BenchBaselineGate,
  BenchConfig,
  BenchContender,
  BenchContenderSpec,
  BenchDiffStats,
  BenchFixture,
  BenchGateResult,
  BenchGates,
  BenchJudge,
  BenchJudgement,
  BenchRunConfig,
  BenchSuite,
  BenchTrial,
  BenchWouldHave,
} from "./contracts/bench.ts";
import type { BenchReport, BenchUnstableFixture } from "./contracts/bench-report.ts";
import { UNIT_RECORD_VERSION, type UnitRecordOutcome } from "./contracts/unit-record.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import { pipelineOwnedKinds, selectPipeline } from "./pipeline.ts";
import { outputLines } from "./prefixed-output.ts";
import { buildDefaultPromptArgs, loadPromptTemplate, renderPrompt } from "./prompt.ts";
import { selectProviderForKind } from "./provider-selection.ts";
import { PROVIDERS } from "./providers/providers.ts";
import { runAgent, type SpawnAgent } from "./providers/run-agent.ts";
import { costBasisFor } from "./providers/usage.ts";
import { resolveRunTimeoutMsForKind, RunTimeoutError, runWithDeadline } from "./run-timeout.ts";
import { kindEnvNames, settingAt } from "./settings-catalogue.ts";
import { buildInstallCommandEnv, buildPromptShellEnv } from "./shell-env.ts";
import {
  agentRunRecord,
  capDetail,
  promptShaOf,
  readEngineCommit,
  type AgentRunTrack,
} from "./unit-record.ts";

/** The directory every run lives under, beside the tenant's `state/`. */
export const BENCH_DIR = "bench";

/** How many run directories a tenant keeps, the new one included. */
export const BENCH_RUNS_KEPT = 10;

/** The pipeline a trial's record names, which no real pipeline can take. */
export const BENCH_PIPELINE = "bench";

/** The one contender a run without a bench config has. */
export const TENANT_CONTENDER = "tenant";

export const TRIALS_FILE = "trials.jsonl";
export const RUN_CONFIG_FILE = "config.json";
export { REPORT_FILE };
export const PATCHES_DIR = "patches";
/** Where the trials' trees live while they run; removed after each. */
export const WORK_DIR = "work";
/** The prefix of the directory under `bench/` where `bench select` runs baselines; removed after. */
export const SELECT_WORK_DIR = "select-work";

/** The `gh` shim a trial or baseline runs, beside this module. */
export const DEFAULT_GH_SHIM_PATH = join(import.meta.dirname, "bench-gh-shim.ts");

/** A gate's ceiling, the one production gives `installCommand`. */
export const GATE_TIMEOUT_MS = 600_000;

/** Prompt `!` expansions get the same ceiling production gives them. */
const PROMPT_SHELL_TIMEOUT_MS = 600_000;

/** Env names that carry a GitHub credential. None reaches a trial. */
export function isGitHubCredentialKey(key: string): boolean {
  return (
    key === "GH_TOKEN" ||
    key === "GITHUB_TOKEN" ||
    key === "GH_ENTERPRISE_TOKEN" ||
    key === "GITHUB_ENTERPRISE_TOKEN" ||
    key.startsWith("GH_APP_")
  );
}

/** Env names that point git at a config or credential helper other than the trial's. */
function isGitConfigInjection(key: string): boolean {
  return (
    key === "GIT_ASKPASS" ||
    key === "GIT_CONFIG_GLOBAL" ||
    key === "GIT_CONFIG_COUNT" ||
    key === "GIT_CONFIG_PARAMETERS" ||
    key.startsWith("GIT_CONFIG_KEY_") ||
    key.startsWith("GIT_CONFIG_VALUE_")
  );
}

function withoutGitHub(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isGitHubCredentialKey(key) && !isGitConfigInjection(key)) out[key] = value;
  }
  return out;
}

/** `<dataBase>/<owner>/<repo>/bench`, beside the tenant's `state/`. */
export function benchRoot(config: Pick<PhoebeConfig, "paths">): string {
  return join(dirname(config.paths.stateDir), BENCH_DIR);
}

/** What `newRunId` writes; `bench/` also holds suite files and anything else an operator saves. */
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** A run id that sorts by start time: `2026-11-25T12-00-00-000Z`. */
export function newRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Make room for a new run: delete every run directory but the newest
 * `keep - 1`, so the tenant holds `keep` once the new one exists. Run ids sort
 * by start time, so the newest are the last by name. Returns what it removed.
 */
export function pruneRuns(root: string, keep: number = BENCH_RUNS_KEPT): string[] {
  if (!existsSync(root)) return [];
  const runs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const doomed = runs.slice(0, Math.max(0, runs.length - (keep - 1)));
  for (const name of doomed) rmSync(join(root, name), { recursive: true, force: true });
  return doomed;
}

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const isText = (value: unknown): boolean => typeof value === "string";
const isSha = (value: unknown): boolean =>
  typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value);

/** What is wrong with a fixture, in the fields a trial and the shim read; `null` when nothing is. */
function fixtureProblem(fixture: unknown): string | null {
  const f = fixture as Partial<BenchFixture> | null;
  if (f === null || typeof f !== "object") return "not an object";
  const { issue, pr } = f;
  if (issue === undefined || issue === null || typeof issue !== "object") return "no issue";
  if (!isCount(issue.number)) return "issue.number is not a positive integer";
  if (!isText(issue.title) || !isText(issue.body))
    return "issue.title and issue.body must be strings";
  if (!Array.isArray(issue.comments)) return "issue.comments is not a list";
  for (const comment of issue.comments as unknown[]) {
    const c = comment as { body?: unknown; createdAt?: unknown; author?: unknown } | null;
    if (c === null || typeof c !== "object" || !isText(c.body) || !isText(c.createdAt)) {
      return "an issue comment lacks a body or createdAt";
    }
    if (c.author !== null && c.author !== undefined && !isText(c.author)) {
      return "an issue comment's author is not a string";
    }
  }
  if (pr === undefined || pr === null || typeof pr !== "object") return "no pr";
  if (!isCount(pr.number)) return "pr.number is not a positive integer";
  if (!isSha(pr.headSha) || !isSha(pr.mergeSha))
    return "pr.headSha and pr.mergeSha must be commit ids";
  if (!isSha(f.baseSha)) return "baseSha is not a commit id";
  if (f.baselinePassedAt !== undefined && !isText(f.baselinePassedAt)) {
    return "baselinePassedAt is not a string";
  }
  return null;
}

/** Read a suite file, refusing one this engine would misread. */
export function parseSuite(text: string, repoSlug: string): BenchSuite {
  let suite: unknown;
  try {
    suite = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The suite is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const s = suite as Partial<BenchSuite> | null;
  if (s === null || typeof s !== "object" || s.v !== 1 || !Array.isArray(s.fixtures)) {
    throw new Error(
      "The suite is not one `phoebe bench select` wrote (expected `v: 1` and `fixtures`).",
    );
  }
  if (s.repo !== repoSlug) {
    throw new Error(`The suite is for ${String(s.repo)}, not ${repoSlug}.`);
  }
  if (typeof s.selectedAt !== "string" || Number.isNaN(Date.parse(s.selectedAt))) {
    throw new Error("The suite has no valid `selectedAt` timestamp.");
  }
  if (s.fixtures.length === 0) throw new Error("The suite has no fixtures.");
  s.fixtures.forEach((fixture, index) => {
    const problem = fixtureProblem(fixture);
    if (problem !== null)
      throw new Error(`Fixture ${index} in the suite is malformed: ${problem}.`);
  });
  return s as BenchSuite;
}

/** What one gate is handed: its command, its tree, its env and the interrupt. */
export type RunGate = (opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  echo: (line: string) => void;
}) => Promise<BenchGateResult>;

/** Run a gate in a shell, streaming its lines, and say how it exited. Never rejects. */
export const defaultRunGate: RunGate = (opts) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", kill);
      resolve({ command: opts.command, exitCode, durationMs: Date.now() - started });
    };
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null);
    };
    const timer = setTimeout(kill, GATE_TIMEOUT_MS);
    timer.unref?.();
    if (opts.signal.aborted) kill();
    else opts.signal.addEventListener("abort", kill, { once: true });
    const take = (chunk: Buffer | string): void => {
      for (const line of outputLines(chunk.toString())) opts.echo(line);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code));
  });

export type BenchRunDeps = {
  git?: GitRunner;
  spawnAgent?: SpawnAgent;
  runGate?: RunGate;
  now?: () => Date;
  log?: (line: string) => void;
  /** The file the trial's `gh` runs; the shim beside this module by default. */
  ghShimPath?: string;
  engineCommit?: string | null;
};

/** What every trial of a run shares, resolved once. */
type RunPlan = {
  runId: string;
  runDir: string;
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  runTimeoutMs: number;
  engineCommit: string | null;
  /** `null` when the bench config names no judge. */
  judge: BenchJudge | null;
};

/** A contender with the prompt template it renders. */
export type ResolvedContender = { contender: BenchContender; template: string };

/** One trial's settings: the run's, and its contender's. */
type TrialPlan = RunPlan & ResolvedContender;

type TrialDirs = { root: string; repo: string; home: string; bin: string; gh: string };

/** Interrupted mid-trial: the trial is dropped, not recorded. */
class TrialInterrupted extends Error {}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The agent's environment: production's allowlist with the GitHub credential
 * taken out, HOME and the gh config pointed into the trial, the shim first on
 * PATH, and the system git config (where a credential helper would sit) off.
 */
export function trialAgentEnv(opts: {
  parentEnv: NodeJS.ProcessEnv;
  config: Pick<PhoebeConfig, "providerEnv">;
  provider: keyof PhoebeConfig["providerEnv"];
  dirs: Pick<TrialDirs, "home" | "bin">;
}): Record<string, string> {
  const env = buildAgentEnv({
    parentEnv: withoutGitHub(opts.parentEnv),
    provider: opts.provider,
    providerEnv: opts.config.providerEnv,
  });
  return { ...env, ...trialOverlay(opts.dirs, env["PATH"]) };
}

function trialOverlay(
  dirs: Pick<TrialDirs, "home" | "bin">,
  path: string | undefined,
): Record<string, string> {
  return {
    HOME: dirs.home,
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    GH_CONFIG_DIR: join(dirs.home, ".config", "gh"),
    PATH: path !== undefined && path !== "" ? `${dirs.bin}:${path}` : dirs.bin,
    GIT_CONFIG_GLOBAL: join(dirs.home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The env prompt `!` expansions run under: production's, minus GitHub, in the trial. */
function trialPromptShellEnv(
  parentEnv: NodeJS.ProcessEnv,
  config: PhoebeConfig,
  dirs: TrialDirs,
): NodeJS.ProcessEnv {
  const env = buildPromptShellEnv(withoutGitHub(parentEnv), Object.values(config.providerEnv));
  return { ...env, ...trialOverlay(dirs, env["PATH"]) };
}

/**
 * The env the gates run under: production's `installCommand` env (no GitHub
 * credential, no provider key) with the shim first on PATH. HOME stays the
 * image's, so the package manager's store is shared across trials.
 */
function trialGateEnv(
  parentEnv: NodeJS.ProcessEnv,
  config: PhoebeConfig,
  dirs: TrialDirs,
): NodeJS.ProcessEnv {
  const env = buildInstallCommandEnv(withoutGitHub(parentEnv), Object.values(config.providerEnv));
  const path = env["PATH"];
  return {
    ...env,
    GH_CONFIG_DIR: join(dirs.home, ".config", "gh"),
    GIT_CONFIG_GLOBAL: join(dirs.home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: path !== undefined && path !== "" ? `${dirs.bin}:${path}` : dirs.bin,
  };
}

function gitIdentity(git: GitRunner, repoDir: string): { name: string; email: string } {
  const read = (key: string): string | null => {
    try {
      const value = git(["config", "--get", key], { cwd: repoDir, stdio: "pipe" }).trim();
      return value === "" ? null : value;
    } catch {
      return null;
    }
  };
  return {
    name: read("user.name") ?? "Phoebe",
    email: read("user.email") ?? "phoebe@bench.invalid",
  };
}

/** Fetch the fixture's PR head and the default branch into the hub when it lacks `sha`. */
function ensureInHub(
  git: GitRunner,
  config: PhoebeConfig,
  fixture: BenchFixture,
  sha: string,
): void {
  const hub = config.paths.repoDir;
  try {
    git(["cat-file", "-e", `${sha}^{commit}`], { cwd: hub, stdio: "ignore" });
    return;
  } catch {
    // Not there: fetch it below.
  }
  git(
    [
      "fetch",
      "--quiet",
      "--no-write-fetch-head",
      "origin",
      `refs/pull/${fixture.pr.number}/head`,
      config.defaultBranch,
    ],
    { cwd: hub, stdio: "pipe" },
  );
}

/**
 * A fresh repository at `root/repo` holding the history up to `sha` and
 * nothing else. `init` and a fetch by commit rather than a clone: a clone would
 * carry the hub's refs and objects past `sha`, and a remote to push to.
 */
function freshRepo(opts: {
  git: GitRunner;
  config: PhoebeConfig;
  dir: string;
  sha: string;
  /** The branch checked out at `sha`; detached when absent. */
  branch?: string;
}): void {
  const { git, config, dir, sha } = opts;
  git(["init", "--quiet", "-b", config.defaultBranch, dir], { stdio: "pipe" });
  git(["fetch", "--quiet", "--no-tags", config.paths.repoDir, sha], { cwd: dir, stdio: "pipe" });
  if (opts.branch === undefined) {
    git(["checkout", "--quiet", "--detach", sha], { cwd: dir, stdio: "pipe" });
  } else {
    git(["branch", config.defaultBranch, sha], { cwd: dir, stdio: "pipe" });
    git(["checkout", "--quiet", "-b", opts.branch, sha], { cwd: dir, stdio: "pipe" });
  }
  rmSync(join(dir, ".git", "FETCH_HEAD"), { force: true });
}

function sandboxDirs(root: string): TrialDirs {
  return {
    root,
    repo: join(root, "repo"),
    home: join(root, "home"),
    bin: join(root, "bin"),
    gh: join(root, "gh"),
  };
}

/**
 * Lay out one trial: its repository at `baseSha` with no remote, its HOME, and
 * the `gh` shim with the fixture's snapshot.
 */
function prepareTrial(opts: {
  plan: TrialPlan;
  fixture: BenchFixture;
  trialId: string;
  git: GitRunner;
  ghShimPath: string;
}): TrialDirs {
  const { plan, fixture, git } = opts;
  const { config } = plan;
  const dirs = sandboxDirs(join(plan.runDir, WORK_DIR, opts.trialId));
  rmSync(dirs.root, { recursive: true, force: true });
  ensureInHub(git, config, fixture, fixture.baseSha);
  freshRepo({
    git,
    config,
    dir: dirs.repo,
    sha: fixture.baseSha,
    branch: `${config.branchPrefix}issue-${fixture.issue.number}`,
  });
  prepareSandbox({ config, fixture, dirs, git, ghShimPath: opts.ghShimPath });
  return dirs;
}

/** The HOME with a git identity, and the `gh` shim serving the fixture's snapshot. */
function prepareSandbox(opts: {
  config: PhoebeConfig;
  fixture: BenchFixture;
  dirs: TrialDirs;
  git: GitRunner;
  ghShimPath: string;
}): void {
  const { config, fixture, dirs, git } = opts;
  for (const dir of [dirs.home, dirs.bin, dirs.gh]) mkdirSync(dir, { recursive: true });
  const identity = gitIdentity(git, config.paths.repoDir);
  writeFileSync(
    join(dirs.home, ".gitconfig"),
    `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`,
  );
  const snapshot: GhShimSnapshot = {
    repo: config.repoSlug,
    defaultBranch: config.defaultBranch,
    fixture,
  };
  writeFileSync(join(dirs.gh, GH_SHIM_SNAPSHOT_FILE), JSON.stringify(snapshot));
  writeFileSync(
    join(dirs.bin, "gh"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} --no-warnings ${shellQuote(opts.ghShimPath)} ${shellQuote(dirs.gh)} "$@"\n`,
    { mode: 0o755 },
  );
}

// --- baselines (#988) -------------------------------------------------------

/**
 * A fixture's baseline: check the merged PR's head (`pr.headSha`) out of the
 * hub clone into a fresh tree under `dir`, and run `installCommand`,
 * `checkCommand` and `testCommand` there with no agent. The gates get the
 * trial gates' env, ceiling and shared package store. The first failure stops
 * them. The tree is gone when this returns.
 *
 * The tree is its own repository, so nothing in it reaches a trial's, which
 * still holds the history only up to `baseSha`.
 *
 * Throws when the head cannot be checked out. An interrupt kills the gate in
 * flight, which then has no exit code.
 */
export async function runBaseline(opts: {
  /** The tenant config as the `issues` pipeline sees it. */
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  fixture: BenchFixture;
  dir: string;
  signal: AbortSignal;
  git: GitRunner;
  runGate: RunGate;
  ghShimPath: string;
  log: (line: string) => void;
}): Promise<BenchGates> {
  const { config, fixture, git } = opts;
  const echo = (line: string): void =>
    opts.log(`[phoebe] bench [issue:${fixture.issue.number} baseline] ${line}`);
  const dirs = sandboxDirs(opts.dir);
  const gates: BenchGates = { install: null, check: null, test: null };
  rmSync(dirs.root, { recursive: true, force: true });
  try {
    try {
      ensureInHub(git, config, fixture, fixture.pr.headSha);
      freshRepo({ git, config, dir: dirs.repo, sha: fixture.pr.headSha });
      prepareSandbox({ config, fixture, dirs, git, ghShimPath: opts.ghShimPath });
    } catch (error) {
      throw new Error(
        `could not check out PR #${fixture.pr.number}'s head ${fixture.pr.headSha.slice(0, 7)}: ${errorText(error)}`,
        { cause: error },
      );
    }
    echo(`checking PR #${fixture.pr.number}'s head ${fixture.pr.headSha.slice(0, 7)}, no agent.`);
    const env = trialGateEnv(opts.env, config, dirs);
    for (const [gate, command] of [
      ["install", config.installCommand],
      ["check", config.checkCommand],
      ["test", config.testCommand],
    ] as const) {
      if (opts.signal.aborted) break;
      if (command.trim() === "") continue;
      echo(`$ ${command}`);
      const result = await opts.runGate({
        command,
        cwd: dirs.repo,
        env,
        signal: opts.signal,
        echo,
      });
      gates[gate] = result;
      echo(
        `${command} exited ${result.exitCode ?? "without a code"} after ${result.durationMs}ms.`,
      );
      if (result.exitCode !== 0) break;
    }
    return gates;
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

function readWouldHave(ghDir: string): BenchWouldHave[] {
  const path = join(ghDir, GH_SHIM_WOULD_HAVE_FILE);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as BenchWouldHave];
      } catch {
        return [];
      }
    });
}

function commitCount(git: GitRunner, repo: string, baseSha: string, ref: string): number {
  try {
    return (
      Number(
        git(["rev-list", "--count", `${baseSha}..${ref}`], { cwd: repo, stdio: "pipe" }).trim(),
      ) || 0
    );
  } catch {
    return 0;
  }
}

/** `git diff --shortstat` read into numbers. */
export function parseShortstat(text: string, commits: number): BenchDiffStats {
  const number = (re: RegExp): number => Number(re.exec(text)?.[1] ?? 0);
  return {
    commits,
    filesChanged: number(/(\d+) files? changed/),
    insertions: number(/(\d+) insertions?\(\+\)/),
    deletions: number(/(\d+) deletions?\(-\)/),
  };
}

function headOf(git: GitRunner, repo: string): { branch: string | null; sha: string | null } {
  const read = (args: string[]): string | null => {
    try {
      const out = git(args, { cwd: repo, stdio: "pipe" }).trim();
      return out === "" ? null : out;
    } catch {
      return null;
    }
  };
  const sha = read(["rev-parse", "HEAD"]);
  const branch = sha === null ? null : read(["rev-parse", "--abbrev-ref", "HEAD"]);
  return { sha, branch: branch === "HEAD" ? null : branch };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

/**
 * Run one trial and return its line, or `null` when the interrupt landed while
 * it was in flight. Its tree is gone either way.
 */
async function runTrial(opts: {
  plan: TrialPlan;
  fixture: BenchFixture;
  repeat: number;
  fixtureIndex: number;
  signal: AbortSignal;
  deps: Required<Omit<BenchRunDeps, "engineCommit">>;
}): Promise<BenchTrial | null> {
  const { plan, fixture, fixtureIndex, repeat, signal, deps } = opts;
  const { config, contender } = plan;
  const { git, now } = deps;
  const issue = fixture.issue.number;
  const trialId = `f${fixtureIndex}-issue-${issue}-${contender.name}-${repeat}`;
  const tag = `[phoebe] bench [issue:${issue} ${contender.name}#${repeat}]`;
  const echo = (line: string): void => deps.log(`${tag} ${line}`);
  const startedAt = now();
  const gates: BenchGates = { install: null, check: null, test: null };
  let track: AgentRunTrack | null = null;
  let outcome: UnitRecordOutcome = "completed";
  let detail: string | null = null;
  let dirs: TrialDirs | null = null;
  let commits = 0;
  let diff: BenchDiffStats | null = null;
  let patch: string | null = null;
  let patchText = "";
  let head: { branch: string | null; sha: string | null } = { branch: null, sha: null };
  let wouldHave: BenchWouldHave[] = [];
  const checkInterrupt = (): void => {
    if (signal.aborted) throw new TrialInterrupted();
  };

  try {
    echo(`starting at ${fixture.baseSha.slice(0, 7)} (PR #${fixture.pr.number}).`);
    try {
      dirs = prepareTrial({ plan, fixture, trialId, git, ghShimPath: deps.ghShimPath });
    } catch (error) {
      checkInterrupt();
      outcome = "failed";
      detail = `could not set up the trial at ${fixture.baseSha}: ${errorText(error)}`;
      echo(detail);
      dirs = null;
    }

    if (dirs !== null) {
      const trialDirs = dirs;
      const gateEnv = trialGateEnv(plan.env, config, trialDirs);
      const gate = async (command: string): Promise<BenchGateResult | null> => {
        if (command.trim() === "") return null;
        echo(`$ ${command}`);
        const result = await deps.runGate({
          command,
          cwd: trialDirs.repo,
          env: gateEnv,
          signal,
          echo,
        });
        checkInterrupt();
        echo(
          `${command} exited ${result.exitCode ?? "without a code"} after ${result.durationMs}ms.`,
        );
        return result;
      };
      const passed = (result: BenchGateResult | null): boolean =>
        result === null || result.exitCode === 0;

      gates.install = await gate(config.installCommand);
      if (!passed(gates.install)) {
        outcome = "failed";
        detail = `installCommand exited ${gates.install?.exitCode ?? "without a code"}`;
      } else {
        const provider = PROVIDERS[contender.provider as keyof typeof PROVIDERS];
        const prompt = renderPrompt(
          plan.template,
          {
            ...buildDefaultPromptArgs(config),
            ISSUE_NUMBER: String(issue),
            PR_BASE: config.defaultBranch,
          },
          (command) =>
            execSync(command, {
              cwd: trialDirs.repo,
              env: trialPromptShellEnv(plan.env, config, trialDirs),
              encoding: "utf8",
              timeout: PROMPT_SHELL_TIMEOUT_MS,
            }),
        );
        const agentEnv = trialAgentEnv({
          parentEnv: plan.env,
          config,
          provider: provider.name,
          dirs: trialDirs,
        });
        const meter = provider.meterUsage();
        const run: AgentRunTrack = {
          startedAt: now(),
          promptSha: contender.promptSha,
          costBasis: costBasisFor(provider.name, agentEnv),
          meter,
          endedAt: null,
          exitCode: null,
        };
        track = run;
        try {
          await runWithDeadline({
            ms: plan.runTimeoutMs,
            work: async (deadline) => {
              try {
                const { exitCode } = await runAgent({
                  provider,
                  model: contender.model,
                  ...(contender.effort !== null ? { effort: contender.effort } : {}),
                  prompt,
                  cwd: trialDirs.repo,
                  env: agentEnv,
                  signal: AbortSignal.any([deadline, signal]),
                  tenant: config.repoSlug,
                  pipeline: BENCH_PIPELINE,
                  unit: `issues issue:${issue}`,
                  meter,
                  log: deps.log,
                  spawn: deps.spawnAgent,
                });
                run.exitCode = exitCode;
              } finally {
                run.endedAt = now();
              }
            },
          });
        } catch (error) {
          checkInterrupt();
          if (!(error instanceof RunTimeoutError)) throw error;
          outcome = "timed-out";
          detail = error.message;
        }
        checkInterrupt();

        head = headOf(git, trialDirs.repo);
        commits = commitCount(git, trialDirs.repo, fixture.baseSha, head.sha ?? "HEAD");
        if (outcome === "completed" && run.exitCode !== null && run.exitCode !== 0) {
          outcome = "failed";
          detail = `the agent exited ${run.exitCode}`;
        }
        if (outcome === "completed") {
          if (commits === 0) {
            echo("the agent left no commits: no change, no gates.");
          } else {
            gates.check = await gate(config.checkCommand);
            if (passed(gates.check)) gates.test = await gate(config.testCommand);
            const failed = !passed(gates.check)
              ? "checkCommand"
              : !passed(gates.test)
                ? "testCommand"
                : null;
            if (failed !== null) {
              outcome = "failed";
              detail = `${failed} exited ${(failed === "checkCommand" ? gates.check : gates.test)?.exitCode ?? "without a code"}`;
            }
          }
        }
      }

      if (head.sha === null) head = headOf(git, trialDirs.repo);
      if (commits > 0 && head.sha !== null) {
        diff = parseShortstat(
          git(["diff", "--shortstat", fixture.baseSha, head.sha], {
            cwd: trialDirs.repo,
            stdio: "pipe",
          }),
          commits,
        );
        // One tree diff, not a patch series: a merge commit the agent made to
        // resolve a conflict has no patch of its own, and git writes the file
        // itself so its size is not bounded by a buffer.
        const patchPath = join(PATCHES_DIR, `${trialId}.patch`);
        git(
          [
            "diff",
            "--binary",
            `--output=${join(plan.runDir, patchPath)}`,
            fixture.baseSha,
            head.sha,
          ],
          {
            cwd: trialDirs.repo,
            stdio: "pipe",
          },
        );
        patch = patchPath;
        if (plan.judge !== null) {
          patchText = readFileSync(join(plan.runDir, patchPath), "utf8");
        }
      }
      wouldHave = readWouldHave(trialDirs.gh);
    }
  } catch (error) {
    if (error instanceof TrialInterrupted || signal.aborted) {
      echo("interrupted: dropping this trial.");
      return null;
    }
    outcome = "failed";
    detail = errorText(error);
    echo(`failed: ${detail}`);
    if (dirs !== null && wouldHave.length === 0) wouldHave = readWouldHave(dirs.gh);
  } finally {
    rmSync(join(plan.runDir, WORK_DIR, trialId), { recursive: true, force: true });
  }

  const settledAt = now();
  echo(`${outcome}${detail === null ? "" : `: ${detail}`}.`);

  let judgement: BenchJudgement | null = null;
  if (plan.judge !== null && patch !== null) {
    const judge = plan.judge;
    echo(`judging against PR #${fixture.pr.number} with ${judge.provider} ${judge.model}.`);
    judgement = await judgeTrial({
      judge,
      config,
      agentEnv: (judgeDirs) =>
        trialAgentEnv({
          parentEnv: plan.env,
          config,
          provider: judge.provider as ProviderName,
          dirs: judgeDirs,
        }),
      fixture,
      patch: patchText,
      dir: join(plan.runDir, WORK_DIR, `${trialId}-judge`),
      runTimeoutMs: plan.runTimeoutMs,
      signal,
      git,
      spawnAgent: deps.spawnAgent,
      now,
      log: deps.log,
      unit: `issues issue:${issue}`,
    });
    echo(
      judgement.verdict !== null
        ? `judged ${judgement.verdict}${judgement.rationale === null ? "" : `: ${judgement.rationale}`}`
        : `no verdict: ${judgement.error ?? "unknown"}.`,
    );
  }

  return {
    v: UNIT_RECORD_VERSION,
    tenant: config.repoSlug,
    pipeline: BENCH_PIPELINE,
    unit: { kind: "issues", id: `issue:${issue}` },
    outcome,
    quarantined: false,
    detail: capDetail(detail),
    startedAt: startedAt.toISOString(),
    settledAt: settledAt.toISOString(),
    durationMs: Math.max(0, settledAt.getTime() - startedAt.getTime()),
    runBudgetMs: plan.runTimeoutMs,
    provider: contender.provider,
    model: contender.model,
    effort: contender.effort,
    branch: head.branch,
    headSha: head.sha,
    prNumber: null,
    engineCommit: plan.engineCommit,
    agentRuns: track === null ? [] : [agentRunRecord(track, settledAt)],
    runId: plan.runId,
    fixture: { issue, pr: fixture.pr.number, baseSha: fixture.baseSha },
    contender: contender.name,
    repeat,
    change: commits > 0 ? "committed" : "none",
    gates,
    diff,
    patch,
    wouldHave,
    judgement,
  };
}

/**
 * The tenant config as the pipeline that runs `issues` sees it: that
 * pipeline's `kinds` blocks and prompt paths flattened on, as its engine child
 * flattens them. The default pipeline when none claims the kind.
 */
export function issuesPipelineConfig(config: PhoebeConfig): PhoebeConfig {
  const owner = Object.entries(config.pipelines).find(([name, pipeline]) =>
    pipelineOwnedKinds({ pipelines: config.pipelines, name, pipeline }).includes("issues"),
  );
  return selectPipeline(config, owner?.[0] ?? DEFAULT_PIPELINE_NAME);
}

// --- contenders -------------------------------------------------------------

/** What a contender's name may be: it lands in trial ids and patch file names. */
const CONTENDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENDER_FIELDS = new Set(["name", "provider", "model", "effort", "promptFile"]);
const BENCH_CONFIG_FIELDS = new Set(["contenders", "repeat", "judge"]);

/** Read a bench config, refusing anything it would have to guess at. */
export function parseBenchConfig(text: string, where: string): BenchConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON: ${errorText(error)}`);
  }
  const fail = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("expected an object with `contenders`.");
  }
  const config = raw as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!BENCH_CONFIG_FIELDS.has(key)) {
      fail(`unknown field \`${key}\` (expected ${[...BENCH_CONFIG_FIELDS].join(", ")}).`);
    }
  }
  const repeat = config["repeat"];
  if (
    repeat !== undefined &&
    (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 1)
  ) {
    fail(`\`repeat\` must be a positive whole number (got ${JSON.stringify(repeat)}).`);
  }
  const list = config["contenders"];
  if (!Array.isArray(list) || list.length === 0) fail("`contenders` must list at least one.");
  const names = new Set<string>();
  const contenders = (list as unknown[]).map((entry, i): BenchContenderSpec => {
    const at = `contenders[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return fail(`${at} must be an object with a \`name\`.`);
    }
    const spec = entry as Record<string, unknown>;
    for (const key of Object.keys(spec)) {
      if (!CONTENDER_FIELDS.has(key)) {
        fail(`${at} has unknown field \`${key}\` (expected ${[...CONTENDER_FIELDS].join(", ")}).`);
      }
    }
    const name = spec["name"];
    if (typeof name !== "string" || !CONTENDER_NAME.test(name)) {
      fail(
        `${at}.name must be letters, digits, \`.\`, \`_\` or \`-\` (got ${JSON.stringify(name)}).`,
      );
    }
    if (names.has(name as string)) fail(`two contenders are named \`${String(name)}\`.`);
    names.add(name as string);
    const text = (key: string): string | undefined => {
      const value = spec[key];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.trim() === "") {
        fail(`${at}.${key} must be a non-empty string.`);
      }
      return (value as string).trim();
    };
    const provider = text("provider");
    if (provider !== undefined && !(PROVIDER_NAMES as readonly string[]).includes(provider)) {
      fail(`${at}.provider \`${provider}\` is not one of ${PROVIDER_NAMES.join(", ")}.`);
    }
    const model = text("model");
    const promptFile = text("promptFile");
    const effort = spec["effort"] === null ? null : text("effort");
    return {
      name: name as string,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(promptFile !== undefined ? { promptFile } : {}),
    };
  });
  const judge = config["judge"] === undefined ? undefined : parseBenchJudge(config["judge"], fail);
  return {
    contenders,
    ...(repeat !== undefined ? { repeat: repeat as number } : {}),
    ...(judge !== undefined ? { judge } : {}),
  };
}

const PROVIDER_SETTING = settingAt("defaultProvider");
const MODEL_SETTING = settingAt("model");
const EFFORT_SETTING = settingAt("effort");

/**
 * The env a contender's provider, model and effort resolve under: the tenant's,
 * with each field the contender sets written as the `issues` kind's own env
 * setting. That is the top rung of the production ladder, so a set field wins
 * and an unset one resolves exactly as the tenant's `issues` units would —
 * including the guard that keeps one provider's model away from another's CLI.
 */
function contenderSelectionEnv(
  env: NodeJS.ProcessEnv,
  spec: Pick<BenchContenderSpec, "provider" | "model" | "effort">,
): NodeJS.ProcessEnv {
  const out = { ...env };
  const put = (setting: ReturnType<typeof settingAt>, value: string | undefined): void => {
    if (value === undefined) return;
    const names = kindEnvNames(setting, "issues");
    for (const name of names) delete out[name];
    out[names[0]!] = value;
  };
  put(PROVIDER_SETTING, spec.provider);
  put(MODEL_SETTING, spec.model);
  put(EFFORT_SETTING, typeof spec.effort === "string" ? spec.effort : undefined);
  return out;
}

/**
 * Resolve a run's contenders. Without a bench config there is one, the tenant's
 * own `issues` settings, named `tenant`. A contender's `promptFile` resolves
 * against the deployment directory; the tenant's against its runtime root, as
 * its engine resolves it. Throws on a prompt file that is not there.
 */
export function resolveContenders(opts: {
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  benchConfig: BenchConfig | null;
  runtimeRoot: string;
  deploymentDir: string;
}): ResolvedContender[] {
  const specs: BenchContenderSpec[] = opts.benchConfig?.contenders ?? [{ name: TENANT_CONTENDER }];
  return specs.map((spec) => {
    const selection = selectProviderForKind({
      kind: "issues",
      env: contenderSelectionEnv(opts.env, spec),
      config: opts.config,
    });
    const promptFile = spec.promptFile ?? opts.config.promptFiles.issue;
    const root = spec.promptFile !== undefined ? opts.deploymentDir : opts.runtimeRoot;
    let template: string;
    try {
      template = loadPromptTemplate(promptFile, root);
    } catch (error) {
      throw new Error(`Contender \`${spec.name}\`: ${errorText(error)}`, { cause: error });
    }
    return {
      contender: {
        name: spec.name,
        provider: selection.provider,
        model: selection.model,
        effort: spec.effort === null ? null : (selection.effort ?? null),
        promptFile,
        promptSha: promptShaOf(template),
      },
      template,
    };
  });
}

/**
 * Refuse a run whose contender (or judge) has no provider key to hand its
 * agent. The trial's HOME is its own, so a provider's on-disk login is not
 * there to fall back on: the key the tenant's `providerEnv` names is the only
 * way in.
 */
export function assertContenderKeys(opts: {
  contenders: readonly Pick<BenchContender, "name" | "provider">[];
  config: Pick<PhoebeConfig, "providerEnv" | "repoSlug">;
  env: NodeJS.ProcessEnv;
}): void {
  const missing = opts.contenders.flatMap((contender) => {
    const key = opts.config.providerEnv[contender.provider as ProviderName];
    const value = key === undefined ? undefined : opts.env[key];
    return value !== undefined && value.trim() !== ""
      ? []
      : [`  ${contender.name}: ${contender.provider} needs ${key ?? "a key"}, which is unset`];
  });
  if (missing.length === 0) return;
  throw new Error(
    `No provider key for ${missing.length === 1 ? "a contender" : `${missing.length} contenders`} ` +
      `on ${opts.config.repoSlug}:\n${missing.join("\n")}\n` +
      `Set the key in this tenant's .env or secret store, or point providerEnv at the var that holds it.`,
  );
}

// --- the run ----------------------------------------------------------------

/**
 * Every fixture's baseline, `concurrency` at a time, before any trial. A
 * fixture whose baseline fails is unstable for this run. One the interrupt cut
 * short is neither: the run is stopping, and no trial of it will start.
 */
async function runBaselines(opts: {
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  fixtures: readonly BenchFixture[];
  runDir: string;
  concurrency: number;
  signal: AbortSignal;
  deps: Required<Omit<BenchRunDeps, "engineCommit">>;
}): Promise<{ baselines: Record<string, BenchGates>; unstable: BenchUnstableFixture[] }> {
  const { fixtures, signal, deps } = opts;
  const failures: Array<BenchUnstableFixture | null> = fixtures.map(() => null);
  const gatesOf: Array<BenchGates | null> = fixtures.map(() => null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!signal.aborted && next < fixtures.length) {
      const index = next++;
      const fixture = fixtures[index]!;
      const entry = (gate: BenchBaselineGate, exitCode: number | null): BenchUnstableFixture => ({
        issue: fixture.issue.number,
        pr: fixture.pr.number,
        gate,
        exitCode,
        baselinePassedAt: fixture.baselinePassedAt ?? null,
      });
      let gates: BenchGates;
      try {
        gates = await runBaseline({
          config: opts.config,
          env: opts.env,
          fixture,
          dir: join(opts.runDir, WORK_DIR, `f${index}-issue-${fixture.issue.number}-baseline`),
          signal,
          git: deps.git,
          runGate: deps.runGate,
          ghShimPath: deps.ghShimPath,
          log: deps.log,
        });
      } catch (error) {
        if (signal.aborted) return;
        deps.log(`[phoebe] bench [issue:${fixture.issue.number} baseline] ${errorText(error)}`);
        gatesOf[index] = { install: null, check: null, test: null };
        failures[index] = entry("checkout", null);
        continue;
      }
      if (signal.aborted) return;
      gatesOf[index] = gates;
      const failure = baselineFailure(gates);
      if (failure !== null) failures[index] = entry(failure.gate, failure.exitCode);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, fixtures.length) }, worker));

  const baselines: Record<string, BenchGates> = {};
  fixtures.forEach((fixture, index) => {
    const gates = gatesOf[index];
    if (gates !== null && gates !== undefined) baselines[String(fixture.issue.number)] = gates;
  });
  const unstable = failures.filter((entry): entry is BenchUnstableFixture => entry !== null);
  for (const entry of unstable) {
    deps.log(
      `[phoebe] bench [issue:${entry.issue} baseline] unstable: ${describeBaselineFailure(entry)} ` +
        `on PR #${entry.pr}'s head` +
        `${entry.baselinePassedAt === null ? "" : ` (it passed at ${entry.baselinePassedAt})`}; ` +
        `its trials are skipped.`,
    );
  }
  return { baselines, unstable };
}

export type BenchRunResult = {
  runId: string;
  runDir: string;
  trials: BenchTrial[];
  report: BenchReport;
};

/**
 * Run every fixture's baseline, then replay every stable fixture with every
 * contender, `repeat` times each, up to `concurrency` trials at once. One that
 * fails or times out is recorded and the run goes on. When `signal` fires,
 * the trials in flight are dropped and `report.json` is written with
 * `interrupted: true`.
 *
 * Throws, before any trial, on what would make every trial meaningless: a
 * contender whose prompt file is missing, or a contender or judge whose
 * provider has no key.
 */
export async function runBench(opts: {
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  suite: BenchSuite;
  suitePath: string;
  runtimeRoot: string;
  /** Where a contender's `promptFile` resolves from; the runtime root by default. */
  deploymentDir?: string;
  benchConfig?: BenchConfig | null;
  /** The bench config file as the operator named it, for the record. */
  benchConfigPath?: string | null;
  concurrency?: number;
  signal?: AbortSignal;
  deps?: BenchRunDeps;
}): Promise<BenchRunResult> {
  const { env, suite } = opts;
  const config = issuesPipelineConfig(opts.config);
  const signal = opts.signal ?? new AbortController().signal;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const deps: Required<Omit<BenchRunDeps, "engineCommit">> = {
    git: opts.deps?.git ?? defaultGit,
    spawnAgent:
      opts.deps?.spawnAgent ??
      ((file, args, spawnOpts) =>
        spawn(file, args, { ...spawnOpts, stdio: ["pipe", "pipe", "pipe"] })),
    runGate: opts.deps?.runGate ?? defaultRunGate,
    now: opts.deps?.now ?? (() => new Date()),
    log: opts.deps?.log ?? ((line) => process.stderr.write(`${line}\n`)),
    ghShimPath: opts.deps?.ghShimPath ?? DEFAULT_GH_SHIM_PATH,
  };
  const engineCommit =
    opts.deps?.engineCommit !== undefined
      ? opts.deps.engineCommit
      : readEngineCommit(import.meta.dirname);

  const benchConfig = opts.benchConfig ?? null;
  const contenders = resolveContenders({
    config,
    env,
    benchConfig,
    runtimeRoot: opts.runtimeRoot,
    deploymentDir: opts.deploymentDir ?? opts.runtimeRoot,
  });
  const judge = benchConfig?.judge ?? null;
  assertContenderKeys({
    contenders: [
      ...contenders.map((resolved) => resolved.contender),
      ...(judge === null ? [] : [{ name: "judge", provider: judge.provider }]),
    ],
    config,
    env,
  });
  const runTimeoutMs = resolveRunTimeoutMsForKind({
    kind: "issues",
    env,
    workKinds: config.workKinds,
    configValue: config.runTimeoutMs,
  });

  const root = benchRoot(config);
  const removed = pruneRuns(root);
  if (removed.length > 0) deps.log(`[phoebe] bench: removed ${removed.length} old run(s).`);
  const startedAt = deps.now();
  const runId = newRunId(startedAt);
  const runDir = join(root, runId);
  mkdirSync(join(runDir, PATCHES_DIR), { recursive: true });

  const repeat = benchConfig?.repeat ?? 1;
  const runConfig: BenchRunConfig = {
    v: 1,
    runId,
    repo: config.repoSlug,
    startedAt: startedAt.toISOString(),
    suite: {
      path: opts.suitePath,
      selectedAt: suite.selectedAt,
      fixtures: suite.fixtures.map((fixture) => fixture.issue.number),
    },
    benchConfig: opts.benchConfigPath ?? null,
    contenders: contenders.map((resolved) => resolved.contender),
    repeat,
    judge,
    concurrency,
    runTimeoutMs,
    installCommand: config.installCommand,
    checkCommand: config.checkCommand,
    testCommand: config.testCommand,
    engineCommit,
  };
  writeFileSync(join(runDir, RUN_CONFIG_FILE), `${JSON.stringify(runConfig, null, 2)}\n`);
  deps.log(
    `[phoebe] bench: run ${runId} — ${suite.fixtures.length} fixture(s) × ` +
      `${contenders.length} contender(s) × ${repeat} repeat(s), ${concurrency} at a time, in ${runDir}.`,
  );
  for (const { contender } of contenders) {
    deps.log(
      `[phoebe] bench:   ${contender.name}: ${contender.provider} ${contender.model}` +
        `${contender.effort === null ? "" : ` (${contender.effort})`}, ${contender.promptFile}`,
    );
  }
  if (judge !== null) {
    deps.log(
      `[phoebe] bench:   judge: ${judge.provider} ${judge.model}, on every trial with commits`,
    );
  }

  const { baselines, unstable } = await runBaselines({
    config,
    env,
    fixtures: suite.fixtures,
    runDir,
    concurrency,
    signal,
    deps,
  });
  const unstableIssues = new Set(unstable.map((entry) => entry.issue));

  const shared: RunPlan = { runId, runDir, config, env, runTimeoutMs, engineCommit, judge };
  const queue = suite.fixtures.flatMap((fixture, fixtureIndex) =>
    unstableIssues.has(fixture.issue.number)
      ? []
      : contenders.flatMap((resolved) =>
          Array.from({ length: repeat }, (_, index) => ({
            fixture,
            fixtureIndex,
            resolved,
            repeat: index,
          })),
        ),
  );
  const trials: BenchTrial[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!signal.aborted && next < queue.length) {
      const job = queue[next++]!;
      const trial = await runTrial({
        plan: { ...shared, ...job.resolved },
        fixture: job.fixture,
        fixtureIndex: job.fixtureIndex,
        repeat: job.repeat,
        signal,
        deps,
      });
      if (trial === null) return;
      trials.push(trial);
      appendFileSync(join(runDir, TRIALS_FILE), `${JSON.stringify(trial)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  rmSync(join(runDir, WORK_DIR), { recursive: true, force: true });

  const report = buildBenchReport({
    runConfig,
    trials,
    baselines,
    unstable,
    finishedAt: deps.now(),
    interrupted: signal.aborted,
  });
  writeFileSync(join(runDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  deps.log(
    `[phoebe] bench: ${report.interrupted ? "interrupted after" : "finished"} ` +
      `${report.recorded}/${report.planned} trial(s): ${report.outcomes.completed} completed ` +
      `(${report.outcomes.noChange} with no change), ${report.outcomes.failed} failed, ` +
      `${report.outcomes.timedOut} timed out` +
      `${report.unstable.length === 0 ? "" : `; ${report.unstable.length} fixture(s) unstable`}. ` +
      `${join(runDir, REPORT_FILE)}`,
  );
  return { runId, runDir, trials, report };
}
