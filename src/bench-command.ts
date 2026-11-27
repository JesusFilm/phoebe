// `phoebe bench` — the offline replay benchmark's CLI (#939; spec #925). Three
// subcommands: `select` pins a suite of fixtures from issues Phoebe already
// solved and prints it as JSON on stdout; `run <suite>` (#940, #941) replays
// every fixture offline with every contender the bench config names (or the
// tenant's own `issues` settings), records each trial under the tenant's
// `bench/<runId>/` (src/bench-run.ts) and prints the report; `report <runId>`
// prints a saved run's report again (src/bench-report.ts).
//
// Two arms, picked by the container marker as `status` picks its own:
//
//   - In the container it does the work: resolve the tenant, then either read
//     GitHub with the tenant's token and compute each fixture's `baseSha` in
//     the hub clone (`select`), run the trials (`run`), or read a saved
//     report (`report`).
//   - On the host it starts a one-off container from the deployment's image
//     (`docker compose run --rm`, the way `--run-once` runs), with the same
//     arguments, and passes its stdout through untouched. It takes none of the
//     fleet's slots and needs the long-lived container neither up nor down.
//
// Selection reads GitHub and never writes to it. A run's trials have no
// credential and no remote, but they keep outbound network: "offline" means cut
// off from GitHub, not from the provider API or the package registry.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import {
  computeBaseSha,
  DEFAULT_SELECT_LIMIT,
  selectSuite,
  type BenchSelectBaseline,
  type BenchSelectGitHub,
  type BenchSelectRequest,
} from "./bench-select.ts";
import {
  everyFixtureUnstable,
  NO_STABLE_FIXTURE,
  readBenchReport,
  renderBenchReport,
} from "./bench-report.ts";
import {
  benchRoot,
  DEFAULT_GH_SHIM_PATH,
  defaultRunGate,
  issuesPipelineConfig,
  parseBenchConfig,
  parseSuite,
  runBaseline,
  runBench,
  SELECT_WORK_DIR,
  type BenchRunDeps,
  type BenchRunResult,
} from "./bench-run.ts";
import { matchConfigFlag } from "./cli-flags.ts";
import { withCloneLock } from "./clone-lock.ts";
import { resolveConfig, type PhoebeConfig } from "./config-schema.ts";
import { followConfigPointer } from "./config-pointer.ts";
import type { BenchConfig, BenchSuite } from "./contracts/bench.ts";
import type { BenchReport } from "./contracts/bench-report.ts";
import {
  dockerOnPath,
  formatResolveFailure,
  noDockerMessage,
  resolveDeploymentCompose,
  runCompose,
  type CommandRunner,
} from "./deployment-compose.ts";
import { readDeploymentCommands } from "./deployment-command.ts";
import { isInsideContainer } from "./execution-gate.ts";
import { detectAppCredentials, mintInstallationToken } from "./gh-app.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import { createGitHubClient } from "./github-client.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { ensureOriginClone } from "./origin-hub.ts";
import { resolveDataBase } from "./paths.ts";
import { tenantSecrets, tenantStateDir } from "./secret-store.ts";
import { PHOEBE_SERVICE } from "./status.ts";
import { enumerateWorkspaceTenants } from "./tenant-commands.ts";

export type ParsedBenchSelectArgs = {
  help: boolean;
  command?: "select" | "run" | "report";
  /** `select`: what to pin. */
  request?: BenchSelectRequest;
  /** `select`: `false` with `--no-baseline`, pinning without running the gates. */
  baseline?: false;
  /** `run`: the suite file, as the operator typed it. */
  suitePath?: string;
  /** `run`: the bench config naming the contenders, as the operator typed it. */
  benchConfigPath?: string;
  /** `run`: how many trials at once; 1 when absent. */
  concurrency?: number;
  /** `report`: the run to print. */
  runId?: string;
  /** `run` and `report`: print the `BenchReport` as JSON rather than the table. */
  json?: boolean;
  tenant?: string;
  configPath?: string;
};

