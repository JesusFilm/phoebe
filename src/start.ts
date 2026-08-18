// `phoebe start` — bring the deployment up from the host (#187).
//
// Host-side operator command (family: upgrade, doctor, stop). Resolves the
// deployment from cwd, drives `docker compose up -d` against
// container/compose.yml (optional `--build`), then briefly re-probes so a
// container that exits seconds later is reported as a failure rather than a
// silent success. Returns to the prompt and points at how to follow the logs.
//
// A config carrying a `deployment` block takes the other arm instead (#261):
// `deployment.startCommand` runs literally via /bin/sh and every compose-specific
// step here is skipped. See src/deployment-command.ts.

import type { DeploymentField } from "./config-schema.ts";
import {
  lifecycleFailureError,
  readDeploymentCommands,
  runLifecycleCommand,
} from "./deployment-command.ts";
import {
  assertHostLifecycle,
  composeFailureError,
  dockerOnPath,
  findPhoebeService,
  formatResolveFailure,
  isContainerRunning,
  noDockerMessage,
  parseComposePsJson,
  resolveDeploymentCompose,
  runCompose,
  type CommandRunner,
  type DeploymentCompose,
} from "./deployment-compose.ts";

/**
 * How long to wait after `up -d` before checking the container is still up.
 * `up -d` returns once the container is *created*; a rejected config or missing
 * engine ref makes `boot` exit seconds later.
 */
export const START_SETTLE_MS = 3_000;

export type ParsedStartArgs = {
  help: boolean;
  /** Force an image rebuild. Default does not rebuild an existing image. */
  build: boolean;
};

export function parseStartArgs(argv: readonly string[]): ParsedStartArgs {
  let help = false;
  let build = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--build") {
      build = true;
      continue;
    }
    throw new Error(`Unknown flag \`${arg}\` for \`phoebe start\`. See \`phoebe start --help\`.`);
  }
  return { help, build };
}

const START_HELP_TEXT = `phoebe start — bring the deployment container up detached (host-side)

Usage:
  phoebe start           Start detached (Compose builds only if the image is absent)
  phoebe start --build   Force a rebuild, then start

Resolves the deployment from the current directory (the one holding
phoebe.config.ts and container/compose.yml). Passes the deployment .env to
Compose only when it exists. Confirms the container stayed up briefly after
start — a boot that exits immediately is reported as a failure. Returns to the
prompt; follow logs with docker compose rather than tailing from this command.
Refuses inside the container — run this on the host.

When phoebe.config.ts carries a "deployment" block, deployment.startCommand
runs instead and none of the Compose plumbing above applies (--build is then a
no-op). See docs/configuration.md.
`;

type StartIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

type StartDeps = {
  cwd?: string;
  runner?: CommandRunner;
  dockerAvailable?: boolean;
  inContainer?: boolean;
  exists?: (path: string) => boolean;
  /** Injectable settle wait — tests skip the real delay. */
  waitMs?: (ms: number) => Promise<void>;
  /**
   * Literal lifecycle commands from the config (#261). Present ⇒ the compose
   * driver is bypassed entirely. {@link runStartCli} reads it off the config;
   * `runStart` only ever consults the dep, which is what keeps it filesystem-free.
   */
  deployment?: DeploymentField;
  io?: Partial<StartIo>;
};

export type StartOutcome =
  | { kind: "started" }
  | { kind: "already-running" }
  | { kind: "exited-immediately"; exitCode: number | null };

function defaultWaitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function composePs(
  deployment: DeploymentCompose,
  runner: CommandRunner | undefined,
): Promise<ReturnType<typeof parseComposePsJson>> {
  const result = await runCompose({
    deployment,
    args: ["ps", "-a", "--format", "json"],
    ...(runner !== undefined ? { runner } : {}),
  });
  if (result.code !== 0) throw composeFailureError(result, "ps");
  return parseComposePsJson(result.stdout);
}

// Relative hints from the deployment directory — the same paths resolveDeployment
// uses. Absolute paths in the success line are noisy for operators.
const COMPOSE_HINT = "container/compose.yml";
const DEPLOYMENT_ENV_HINT = ".env";

function logsHint(deployment: DeploymentCompose): string {
  const envPart = deployment.envFile !== null ? ` --env-file ${DEPLOYMENT_ENV_HINT}` : "";
  return `docker compose -f ${COMPOSE_HINT}${envPart} logs -f`;
}

/**
 * Bring the deployment up detached. Returns the outcome; sets `process.exitCode`
 * only via {@link runStartCli}. Pure enough for unit tests with an injected runner.
 */
