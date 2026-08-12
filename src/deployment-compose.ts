// Host-side Compose deployment plumbing (#186) — discovery, env-file resolution,
// Docker availability, and an injectable command runner. `phoebe stop` is the
// first consumer; `phoebe start` (#187) reuses the same seam rather than
// inventing a second one. Compose is hardcoded on purpose (#189 tracks a later
// runtime seam once a second implementation exists).

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { TENANT_CONFIG_FILE } from "../bootstrap/tenants.ts";
import { isInsideContainer } from "./execution-gate.ts";

/** Compose file relative to the deployment directory (scaffold layout). */
export const COMPOSE_REL_PATH = join("container", "compose.yml");
/** Env file relative to the deployment directory (one level above compose/). */
export const DEPLOYMENT_ENV_REL_PATH = ".env";

/**
 * Drain grace in seconds — matches {@link DEFAULT_DRAIN_TIMEOUT_MS} in
 * bootstrap/supervise-fleet.ts (1h). Kept as a local constant so host lifecycle
 * commands do not import the fleet supervisor just for a number; the two must
 * stay equal (asserted in tests).
 */
export const DRAIN_TIMEOUT_SEC = 3_600;

export type DeploymentCompose = {
  /** Absolute path to the deployment directory (holds phoebe.config.ts). */
  deploymentDir: string;
  /** Absolute path to container/compose.yml. */
  composeFile: string;
  /** Absolute path to container/ (Compose's natural cwd). */
  containerDir: string;
  /**
   * Absolute path to the deployment `.env`, or `null` when absent. Passing a
   * missing path to Compose is a hard error — only pass this when it exists.
   */
  envFile: string | null;
};

export type DeploymentResolveFailure =
  | { kind: "no-compose"; deploymentDir: string }
  | { kind: "tenant-directory"; deploymentDir: string };

/**
 * Resolve the Compose deployment rooted at `cwd`. No upward walk — a silent
 * parent match is how you stop the wrong deployment. A directory that has
 * `phoebe.config.ts` but no compose file is named as a tenant directory:
 * container lifecycle is deployment-level, owned by the workspace root.
 */
export function resolveDeploymentCompose(
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): DeploymentCompose | DeploymentResolveFailure {
  const deploymentDir = resolve(cwd);
  const composeFile = join(deploymentDir, COMPOSE_REL_PATH);
  if (!exists(composeFile)) {
    if (exists(join(deploymentDir, TENANT_CONFIG_FILE))) {
      return { kind: "tenant-directory", deploymentDir };
    }
    return { kind: "no-compose", deploymentDir };
  }
  const envPath = join(deploymentDir, DEPLOYMENT_ENV_REL_PATH);
  return {
    deploymentDir,
    composeFile,
    containerDir: join(deploymentDir, "container"),
    envFile: exists(envPath) ? envPath : null,
  };
}

export function formatResolveFailure(failure: DeploymentResolveFailure): string {
  if (failure.kind === "tenant-directory") {
    return (
      `No ${COMPOSE_REL_PATH} in ${failure.deploymentDir} — this looks like a tenant ` +
      `directory (has ${TENANT_CONFIG_FILE}, no container/). Container lifecycle is ` +
      `deployment-level, owned by the workspace root — run this from there.`
    );
  }
  return (
    `No ${COMPOSE_REL_PATH} in ${failure.deploymentDir}. Host lifecycle commands drive the ` +
    `scaffolded Compose file in a deployment directory (the one \`phoebe init\` wrote).`
  );
}

/** Host-side instruction when a lifecycle command is invoked inside the container. */
export function inContainerLifecycleMessage(command: string): string {
  return (
    `\`phoebe ${command}\` must run on the host — there is no Docker socket inside the container. ` +
    `From the deployment directory on the host: \`phoebe ${command}\`.`
  );
}

export function assertHostLifecycle(command: string, inContainer?: boolean): void {
  if (inContainer ?? isInsideContainer()) {
    throw new Error(inContainerLifecycleMessage(command));
  }
}

/**
 * True when `docker` is an executable on PATH. Does not talk to the daemon —
 * a missing binary is the operator error we can name; a daemon-down failure
 * still surfaces from Compose itself.
 */