const BENCH_HELP_TEXT = `phoebe bench — replay issues Phoebe already solved, offline

Usage:
  phoebe bench select --issues <n,n,…> [--no-baseline] [--tenant <owner/repo>]
  phoebe bench select [--since <YYYY-MM-DD>] [--limit <n>] [--no-baseline]
                      [--tenant <owner/repo>]
  phoebe bench run <suite.json> [--bench-config <bench.json>] [--concurrency <n>] [--json]
                   [--tenant <owner/repo>]
  phoebe bench report <runId> [--json] [--tenant <owner/repo>]

select pins a suite of fixtures and prints it as JSON on stdout; save it in the
deployment directory. --issues names the issues; otherwise it walks merged PRs
on <branchPrefix>issue-<n> branches, newest merge first, until --limit fixtures
qualify (default ${DEFAULT_SELECT_LIMIT}). --since keeps PRs merged on or after a date.

A fixture is one issue whose PR merged into the default branch with only
Phoebe's commits. Issues on a feature branch, stacked PRs, PRs someone else
pushed to, and issues blocked mid-way are skipped; each skip is listed in the
suite and on stderr with its reason.

Each fixture pins the issue's title, body and the comments posted before the PR
opened; the PR's number, head and merge commits; and baseSha, the merge-base of
the PR head and the merge commit's first parent, computed in the hub clone.

Before pinning a fixture, select runs its baseline: it checks the merged PR's
head out into a fresh tree and runs installCommand, checkCommand and
testCommand there with no agent, stopping at the first failure. A fixture whose
merged PR no longer passes is skipped with the gate that failed. One that passes
records baselinePassedAt. --no-baseline pins without running the gates, and its
fixtures have no baselinePassedAt.

run replays every fixture in a suite with every contender, offline. Without
--bench-config the one contender is the tenant's own issues settings. A bench
config is a JSON file in the deployment directory:

  {
    "contenders": [
      { "name": "current" },
      { "name": "opus-high", "model": "claude-opus-5-5", "effort": "high" },
      { "name": "new-prompt", "promptFile": "bench/issue-candidate.md" }
    ],
    "repeat": 3,
    "judge": { "provider": "claude", "model": "claude-opus-5-5" }
  }

Each contender sets any of provider, model, effort and promptFile; the tenant's
issues settings fill the rest. promptFile is relative to the deployment
directory, so a prompt can be tried before it is installed. repeat (default 1)
replays each fixture-contender pair that many times. --concurrency (default 1)
runs that many trials at once; they share the provider's rate limits with the
live fleet.

judge is optional. With it, each trial that made commits gets one judge run
after the trial ends. The judge reads the issue, the merged PR's diff from the
hub clone and the trial's patch, in a scratch directory with no repository and
no GitHub credential, and answers better, equivalent, worse or wrong with a
short rationale. Its usage and cost are recorded on the trial, apart from the
contender's.

Before any trial, run runs every fixture's baseline again, --concurrency at a
time, because a fixture can break after it is pinned. A fixture whose baseline
fails is unstable for the run. None of its trials run, planned leaves them out,
and no rate counts it. The report lists it with the gate that failed and when
its baseline last passed, and the table ends with a line naming it.

Each trial gets a fresh repository at baseSha with no
remote, a HOME of its own, no GitHub credential, and a gh that serves the issue
from the suite and records every write it would have made. "Offline" means cut
off from GitHub, not from the network: trials keep outbound network for the
provider API and the package registry. Bench runs
installCommand, the agent, then checkCommand and testCommand itself, stopping at
the first failure; a trial whose agent left no commits is "no change" and skips
checkCommand and testCommand (installCommand still runs, before the agent). Each run lands in bench/<runId>/ under the tenant's data directory:
config.json, trials.jsonl, one patch per trial with commits, and report.json.
Only the last 10 runs are kept. Ctrl-C drops the trials in flight and writes a
partial report.

When the run ends it prints one row per contender: trials, how many made no
change, check and test pass rates over all its trials, median duration and
tokens, and the API cost and subscription estimate the provider reported (a
dash where it reported none). With a judge, it adds a count per verdict and a
line for what the judge spent. --json prints the BenchReport instead, the same
JSON saved as report.json. report <runId> prints a saved run's report again.

The exit code is 0 when every trial ran, whatever the trials scored. It is 1
when every fixture is unstable, since there is nothing to compare. It is
otherwise non-zero only when bench itself could not run: a bad suite or bench
config, a missing prompt file, or a contender or judge whose provider key is
unset.

On the host every subcommand runs in a one-off container from the deployment's
image, which takes none of the fleet's slots; the suite and bench config files
must sit in the deployment directory. In a workspace, --tenant picks the tenant.
`;

