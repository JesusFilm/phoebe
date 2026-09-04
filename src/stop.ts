// `phoebe stop` — drain the deployment from the host (#186).
//
// Host-side operator command (family: upgrade, doctor). Resolves the deployment
// from cwd, drives `docker compose stop` against container/compose.yml with a
// grace matching the fleet supervisor's drain timeout, streams Compose output,
// and checks afterwards whether the container was SIGKILLed mid-run.
//
// A config carrying a `deployment` block takes the other arm instead (#261):
// `deployment.stopCommand` runs literally via /bin/sh and every compose-specific
// step here is skipped. See src/deployment-command.ts.

import type { DeploymentField } from "./config-schema.ts";
import { resolveDeploymentCommands, runLifecycleStep } from "./deployment-command.ts";
import {
  assertHostLifecycle,
  composeFailureError,
  DRAIN_TIMEOUT_SEC,
  dockerOnPath,
  findPhoebeService,
  formatResolveFailure,
  isContainerRunning,
  noDockerMessage,
  parseComposePsJson,
  resolveDeploymentCompose,
  runCompose,
  wasKilledAfterGrace,
  type CommandRunner,
  type DeploymentCompose,
} from "./deployment-compose.ts";

/** Short grace for `phoebe stop --now` — abandon the in-flight unit promptly. */
export const STOP_NOW_TIMEOUT_SEC = 1;

export type ParsedStopArgs = {
  help: boolean;
  /** Abandon the in-flight unit with a short grace. */
  now: boolean;
};

export function parseStopArgs(argv: readonly string[]): ParsedStopArgs {
  let help = false;
  let now = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--now") {
      now = true;
      continue;
    }
    throw new Error(`Unknown flag \`${arg}\` for \`phoebe stop\`. See \`phoebe stop --help\`.`);
  }
  return { help, now };
}

const STOP_HELP_TEXT = `phoebe stop — drain and stop the deployment container (host-side)

Usage:
  phoebe stop          Graceful drain (up to 1h — finish the current work unit)
  phoebe stop --now    Abandon the in-flight unit with a 1s grace

Resolves the deployment from the current directory (the one holding
phoebe.config.ts and container/compose.yml). Passes the deployment .env to
Compose only when it exists. Refuses inside the container — run this on the host.

When phoebe.config.ts carries a "deployment" block, deployment.stopCommand
(or stopNowCommand for --now) runs instead and none of the Compose plumbing
above applies — you own the drain grace. See docs/configuration.md.
`;

type StopIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

type StopDeps = {
  cwd?: string;
  runner?: CommandRunner;
  dockerAvailable?: boolean;
  inContainer?: boolean;
  exists?: (path: string) => boolean;
  /**
   * Literal lifecycle commands from the config (#261). Present ⇒ the compose
   * driver is bypassed entirely. Named apart from the `deployment` local below,
   * which is the resolved *Compose* deployment. {@link runStopCli} reads it off
   * the config; `runStop` only ever consults the dep, which is what keeps it
   * filesystem-free.
   */
  deploymentCommands?: DeploymentField;
  io?: Partial<StopIo>;
};

export type StopOutcome =
  | { kind: "stopped" }
  | { kind: "already-stopped" }
  | { kind: "no-container" }
  | { kind: "killed-mid-run" }
  | { kind: "stopped-now" }
  | { kind: "abandoned-now" };