export function dockerOnPath(
  pathEnv: string | undefined = process.env["PATH"],
  access: (path: string, mode: number) => void = accessSync,
): boolean {
  if (pathEnv === undefined || pathEnv.length === 0) return false;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    try {
      access(join(dir, "docker"), constants.X_OK);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

export function noDockerMessage(command: string): string {
  return (
    `\`docker\` is not on PATH. \`phoebe ${command}\` drives \`docker compose\` against the ` +
    `deployment's container/compose.yml — install Docker (with the Compose v2 plugin) ` +
    `and retry from the deployment directory.`
  );
}

/**
 * Build the `docker compose …` argv (no leading `docker`). Env file is included
 * only when present — a missing `--env-file` path is a hard Compose error, and
 * the template's required `GH_TOKEN` makes a bare stop fail demanding a secret
 * stop never uses.
 */
export function buildComposeArgv(opts: {
  composeFile: string;
  envFile: string | null;
  args: readonly string[];
}): string[] {
  const argv = ["compose", "-f", opts.composeFile];
  if (opts.envFile !== null) {
    argv.push("--env-file", opts.envFile);
  }
  argv.push(...opts.args);
  return argv;
}

/** Compose's required-variable error → Phoebe-worded pointer at `.env.example`. */
export const MISSING_ENV_MESSAGE =
  "Compose needs the deployment `.env` (copy `.env.example` to `.env` and fill " +
  "`GH_TOKEN` at minimum). The scaffolded `.env` sits next to `phoebe.config.ts`, " +
  "one level above `container/`.";

/**
 * True when Compose failed because a required env var (typically `GH_TOKEN`)
 * was unset — the failure mode of stopping without an env file against the
 * scaffolded template.
 */
export function isMissingRequiredEnvError(stderr: string, stdout: string = ""): boolean {
  const text = `${stderr}\n${stdout}`;
  return (
    /required variable/i.test(text) ||
    /GH_TOKEN is required/i.test(text) ||
    /missing a value/i.test(text)
  );
}

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Injectable command runner. Lifecycle commands pass Compose's output straight
 * through when `inheritStdio` is true (a long drain's progress is the operator's
 * only evidence of life); capture mode is for `ps` / inspect probes.
 */
export type CommandRunner = (spec: {
  file: string;
  args: readonly string[];
  cwd?: string;
  inheritStdio?: boolean;
}) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (spec) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(spec.file, spec.args as string[], {
      cwd: spec.cwd,
      stdio: spec.inheritStdio === true ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (spec.inheritStdio !== true) {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });

/** One row from `docker compose ps -a --format json` (fields we read). */
export type ComposePsRow = {
  Service?: string;
  State?: string;
  ExitCode?: number | string;
  Name?: string;
};

/**
 * Parse Compose's JSON lines (`ps --format json`). Tolerates a single JSON
 * array (older shapes) or newline-delimited objects (Compose v2 default).
 */
export function parseComposePsJson(output: string): ComposePsRow[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as ComposePsRow[];
    return Array.isArray(parsed) ? parsed : [];
  }
  const rows: ComposePsRow[] = [];
  for (const line of trimmed.split("\n")) {
    const piece = line.trim();
    if (piece.length === 0) continue;
    rows.push(JSON.parse(piece) as ComposePsRow);
  }
  return rows;
}

export function findPhoebeService(rows: ComposePsRow[]): ComposePsRow | undefined {
  return rows.find((row) => row.Service === "phoebe");
}

/** Non-zero Compose result → Error, preferring stderr then stdout. */
export function composeFailureError(result: CommandResult, label: string): Error {
  return new Error(
    result.stderr.trim() || result.stdout.trim() || `docker compose ${label} exited ${result.code}`,
  );
}

export function isContainerRunning(row: ComposePsRow): boolean {
  const state = (row.State ?? "").toLowerCase();
  return state === "running" || state === "restarting";
}

/**
 * Exit code 137 = 128 + SIGKILL (9). Compose exits 0 whether the container
 * drained or was killed after the grace — this is how we tell them apart.
 */
export function wasKilledAfterGrace(row: ComposePsRow): boolean {
  const code = Number(row.ExitCode);
  return code === 137;
}

export async function runCompose(opts: {
  deployment: DeploymentCompose;
  args: readonly string[];
  runner?: CommandRunner;
  inheritStdio?: boolean;
}): Promise<CommandResult> {
  const runner = opts.runner ?? defaultCommandRunner;
  const argv = buildComposeArgv({
    composeFile: opts.deployment.composeFile,
    envFile: opts.deployment.envFile,
    args: opts.args,
  });
  const result = await runner({
    file: "docker",
    args: argv,
    cwd: opts.deployment.containerDir,
    inheritStdio: opts.inheritStdio,
  });
  if (result.code !== 0 && isMissingRequiredEnvError(result.stderr, result.stdout)) {
    throw new Error(MISSING_ENV_MESSAGE);
  }
  return result;
}