function flagValue(argv: readonly string[], i: number, name: string): [string, number] {
  const arg = argv[i]!;
  const inline = arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined;
  const value = inline ?? argv[i + 1];
  if (
    value === undefined ||
    value.length === 0 ||
    (inline === undefined && value.startsWith("-"))
  ) {
    throw new Error(`\`--${name}\` needs a value. See \`phoebe bench --help\`.`);
  }
  return [value, inline === undefined ? 1 : 0];
}

function isFlag(arg: string, name: string): boolean {
  return arg === `--${name}` || arg.startsWith(`--${name}=`);
}

function positiveInt(text: string, what: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new Error(`${what} must be a positive whole number (got \`${text}\`).`);
  }
  return Number(text);
}

/** Parse the argv after `bench`. */
export function parseBenchArgs(argv: readonly string[]): ParsedBenchSelectArgs {
  let help = false;
  let subcommand: string | undefined;
  let issues: number[] | undefined;
  let since: string | undefined;
  let limit: number | undefined;
  let tenant: string | undefined;
  let configPath: string | undefined;
  let suitePath: string | undefined;
  let benchConfigPath: string | undefined;
  let concurrency: number | undefined;
  let runId: string | undefined;
  let json = false;
  let noBaseline = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const config = matchConfigFlag(argv, i);
    if (config !== undefined) {
      configPath = config.value;
      i += config.consumed - 1;
      continue;
    }
    if (isFlag(arg, "issues")) {
      const [value, skip] = flagValue(argv, i, "issues");
      issues = value
        .split(",")
        .map((piece) => piece.trim().replace(/^#/, ""))
        .filter((piece) => piece.length > 0)
        .map((piece) => positiveInt(piece, "Each `--issues` entry"));
      if (issues.length === 0) throw new Error("`--issues` names no issues.");
      i += skip;
      continue;
    }
    if (isFlag(arg, "since")) {
      const [value, skip] = flagValue(argv, i, "since");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
        throw new Error(`\`--since\` takes a date, YYYY-MM-DD (got \`${value}\`).`);
      }
      since = value;
      i += skip;
      continue;
    }
    if (isFlag(arg, "limit")) {
      const [value, skip] = flagValue(argv, i, "limit");
      limit = positiveInt(value, "`--limit`");
      i += skip;
      continue;
    }
    if (isFlag(arg, "bench-config")) {
      const [value, skip] = flagValue(argv, i, "bench-config");
      benchConfigPath = value;
      i += skip;
      continue;
    }
    if (isFlag(arg, "concurrency")) {
      const [value, skip] = flagValue(argv, i, "concurrency");
      concurrency = positiveInt(value, "`--concurrency`");
      i += skip;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--no-baseline") {
      noBaseline = true;
      continue;
    }
    if (isFlag(arg, "tenant")) {
      const [value, skip] = flagValue(argv, i, "tenant");
      tenant = value;
      i += skip;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag \`${arg}\` for \`phoebe bench\`. See \`phoebe bench --help\`.`);
    }
    if (subcommand === "run" && suitePath === undefined) {
      suitePath = arg;
      continue;
    }
    if (subcommand === "report" && runId === undefined) {
      runId = arg;
      continue;
    }
    if (subcommand !== undefined) {
      throw new Error(`Unexpected argument \`${arg}\` for \`phoebe bench ${subcommand}\`.`);
    }
    if (arg !== "select" && arg !== "run" && arg !== "report") {
      throw new Error(
        `Unknown \`phoebe bench\` command \`${arg}\`. Expected select, run or report.`,
      );
    }
    subcommand = arg;
  }

  const common = {
    help,
    ...(tenant !== undefined ? { tenant } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
  };
  if (help) return common;
  if (subcommand === undefined) {
    throw new Error("`phoebe bench` needs a command: select, run or report.");
  }
  if (
    subcommand !== "select" &&
    (issues !== undefined || since !== undefined || limit !== undefined)
  ) {
    throw new Error(
      `\`--issues\`, \`--since\` and \`--limit\` choose fixtures for \`select\`, not \`${subcommand}\`.`,
    );
  }
  if (subcommand !== "run" && (benchConfigPath !== undefined || concurrency !== undefined)) {
    throw new Error(
      `\`--bench-config\` and \`--concurrency\` are for \`run\`, not \`${subcommand}\`.`,
    );
  }
  if (subcommand !== "select" && noBaseline) {
    throw new Error(
      `\`--no-baseline\` is for \`select\`; \`${subcommand}\` always runs every fixture's baseline.`,
    );
  }
  if (subcommand === "select" && json) {
    throw new Error(
      "`phoebe bench select` always prints JSON; `--json` is for `run` and `report`.",
    );
  }
  const jsonFlag = json ? { json } : {};
  if (subcommand === "run") {
    if (suitePath === undefined) throw new Error("`phoebe bench run` needs a suite file.");
    return {
      ...common,
      command: "run",
      suitePath,
      ...(benchConfigPath !== undefined ? { benchConfigPath } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...jsonFlag,
    };
  }
  if (subcommand === "report") {
    if (runId === undefined) {
      throw new Error("`phoebe bench report` needs a run id, the directory name under bench/.");
    }
    return { ...common, command: "report", runId, ...jsonFlag };
  }
  if (issues !== undefined && (since !== undefined || limit !== undefined)) {
    throw new Error(
      "`--issues` names the fixtures itself; it does not combine with `--since` or `--limit`.",
    );
  }
  const request: BenchSelectRequest =
    issues !== undefined
      ? { by: "issues", issues }
      : { by: "query", since: since ?? null, limit: limit ?? DEFAULT_SELECT_LIMIT };
  return {
    ...common,
    command: "select",
    request,
    ...(noBaseline ? { baseline: false as const } : {}),
  };
}

/** The flags the one-off container is handed, rebuilt rather than forwarded raw. */
export function benchSelectArgv(parsed: ParsedBenchSelectArgs): string[] {
  if (parsed.command === "run") {
    const argv = ["bench", "run", parsed.suitePath!];
    if (parsed.benchConfigPath !== undefined) argv.push("--bench-config", parsed.benchConfigPath);
    if (parsed.concurrency !== undefined) argv.push("--concurrency", String(parsed.concurrency));
    if (parsed.json === true) argv.push("--json");
    if (parsed.tenant !== undefined) argv.push("--tenant", parsed.tenant);
    return argv;
  }
  if (parsed.command === "report") {
    const argv = ["bench", "report", parsed.runId!];
    if (parsed.json === true) argv.push("--json");
    if (parsed.tenant !== undefined) argv.push("--tenant", parsed.tenant);
    return argv;
  }
  const argv = ["bench", "select"];
  const request = parsed.request!;
  if (request.by === "issues") {
    argv.push("--issues", request.issues.join(","));
  } else {
    if (request.since !== null) argv.push("--since", request.since);
    argv.push("--limit", String(request.limit));
  }
  if (parsed.baseline === false) argv.push("--no-baseline");
  if (parsed.tenant !== undefined) argv.push("--tenant", parsed.tenant);
  return argv;
}

/** `docker compose` argv for the one-off container. */
export function benchComposeArgv(parsed: ParsedBenchSelectArgs): string[] {
  return [
    "run",
    "--rm",
    "-T",
    "--no-deps",
    "--entrypoint",
    "phoebe",
    PHOEBE_SERVICE,
    ...benchSelectArgv(parsed),
  ];
}

// --- the tenant -------------------------------------------------------------

/** The tenant a bench run reads, with the env its `gh` calls run under. */
export type BenchTenant = {
  config: PhoebeConfig;
  env: NodeJS.ProcessEnv;
  /** The tenant's config file; its directory is the runtime root prompts resolve from. */
  configPath: string;
};

function readEnvFile(path: string | null): Record<string, string> {
  if (path === null || !existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function declaredSlug(user: Record<string, unknown>): string | null {
  const slug = user["repoSlug"];
  return typeof slug === "string" && slug.trim().length > 0 ? slug.trim() : null;
}

/**
 * Resolve the tenant. A workspace root names it with `--tenant` (or has only
 * one); anywhere else the config found is the tenant, and `--tenant` may only
 * agree with it. The env is the process's, then the tenant's `.env`, then its
 * secret store — the order a supervised engine child sees.
 */
export async function resolveBenchTenant(opts: {
  configPath: string;
  dataBase: string;
  processEnv: NodeJS.ProcessEnv;
  tenant?: string;
}): Promise<BenchTenant> {
  const enumeration = await enumerateWorkspaceTenants({ configDir: dirname(opts.configPath) });
  let configPath = opts.configPath;
  let envPath: string | null = null;
  if (enumeration !== null) {
    const slugs = enumeration.tenants.flatMap((tenant) =>
      tenant.slug === null ? [] : [tenant.slug],
    );
    const match =
      opts.tenant !== undefined
        ? enumeration.tenants.find((tenant) => tenant.slug === opts.tenant)
        : enumeration.tenants.length === 1
          ? enumeration.tenants[0]
          : undefined;
    if (match === undefined) {
      throw new Error(
        opts.tenant === undefined
          ? `This is a workspace root. Name the tenant: \`--tenant <owner/repo>\` (${slugs.join(", ") || "no tenants discovered"}).`
          : `No tenant \`${opts.tenant}\` in this workspace (${slugs.join(", ") || "none discovered"}).`,
      );
    }
    configPath = match.configPath;
    envPath = match.envPath;
  }

  const user = await loadUserConfig(configPath);
  const slug = declaredSlug(user as unknown as Record<string, unknown>);
  if (enumeration === null && opts.tenant !== undefined && slug !== null && slug !== opts.tenant) {
    throw new Error(`\`--tenant ${opts.tenant}\` does not match this deployment's ${slug}.`);
  }
  const env: NodeJS.ProcessEnv = {
    ...opts.processEnv,
    ...readEnvFile(envPath),
    ...tenantSecrets(tenantStateDir(slug, opts.dataBase)),
  };
  const config = resolveConfig(applyEnvOverlay(user, env), { dataBase: opts.dataBase });
  return { config, env, configPath };
}

/**
 * Make sure `env` carries a `GH_TOKEN`: a token already set wins; otherwise an
 * App deployment mints an installation token for this repo, as the engine does
 * at the top of a poll.
 */
export async function ensureGhToken(
  env: NodeJS.ProcessEnv,
  repoSlug: string,
  mint: typeof mintInstallationToken = mintInstallationToken,
): Promise<void> {
  if (typeof env["GH_TOKEN"] === "string" && env["GH_TOKEN"].length > 0) return;
  const creds = detectAppCredentials(env);
  if (creds === null) {
    throw new Error(
      `No GitHub credential for ${repoSlug}: set GH_TOKEN, or GH_APP_ID and GH_APP_PRIVATE_KEY.`,
    );
  }
  const minted = await mint(repoSlug, creds);
  if (!minted.ok) throw new Error(`Could not mint a GitHub App token: ${minted.reason}`);
  env["GH_TOKEN"] = minted.token;
}

// --- the verb ---------------------------------------------------------------

export type BenchIo = {
  stdout: (text: string) => void;
  stderr: (line: string) => void;
};

export type BenchDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inContainer?: boolean;
  io?: Partial<BenchIo>;
  /** Host arm. */
  runner?: CommandRunner;
  dockerAvailable?: boolean;
  exists?: (path: string) => boolean;
  /** Host arm: does the config carry a `deployment` block? Read from cwd when absent. */
  hasDeploymentBlock?: boolean;
  /** Container arm: the GitHub reads, injected so a test never spawns `gh`. */
  github?: (tenant: BenchTenant) => BenchSelectGitHub;
  /** Container arm: the hub clone, made ready. */
  prepareClone?: (config: PhoebeConfig) => void;
  /** Container arm: git in the hub clone. */
  git?: GitRunner;
  now?: () => Date;
  /** Container arm: the seams of `run`'s trials, and of the baselines `run` and `select` both run. */
  run?: BenchRunDeps;
  /** Container arm of `run`: the interrupt; SIGINT and SIGTERM by default. */
  signal?: AbortSignal;
};

function benchIo(deps: BenchDeps): BenchIo {
  return {
    stdout: deps.io?.stdout ?? ((text) => process.stdout.write(text)),
    stderr: deps.io?.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  };
}

/** The in-container arm: select, print the suite, list the skips on stderr. */
export async function runBenchSelectInContainer(
  parsed: ParsedBenchSelectArgs,
  deps: BenchDeps = {},
): Promise<BenchSuite> {
  const io = benchIo(deps);
  const processEnv = deps.env ?? process.env;
  const configPath = await followConfigPointer(
    resolveConfigPath(parsed.configPath, deps.cwd ?? process.cwd()),
  );
  const tenant = await resolveBenchTenant({
    configPath,
    dataBase: resolveDataBase(processEnv),
    processEnv,
    ...(parsed.tenant !== undefined ? { tenant: parsed.tenant } : {}),
  });
  const { config } = tenant;
  const github =
    deps.github?.(tenant) ??
    (await (async () => {
      await ensureGhToken(tenant.env, config.repoSlug);
      return createGitHubClient({ config, env: tenant.env, tag: "[phoebe] bench" });
    })());
  const prepare =
    deps.prepareClone ??
    ((c: PhoebeConfig) =>
      withCloneLock(c.paths.stateDir, () => ensureOriginClone(c, true), {
        log: (line) => io.stderr(line),
      }));
  prepare(config);

  const pipelineConfig = issuesPipelineConfig(config);
  const workRoot = join(benchRoot(pipelineConfig), `${SELECT_WORK_DIR}-${process.pid}`);
  const baseline: BenchSelectBaseline | null =
    parsed.baseline === false
      ? null
      : (fixture) =>
          runBaseline({
            config: pipelineConfig,
            env: tenant.env,
            fixture,
            dir: join(workRoot, `issue-${fixture.issue.number}`),
            signal: new AbortController().signal,
            git: deps.git ?? defaultGit,
            runGate: deps.run?.runGate ?? defaultRunGate,
            ghShimPath: deps.run?.ghShimPath ?? DEFAULT_GH_SHIM_PATH,
            log: (line) => io.stderr(line),
          });
  let suite: BenchSuite;
  try {
    suite = await selectSuite({
      github,
      config,
      request: parsed.request!,
      baseline,
      baseShaOf: (pr) =>
        computeBaseSha({
          repoDir: config.paths.repoDir,
          prNumber: pr.number,
          headSha: pr.headRefOid,
          mergeSha: pr.mergeCommitOid!,
          defaultBranch: config.defaultBranch,
          ...(deps.git !== undefined ? { git: deps.git } : {}),
        }),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
  for (const skip of suite.skipped) {
    io.stderr(
      `[phoebe] bench: skipped #${skip.issue}${skip.pr === null ? "" : ` (PR #${skip.pr})`}: ${skip.reason}`,
    );
  }
  io.stderr(
    `[phoebe] bench: ${suite.fixtures.length} fixture(s) for ${config.repoSlug}, ` +
      `${suite.skipped.length} skipped.`,
  );
  io.stdout(`${JSON.stringify(suite, null, 2)}\n`);
  return suite;
}

function readOperatorFile(cwd: string, path: string, what: string): string {
  try {
    return readFileSync(resolve(cwd, path), "utf8");
  } catch (error) {
    throw new Error(`Could not read the ${what} ${path}: ${String(error)}`, { cause: error });
  }
}

/** Print a report: the table, or with `--json` the `BenchReport` itself. */
function printReport(io: BenchIo, report: BenchReport, json: boolean): void {
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderBenchReport(report));
}

/**
 * The in-container arm of `run`: read the suite and the bench config, make
 * sure the hub clone exists, run the trials, and print the report on stdout.
 * SIGINT or SIGTERM drops the trials in flight and leaves a partial report; a
 * second Ctrl-C kills the process as usual.
 */
export async function runBenchRunInContainer(
  parsed: ParsedBenchSelectArgs,
  deps: BenchDeps = {},
): Promise<BenchRunResult> {
  const io = benchIo(deps);
  const cwd = deps.cwd ?? process.cwd();
  const processEnv = deps.env ?? process.env;
  const configPath = await followConfigPointer(resolveConfigPath(parsed.configPath, cwd));
  const tenant = await resolveBenchTenant({
    configPath,
    dataBase: resolveDataBase(processEnv),
    processEnv,
    ...(parsed.tenant !== undefined ? { tenant: parsed.tenant } : {}),
  });
  const { config } = tenant;
  const suite = parseSuite(readOperatorFile(cwd, parsed.suitePath!, "suite"), config.repoSlug);
  const benchConfig: BenchConfig | null =
    parsed.benchConfigPath === undefined
      ? null
      : parseBenchConfig(
          readOperatorFile(cwd, parsed.benchConfigPath, "bench config"),
          parsed.benchConfigPath,
        );
  const prepare =
    deps.prepareClone ??
    ((c: PhoebeConfig) =>
      withCloneLock(c.paths.stateDir, () => ensureOriginClone(c, true), {
        log: (line) => io.stderr(line),
      }));
  prepare(config);

  let signal = deps.signal;
  let release = (): void => {};
  if (signal === undefined) {
    const controller = new AbortController();
    const onSignal = (name: string) => (): void => {
      io.stderr(`[phoebe] bench: ${name} — stopping after dropping the trials in flight.`);
      controller.abort();
    };
    const onInt = onSignal("interrupted");
    const onTerm = onSignal("terminated");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    release = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
    signal = controller.signal;
  }
  let result: BenchRunResult;
  try {
    result = await runBench({
      config,
      env: tenant.env,
      suite,
      suitePath: parsed.suitePath!,
      runtimeRoot: dirname(tenant.configPath),
      deploymentDir: cwd,
      benchConfig,
      benchConfigPath: parsed.benchConfigPath ?? null,
      concurrency: parsed.concurrency ?? 1,
      signal,
      deps: { log: (line) => io.stderr(line), ...deps.run },
    });
  } finally {
    release();
  }
  printReport(io, result.report, parsed.json === true);
  return result;
}

/** The in-container arm of `report`: print a saved run's report again. */
export async function runBenchReportInContainer(
  parsed: ParsedBenchSelectArgs,
  deps: BenchDeps = {},
): Promise<BenchReport> {
  const io = benchIo(deps);
  const cwd = deps.cwd ?? process.cwd();
  const processEnv = deps.env ?? process.env;
  const configPath = await followConfigPointer(resolveConfigPath(parsed.configPath, cwd));
  const tenant = await resolveBenchTenant({
    configPath,
    dataBase: resolveDataBase(processEnv),
    processEnv,
    ...(parsed.tenant !== undefined ? { tenant: parsed.tenant } : {}),
  });
  const report = readBenchReport(benchRoot(issuesPipelineConfig(tenant.config)), parsed.runId!);
  printReport(io, report, parsed.json === true);
  return report;
}

/**
 * Where the container finds a file the operator named on the host: the same
 * path relative to the deployment directory, which Compose mounts as the
 * container's working directory. A file outside it is not in the container.
 */
export function containerSuitePath(
  deploymentDir: string,
  cwd: string,
  suitePath: string,
  what: { name: string; example: string } = { name: "suite", example: "bench/suite.json" },
): string {
  const absolute = resolve(cwd, suitePath);
  const rel = relative(deploymentDir, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `The ${what.name} ${suitePath} is outside the deployment directory ${deploymentDir}, so the ` +
        `one-off container cannot see it. Save it there, e.g. ${what.example}.`,
    );
  }
  const forwarded = rel.split(sep).join("/");
  return forwarded.startsWith("-") ? `./${forwarded}` : forwarded;
}

/**
 * The host arm: a one-off container from the deployment's image, stdio passed
 * through so the suite lands on the operator's stdout and the skips on stderr.
 */
export async function runBenchSelectOnHost(
  parsed: ParsedBenchSelectArgs,
  deps: BenchDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const hasDeploymentBlock =
    deps.hasDeploymentBlock ?? (await readDeploymentCommands(cwd)) !== undefined;
  if (hasDeploymentBlock) {
    throw new Error(
      "`phoebe bench` runs in a one-off container through the deployment's Compose file, and a " +
        "config with a `deployment` block has none. Run it in your own runtime — " +
        `\`phoebe ${benchSelectArgv(parsed).join(" ")}\` inside a container from the image.`,
    );
  }
  if (!(deps.dockerAvailable ?? dockerOnPath())) throw new Error(noDockerMessage("bench"));
  const resolved = resolveDeploymentCompose(cwd, deps.exists);
  if ("kind" in resolved) throw new Error(formatResolveFailure(resolved));
  const forwarded =
    parsed.command === "run"
      ? {
          ...parsed,
          suitePath: containerSuitePath(resolved.deploymentDir, cwd, parsed.suitePath!),
          ...(parsed.benchConfigPath !== undefined
            ? {
                benchConfigPath: containerSuitePath(
                  resolved.deploymentDir,
                  cwd,
                  parsed.benchConfigPath,
                  { name: "bench config", example: "bench/bench.json" },
                ),
              }
            : {}),
        }
      : parsed;
  const result = await runCompose({
    deployment: resolved,
    args: benchComposeArgv(forwarded),
    inheritStdio: true,
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
  });
  return result.code;
}

/** `phoebe bench` entry. */
export async function runBenchCli(argv: readonly string[], deps: BenchDeps = {}): Promise<void> {
  const parsed = parseBenchArgs(argv);
  if (parsed.help) {
    benchIo(deps).stdout(BENCH_HELP_TEXT);
    return;
  }
  if (deps.inContainer ?? isInsideContainer()) {
    if (parsed.command === "run") {
      const { report } = await runBenchRunInContainer(parsed, deps);
      if (report.interrupted) process.exitCode = 130;
      else if (everyFixtureUnstable(report)) {
        benchIo(deps).stderr(`[phoebe] bench: ${NO_STABLE_FIXTURE}`);
        process.exitCode = 1;
      }
      return;
    }
    if (parsed.command === "report") {
      await runBenchReportInContainer(parsed, deps);
      return;
    }
    await runBenchSelectInContainer(parsed, deps);
    return;
  }
  if (parsed.configPath !== undefined) {
    throw new Error(
      "`--config` names a config inside the container; on the host, run from the deployment directory.",
    );
  }
  const code = await runBenchSelectOnHost(parsed, deps);
  if (code !== 0) process.exitCode = code;
}
