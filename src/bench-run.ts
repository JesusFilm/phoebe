// `phoebe bench run <suite>` (#940; spec #925, decisions #921): replay every
// fixture in a suite with one contender — the tenant's own `issues` settings —
// offline, and record each trial under `bench/<runId>/`.
//
// A trial is one fixture replayed once:
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
//
// Nothing here writes to a pipeline's `units.jsonl` and nothing reaches
// GitHub: the engine's push and PR code never runs.

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
import { DEFAULT_PIPELINE_NAME, type PhoebeConfig } from "./config-schema.ts";
import type {
  BenchContender,
  BenchDiffStats,
  BenchFixture,
  BenchGateResult,
  BenchGates,
  BenchRunConfig,
  BenchRunSummary,
  BenchSuite,
  BenchTrial,
  BenchWouldHave,
} from "./contracts/bench.ts";
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
export const REPORT_FILE = "report.json";
export const PATCHES_DIR = "patches";
/** Where the trials' trees live while they run; removed after each. */
export const WORK_DIR = "work";

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

/** One trial's settings, resolved once for the run. */
type TrialPlan = {
  runId: string;
  runDir: string;
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  contender: BenchContender;
  template: string;
  runTimeoutMs: number;
  engineCommit: string | null;
};

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
  return { ...env, PATH: path !== undefined && path !== "" ? `${dirs.bin}:${path}` : dirs.bin };
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
  const root = join(plan.runDir, WORK_DIR, opts.trialId);
  const dirs: TrialDirs = {
    root,
    repo: join(root, "repo"),
    home: join(root, "home"),
    bin: join(root, "bin"),
    gh: join(root, "gh"),
  };
  rmSync(root, { recursive: true, force: true });
  for (const dir of [dirs.home, dirs.bin, dirs.gh]) mkdirSync(dir, { recursive: true });

  const hub = config.paths.repoDir;
  const has = (): boolean => {
    try {
      git(["cat-file", "-e", `${fixture.baseSha}^{commit}`], { cwd: hub, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!has()) {
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

  // `init` and a fetch by commit rather than a clone: a clone would carry the
  // hub's refs and objects past `baseSha`, the merged PR among them, and a
  // remote to push to.
  git(["init", "--quiet", "-b", config.defaultBranch, dirs.repo], { stdio: "pipe" });
  git(["fetch", "--quiet", "--no-tags", hub, fixture.baseSha], { cwd: dirs.repo, stdio: "pipe" });
  git(["branch", config.defaultBranch, fixture.baseSha], { cwd: dirs.repo, stdio: "pipe" });
  git(
    [
      "checkout",
      "--quiet",
      "-b",
      `${config.branchPrefix}issue-${fixture.issue.number}`,
      fixture.baseSha,
    ],
    {
      cwd: dirs.repo,
      stdio: "pipe",
    },
  );
  rmSync(join(dirs.repo, ".git", "FETCH_HEAD"), { force: true });

  const identity = gitIdentity(git, hub);
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
  return dirs;
}

function readWouldHave(ghDir: string): BenchWouldHave[] {
  const path = join(ghDir, GH_SHIM_WOULD_HAVE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
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
  signal: AbortSignal;
  deps: Required<Omit<BenchRunDeps, "engineCommit">>;
}): Promise<BenchTrial | null> {
  const { plan, fixture, repeat, signal, deps } = opts;
  const { config, contender } = plan;
  const { git, now } = deps;
  const issue = fixture.issue.number;
  const trialId = `issue-${issue}-${contender.name}-${repeat}`;
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

/** The tenant's own `issues` settings, as the one contender. */
export function tenantContender(opts: {
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  runtimeRoot: string;
}): { contender: BenchContender; template: string } {
  const selection = selectProviderForKind({ kind: "issues", env: opts.env, config: opts.config });
  const promptFile = opts.config.promptFiles.issue;
  const template = loadPromptTemplate(promptFile, opts.runtimeRoot);
  return {
    contender: {
      name: TENANT_CONTENDER,
      provider: selection.provider,
      model: selection.model,
      effort: selection.effort ?? null,
      promptFile,
      promptSha: promptShaOf(template),
    },
    template,
  };
}

export type BenchRunResult = {
  runId: string;
  runDir: string;
  trials: BenchTrial[];
  summary: BenchRunSummary;
};

/** Count what the run recorded. */
export function summarize(opts: {
  runId: string;
  repo: string;
  startedAt: Date;
  finishedAt: Date;
  interrupted: boolean;
  planned: number;
  trials: readonly BenchTrial[];
}): BenchRunSummary {
  const { trials } = opts;
  const count = (outcome: UnitRecordOutcome): number =>
    trials.filter((t) => t.outcome === outcome).length;
  return {
    v: 1,
    runId: opts.runId,
    repo: opts.repo,
    startedAt: opts.startedAt.toISOString(),
    finishedAt: opts.finishedAt.toISOString(),
    interrupted: opts.interrupted,
    planned: opts.planned,
    recorded: trials.length,
    outcomes: {
      completed: count("completed"),
      failed: count("failed"),
      timedOut: count("timed-out"),
      noChange: trials.filter((t) => t.outcome === "completed" && t.change === "none").length,
    },
  };
}

/**
 * Replay every fixture once with the tenant's `issues` settings. Trials run one
 * at a time; one that fails or times out is recorded and the run goes on. When
 * `signal` fires, the trial in flight is dropped and `report.json` is written
 * with `interrupted: true`.
 */
export async function runBench(opts: {
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  suite: BenchSuite;
  suitePath: string;
  runtimeRoot: string;
  signal?: AbortSignal;
  deps?: BenchRunDeps;
}): Promise<BenchRunResult> {
  const { env, suite } = opts;
  const config = issuesPipelineConfig(opts.config);
  const signal = opts.signal ?? new AbortController().signal;
  const deps: Required<Omit<BenchRunDeps, "engineCommit">> = {
    git: opts.deps?.git ?? defaultGit,
    spawnAgent:
      opts.deps?.spawnAgent ??
      ((file, args, spawnOpts) =>
        spawn(file, args, { ...spawnOpts, stdio: ["pipe", "pipe", "pipe"] })),
    runGate: opts.deps?.runGate ?? defaultRunGate,
    now: opts.deps?.now ?? (() => new Date()),
    log: opts.deps?.log ?? ((line) => process.stderr.write(`${line}\n`)),
    ghShimPath: opts.deps?.ghShimPath ?? join(import.meta.dirname, "bench-gh-shim.ts"),
  };
  const engineCommit =
    opts.deps?.engineCommit !== undefined
      ? opts.deps.engineCommit
      : readEngineCommit(import.meta.dirname);

  const { contender, template } = tenantContender({ config, env, runtimeRoot: opts.runtimeRoot });
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

  const repeat = 1;
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
    contenders: [contender],
    repeat,
    runTimeoutMs,
    installCommand: config.installCommand,
    checkCommand: config.checkCommand,
    testCommand: config.testCommand,
    engineCommit,
  };
  writeFileSync(join(runDir, RUN_CONFIG_FILE), `${JSON.stringify(runConfig, null, 2)}\n`);
  deps.log(
    `[phoebe] bench: run ${runId} — ${suite.fixtures.length} fixture(s), ` +
      `${contender.provider} ${contender.model}${contender.effort === null ? "" : ` (${contender.effort})`}, ` +
      `in ${runDir}.`,
  );

  const plan: TrialPlan = {
    runId,
    runDir,
    config,
    env,
    contender,
    template,
    runTimeoutMs,
    engineCommit,
  };
  const trials: BenchTrial[] = [];
  const planned = suite.fixtures.length * repeat;
  for (const fixture of suite.fixtures) {
    for (let index = 0; index < repeat; index++) {
      if (signal.aborted) break;
      const trial = await runTrial({ plan, fixture, repeat: index, signal, deps });
      if (trial === null) break;
      trials.push(trial);
      appendFileSync(join(runDir, TRIALS_FILE), `${JSON.stringify(trial)}\n`);
    }
    if (signal.aborted) break;
  }
  rmSync(join(runDir, WORK_DIR), { recursive: true, force: true });

  const summary = summarize({
    runId,
    repo: config.repoSlug,
    startedAt,
    finishedAt: deps.now(),
    interrupted: signal.aborted,
    planned,
    trials,
  });
  writeFileSync(join(runDir, REPORT_FILE), `${JSON.stringify(summary, null, 2)}\n`);
  deps.log(
    `[phoebe] bench: ${summary.interrupted ? "interrupted after" : "finished"} ` +
      `${summary.recorded}/${planned} trial(s): ${summary.outcomes.completed} completed ` +
      `(${summary.outcomes.noChange} with no change), ${summary.outcomes.failed} failed, ` +
      `${summary.outcomes.timedOut} timed out. ${join(runDir, REPORT_FILE)}`,
  );
  return { runId, runDir, trials, summary };
}