export async function runStart(opts: { build: boolean; deps?: StartDeps }): Promise<StartOutcome> {
  const cwd = opts.deps?.cwd ?? process.cwd();
  const io: StartIo = {
    stdout: opts.deps?.io?.stdout ?? ((line) => process.stdout.write(`${line}\n`)),
    stderr: opts.deps?.io?.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  };
  const waitMs = opts.deps?.waitMs ?? defaultWaitMs;

  // The guard is runtime-general: start is a host action in every topology, so
  // it fires before the branch below (#189).
  assertHostLifecycle("start", opts.deps?.inContainer);

  const deploymentCommands = opts.deps?.deployment;
  if (deploymentCommands !== undefined) {
    if (opts.build) {
      // Not an error — the operator asked for the deployment's own start command
      // and got it. But silently swallowing --build would let them believe a
      // rebuild happened.
      io.stderr(
        "[phoebe] --build is a no-op with a `deployment` block — there is no image to " +
          "rebuild here. Encode the rebuild in `deployment.startCommand` or run it separately.",
      );
    }
    io.stdout(
      `[phoebe] Starting via \`deployment.startCommand\`: ${deploymentCommands.startCommand}`,
    );
    const result = await runLifecycleCommand({
      command: deploymentCommands.startCommand,
      cwd,
      ...(opts.deps?.runner !== undefined ? { runner: opts.deps.runner } : {}),
    });
    if (result.code !== 0) {
      throw lifecycleFailureError({
        field: "startCommand",
        command: deploymentCommands.startCommand,
        result,
      });
    }
    io.stdout("[phoebe] Started.");
    return { kind: "started" };
  }

  const dockerOk = opts.deps?.dockerAvailable ?? dockerOnPath();
  if (!dockerOk) {
    throw new Error(noDockerMessage("start"));
  }

  const resolved = resolveDeploymentCompose(cwd, opts.deps?.exists);
  if ("kind" in resolved) {
    throw new Error(formatResolveFailure(resolved));
  }
  const deployment = resolved;

  const beforeRows = await composePs(deployment, opts.deps?.runner);
  const before = findPhoebeService(beforeRows);
  if (before !== undefined && isContainerRunning(before)) {
    io.stdout("[phoebe] Already running.");
    return { kind: "already-running" };
  }

  const upArgs = opts.build ? (["up", "-d", "--build"] as const) : (["up", "-d"] as const);
  if (opts.build) {
    io.stdout(
      "[phoebe] Starting with --build (forcing an image rebuild). Compose progress follows:",
    );
  } else {
    io.stdout(
      "[phoebe] Starting detached (no rebuild unless the image is absent). Compose progress follows:",
    );
  }

  const upResult = await runCompose({
    deployment,
    args: upArgs,
    inheritStdio: true,
    ...(opts.deps?.runner !== undefined ? { runner: opts.deps.runner } : {}),
  });
  if (upResult.code !== 0) throw composeFailureError(upResult, "up");

  // `up -d` returns once the container is created. A config Phoebe rejects or a
  // missing engine ref makes boot exit seconds later — wait, then re-probe.
  await waitMs(START_SETTLE_MS);

  const afterRows = await composePs(deployment, opts.deps?.runner);
  const after = findPhoebeService(afterRows);
  if (after === undefined || !isContainerRunning(after)) {
    const exitCode =
      after?.ExitCode !== undefined && after.ExitCode !== "" ? Number(after.ExitCode) : null;
    const codeLabel = exitCode !== null && !Number.isNaN(exitCode) ? String(exitCode) : "unknown";
    io.stderr(
      `[phoebe] Container exited immediately after start (exit code ${codeLabel}). ` +
        `This is not a successful start — check boot output with: ${logsHint(deployment)}`,
    );
    return { kind: "exited-immediately", exitCode };
  }

  io.stdout(`[phoebe] Started. Follow logs with: ${logsHint(deployment)}`);
  return { kind: "started" };
}

/** `phoebe start` entry. */
export async function runStartCli(argv: readonly string[], deps?: StartDeps): Promise<void> {
  const parsed = parseStartArgs(argv);
  if (parsed.help) {
    process.stdout.write(START_HELP_TEXT);
    return;
  }
  // Refuse in-container before touching the config: reading it means importing
  // (and running) a TS module, which a refused command must not do. `runStart`
  // asserts again on its own — it is the guard for direct callers too.
  assertHostLifecycle("start", deps?.inContainer);
  // Reading the config is the CLI's job, not `runStart`'s: the run function
  // stays injectable-only so tests never touch a config file. A caller that
  // already has the block (the tests, a future embedder) passes it through deps
  // and no config is read.
  const cwd = deps?.cwd ?? process.cwd();
  const deployment = deps?.deployment ?? (await readDeploymentCommands(cwd));
  const outcome = await runStart({
    build: parsed.build,
    deps: { ...deps, ...(deployment !== undefined ? { deployment } : {}) },
  });
  if (outcome.kind === "exited-immediately") {
    process.exitCode = 1;
  }
}
