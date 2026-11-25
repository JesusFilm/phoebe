// `phoebe bench` — the offline replay benchmark's CLI (#939; spec #925). Today
// it has one subcommand, `select`, which pins a suite of fixtures from issues
// Phoebe already solved and prints it as JSON on stdout.
//
// Two arms, picked by the container marker as `status` picks its own:
//
//   - In the container it does the work: resolve the tenant, read GitHub with
//     the tenant's token, compute each fixture's `baseSha` in the tenant's hub
//     clone.
//   - On the host it starts a one-off container from the deployment's image
//     (`docker compose run --rm`, the way `--run-once` runs), with the same
//     arguments, and passes its stdout through untouched. It takes none of the
//     fleet's slots and needs the long-lived container neither up nor down.
//
// Selection reads GitHub and never writes to it.

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import {
  computeBaseSha,
  DEFAULT_SELECT_LIMIT,
  selectSuite,
  type BenchSelectGitHub,
  type BenchSelectRequest,
} from "./bench-select.ts";
import { matchConfigFlag } from "./cli-flags.ts";
import { withCloneLock } from "./clone-lock.ts";
import { resolveConfig, type PhoebeConfig } from "./config-schema.ts";
import { followConfigPointer } from "./config-pointer.ts";
import type { BenchSuite } from "./contracts/bench.ts";
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
import type { GitRunner } from "./git-model.ts";
import { createGitHubClient } from "./github-client.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { ensureOriginClone } from "./origin-hub.ts";
import { resolveDataBase } from "./paths.ts";
import { tenantSecrets, tenantStateDir } from "./secret-store.ts";
import { PHOEBE_SERVICE } from "./status.ts";
import { enumerateWorkspaceTenants } from "./tenant-commands.ts";

export type ParsedBenchSelectArgs = {
  help: boolean;
  request?: BenchSelectRequest;
  tenant?: string;
  configPath?: string;
};

const BENCH_HELP_TEXT = `phoebe bench — replay issues Phoebe already solved, offline

Usage:
  phoebe bench select --issues <n,n,…> [--tenant <owner/repo>]
  phoebe bench select [--since <YYYY-MM-DD>] [--limit <n>] [--tenant <owner/repo>]

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

On the host it runs in a one-off container from the deployment's image; in a
workspace, --tenant picks the tenant. It reads GitHub and never writes to it.
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
    if (isFlag(arg, "tenant")) {
      const [value, skip] = flagValue(argv, i, "tenant");
      tenant = value;
      i += skip;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag \`${arg}\` for \`phoebe bench\`. See \`phoebe bench --help\`.`);
    }
    if (subcommand !== undefined) {
      throw new Error(`Unexpected argument \`${arg}\` for \`phoebe bench ${subcommand}\`.`);
    }
    if (arg !== "select") {
      throw new Error(`Unknown \`phoebe bench\` command \`${arg}\`. Expected select.`);
    }
    subcommand = arg;
  }

  const common = {
    help,
    ...(tenant !== undefined ? { tenant } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
  };
  if (help) return common;
  if (subcommand === undefined) throw new Error("`phoebe bench` needs a command: select.");
  if (issues !== undefined && (since !== undefined || limit !== undefined)) {
    throw new Error(
      "`--issues` names the fixtures itself; it does not combine with `--since` or `--limit`.",
    );
  }
  const request: BenchSelectRequest =
    issues !== undefined
      ? { by: "issues", issues }
      : { by: "query", since: since ?? null, limit: limit ?? DEFAULT_SELECT_LIMIT };
  return { ...common, request };
}

/** The flags the one-off container is handed, rebuilt rather than forwarded raw. */
export function benchSelectArgv(parsed: ParsedBenchSelectArgs): string[] {
  const argv = ["bench", "select"];
  const request = parsed.request!;
  if (request.by === "issues") {
    argv.push("--issues", request.issues.join(","));
  } else {
    if (request.since !== null) argv.push("--since", request.since);
    argv.push("--limit", String(request.limit));
  }
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
export type BenchTenant = { config: PhoebeConfig; env: NodeJS.ProcessEnv };

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
  return { config, env };
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

  const suite = selectSuite({
    github,
    config,
    request: parsed.request!,
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
  const result = await runCompose({
    deployment: resolved,
    args: benchComposeArgv(parsed),
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