function formatTimeoutSec(seconds: number): string {
  if (seconds === DRAIN_TIMEOUT_SEC) return "1h";
  if (seconds === STOP_NOW_TIMEOUT_SEC) return "1s";
  return `${seconds}s`;
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

/**
 * Drain and stop the deployment. Returns the outcome; sets `process.exitCode`
 * only via {@link runStopCli}. Pure enough for unit tests with an injected runner.
 */
export async function runStop(opts: { now: boolean; deps?: StopDeps }): Promise<StopOutcome> {
  const cwd = opts.deps?.cwd ?? process.cwd();
  const io: StopIo = {
    stdout: opts.deps?.io?.stdout ?? ((line) => process.stdout.write(`${line}\n`)),
    stderr: opts.deps?.io?.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  };

  // The guard is runtime-general: stop is a host action in every topology, so
  // it fires before the branch below (#189).
  assertHostLifecycle("stop", opts.deps?.inContainer);

  const deploymentCommands = opts.deps?.deploymentCommands;
  if (deploymentCommands !== undefined) {
    // `--now` without a `stopNowCommand` is the plain stop command: the operator
    // has said their runtime has one way down, so honour the flag by running it
    // rather than refusing.
    const nowCommand = opts.now ? deploymentCommands.stopNowCommand : undefined;
    await runLifecycleStep({
      field: nowCommand !== undefined ? "stopNowCommand" : "stopCommand",
      command: nowCommand ?? deploymentCommands.stopCommand,
      cwd,
      announce: io.stdout,
      ...(opts.deps?.runner !== undefined ? { runner: opts.deps.runner } : {}),
    });
    if (opts.now) {
      io.stdout("[phoebe] Stopped (--now).");
      return { kind: "stopped-now" };
    }
    io.stdout("[phoebe] Stopped.");
    return { kind: "stopped" };
  }

  const dockerOk = opts.deps?.dockerAvailable ?? dockerOnPath();
  if (!dockerOk) {
    throw new Error(noDockerMessage("stop"));
  }

  const resolved = resolveDeploymentCompose(cwd, opts.deps?.exists);
  if ("kind" in resolved) {
    throw new Error(formatResolveFailure(resolved));
  }
  const deployment = resolved;

  const rows = await composePs(deployment, opts.deps?.runner);
  const service = findPhoebeService(rows);

  if (service === undefined) {
    io.stdout(
      "[phoebe] No container here — nothing to stop. Is this the right deployment directory?",
    );
    return { kind: "no-container" };
  }

  if (!isContainerRunning(service)) {
    io.stdout("[phoebe] Already stopped.");
    return { kind: "already-stopped" };
  }

  const timeoutSec = opts.now ? STOP_NOW_TIMEOUT_SEC : DRAIN_TIMEOUT_SEC;
  if (opts.now) {
    io.stdout(
      `[phoebe] --now: abandoning any in-flight work unit with a ${formatTimeoutSec(timeoutSec)} grace ` +
        `(the worktree may be dirty).`,
    );
  } else {
    io.stdout(
      `[phoebe] Stopping — waiting up to ${formatTimeoutSec(timeoutSec)} for the engine to drain ` +
        `(finish the current work unit, start no new one). Compose progress follows:`,
    );
  }

  const stopResult = await runCompose({
    deployment,
    args: ["stop", "-t", String(timeoutSec)],
    inheritStdio: true,
    ...(opts.deps?.runner !== undefined ? { runner: opts.deps.runner } : {}),
  });
  if (stopResult.code !== 0) throw composeFailureError(stopResult, "stop");

  // Re-probe: Compose exits 0 whether the container drained or was SIGKILLed
  // after the grace. A unit that never finished must not look like a clean stop.
  const afterPipelines = await composePs(deployment, opts.deps?.runner);
  const after = findPhoebeService(afterPipelines);
  if (after !== undefined && wasKilledAfterGrace(after)) {
    if (opts.now) {
      io.stderr(
        "[phoebe] Container was force-killed after the short --now grace. Any in-flight " +
          "work unit was abandoned; a worktree may be dirty.",
      );
      return { kind: "abandoned-now" };
    }
    io.stderr(
      "[phoebe] WARNING: the container was SIGKILLed after the drain grace expired — " +
        "a work unit did not finish cleanly and a worktree may be dirty. " +
        "This was not a clean stop.",
    );
    return { kind: "killed-mid-run" };
  }

  if (opts.now) {
    io.stdout("[phoebe] Stopped (--now).");
    return { kind: "stopped-now" };
  }
  io.stdout("[phoebe] Stopped.");
  return { kind: "stopped" };
}

/** `phoebe stop` entry. */
export async function runStopCli(argv: readonly string[], deps?: StopDeps): Promise<void> {
  const parsed = parseStopArgs(argv);
  if (parsed.help) {
    process.stdout.write(STOP_HELP_TEXT);
    return;
  }
  // Reading the config is the CLI's job, not `runStop`'s: the run function stays
  // injectable-only so tests never touch a config file. A caller that already
  // has the block passes it through deps and no config is read.
  const cwd = deps?.cwd ?? process.cwd();
  const deploymentCommands = await resolveDeploymentCommands({
    command: "stop",
    cwd,
    inContainer: deps?.inContainer,
    provided: deps?.deploymentCommands,
  });
  const outcome = await runStop({
    now: parsed.now,
    deps: { ...deps, ...(deploymentCommands !== undefined ? { deploymentCommands } : {}) },
  });
  if (outcome.kind === "killed-mid-run") {
    process.exitCode = 1;
  }
}
