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

import type { DeploymentCommands, ResolvedRemote } from "./config-schema.ts";
import type { ServeOutcome, StartOutcome } from "./contracts/start-outcome.ts";
import type { VerbIo } from "./contracts/verb-io.ts";
import {
  readHostRemote,
  resolveDeploymentCommands,
  runLifecycleStep,
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
import { PHOEBE_SERVICE } from "./status.ts";
import { defaultCommandRunner } from "./deployment-compose.ts";
import { reconcileServe, type ServeDeps } from "./tailscale-serve.ts";
import { PROCESS_IO, SILENT_IO } from "./verb-io.ts";

// The outcome union now lives in `phoebe-agent/contracts` (#552) so a console
// can name a start's result without loading the driver below. Re-exported here
// so every existing reader goes on importing it off this module.
export type { ServeOutcome, StartOutcome };

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

With a "remote" block in phoebe.config.ts the arm's overlay joins the Compose
argv (container/compose.tailscale-<arm>.yml), and on the host arm Serve is
reconciled afterwards so the deployment answers on the tailnet. See
docs/remote.md.

When phoebe.config.ts carries a "deployment" block, deployment.startCommand
runs instead and none of the Compose plumbing above applies (--build is then a
no-op). See docs/configuration.md.
`;

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
   * driver is bypassed entirely. Named apart from the `deployment` local below,
   * which is the resolved *Compose* deployment. {@link runStartCli} reads it off
   * the config; `runStart` only ever consults the dep, which is what keeps it
   * filesystem-free.
   */
  deploymentCommands?: DeploymentCommands;
  /**
   * The `remote` block, resolved (map #690). Present, its arm's overlay joins
   * the Compose argv and on the host arm `PHOEBE_REMOTE_PORT` is exported and
   * Serve is reconciled after the container is up. {@link runStartCli} reads
   * it off the config; `runStart` only ever consults the dep.
   */
  remote?: ResolvedRemote;
  /** Reconciles Serve on the host arm. Defaults to the real CLI and probes. */
  serve?: (opts: { port: number; httpsPort: number }) => Promise<ServeOutcome>;
  /** The environment Compose runs under. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  io?: Partial<VerbIo>;
};

function defaultWaitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function composePs(
  deployment: DeploymentCompose,
  runner: CommandRunner | undefined,
  remote: ResolvedRemote | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<ReturnType<typeof parseComposePsJson>> {
  const result = await runCompose({
    deployment,
    args: ["ps", "-a", "--format", "json"],
    ...(runner !== undefined ? { runner } : {}),
    ...(remote !== undefined ? { remote } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  if (result.code !== 0) throw composeFailureError(result, "ps");
  return parseComposePsJson(result.stdout);
}

/**
 * The host arm's second half (map #690): reconcile Serve, say what came of it,
 * and hand the URL to the container, which has no Tailscale of its own to ask.
 * Nothing on the sidecar arm — containerboot owns Serve there — and nothing
 * without a `remote` block.
 */
export async function serveAfterStart(opts: {
  deployment: DeploymentCompose;
  remote: ResolvedRemote | undefined;
  io: VerbIo;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  serve?: StartDeps["serve"];
}): Promise<ServeOutcome | undefined> {
  const { remote, io } = opts;
  if (remote === undefined || remote.arm !== "host") return undefined;
  const serve =
    opts.serve ??
    ((ports) =>
      reconcileServe(ports, {
        run: defaultCommandRunner,
        fetchFn: fetch,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        log: io.stdout,
      } satisfies ServeDeps));
  const outcome = await serve({ port: remote.port, httpsPort: remote.httpsPort });
  if (outcome.state === "refused") {
    io.stderr(
      `[phoebe] Serve not reconciled: ${outcome.detail} The container is up, but nothing on ` +
        `the tailnet reaches it until this is fixed and \`phoebe start\` runs again.`,
    );
    return outcome;
  }
  io.stdout(
    outcome.state === "ready"
      ? `[phoebe] Reachable on the tailnet at ${outcome.url}`
      : `[phoebe] Mapped on the tailnet at ${outcome.url} (certificate still being issued)`,
  );
  // The deployment's own report carries the URL from here (bootstrap reads the
  // file this writes), which is what `phoebe pair` and the companion show.
  const handed = await runCompose({
    deployment: opts.deployment,
    args: ["exec", "-T", PHOEBE_SERVICE, "phoebe", "remote-url", outcome.url],
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    remote,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  if (handed.code !== 0) {
    io.stderr(
      `[phoebe] could not record ${outcome.url} in the container ` +
        `(${handed.stderr.trim() || handed.stdout.trim() || `exit ${handed.code}`}); ` +
        `\`phoebe status\` will not show the URL until the next \`phoebe start\`.`,
    );
  }
  return outcome;
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
  const io: VerbIo = { ...SILENT_IO, ...opts.deps?.io };
  const waitMs = opts.deps?.waitMs ?? defaultWaitMs;

  // The guard is runtime-general: start is a host action in every topology, so
  // it fires before the branch below (#189).
  assertHostLifecycle("start", opts.deps?.inContainer);

  const deploymentCommands = opts.deps?.deploymentCommands;
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
    await runLifecycleStep({
      field: "startCommand",
      command: deploymentCommands.startCommand,
      cwd,
      announce: io.stdout,
      ...(opts.deps?.runner !== undefined ? { runner: opts.deps.runner } : {}),
    });
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
  const remote = opts.deps?.remote;
  const serveDeps = {
    deployment,
    remote,
    io,
    ...(opts.deps?.runner !== undefined ? { runner: opts.deps.runner } : {}),
    ...(opts.deps?.env !== undefined ? { env: opts.deps.env } : {}),
    ...(opts.deps?.serve !== undefined ? { serve: opts.deps.serve } : {}),
  };

  const beforePipelines = await composePs(deployment, opts.deps?.runner, remote, opts.deps?.env);
  const before = findPhoebeService(beforePipelines);
  if (before !== undefined && isContainerRunning(before)) {
    io.stdout("[phoebe] Already running.");
    // Serve is reconciled on every start, running or not: a mapping that went
    // stale under a running container is still the operator's next question.
    const serve = await serveAfterStart(serveDeps);
    return { kind: "already-running", ...(serve !== undefined ? { serve } : {}) };
  }

  // `--remove-orphans` always: a sidecar that outlives an arm flip is a
  // service the current overlay set no longer names, and this is what removes
  // it rather than leaving it to run beside the new arm (#691).
  const upArgs = opts.build
    ? (["up", "-d", "--build", "--remove-orphans"] as const)
    : (["up", "-d", "--remove-orphans"] as const);
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
    ...(remote !== undefined ? { remote } : {}),
    ...(opts.deps?.env !== undefined ? { env: opts.deps.env } : {}),
  });
  if (upResult.code !== 0) throw composeFailureError(upResult, "up");

  // `up -d` returns once the container is created. A config Phoebe rejects or a
  // missing engine ref makes boot exit seconds later — wait, then re-probe.
  await waitMs(START_SETTLE_MS);

  const afterPipelines = await composePs(deployment, opts.deps?.runner, remote, opts.deps?.env);
  const after = findPhoebeService(afterPipelines);
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
  const serve = await serveAfterStart(serveDeps);
  return { kind: "started", ...(serve !== undefined ? { serve } : {}) };
}

/** `phoebe start` entry. */
export async function runStartCli(argv: readonly string[], deps?: StartDeps): Promise<void> {
  const parsed = parseStartArgs(argv);
  if (parsed.help) {
    process.stdout.write(START_HELP_TEXT);
    return;
  }
  // Reading the config is the CLI's job, not `runStart`'s: the run function
  // stays injectable-only so tests never touch a config file. A caller that
  // already has the block (the tests, a future embedder) passes it through deps
  // and no config is read.
  const cwd = deps?.cwd ?? process.cwd();
  const deploymentCommands = await resolveDeploymentCommands({
    command: "start",
    cwd,
    inContainer: deps?.inContainer,
    provided: deps?.deploymentCommands,
  });
  // The `remote` block, read at the moment the verb runs (map #690): boot-time,
  // so the file is its truth and nothing caches it.
  const remote = deps?.remote ?? (await readHostRemote(cwd));
  // The CLI layer is where a line becomes terminal output: `runStart` is handed
  // the sinks, never `process.stdout` (#552).
  const outcome = await runStart({
    build: parsed.build,
    deps: {
      ...deps,
      io: { ...PROCESS_IO, ...deps?.io },
      ...(deploymentCommands !== undefined ? { deploymentCommands } : {}),
      ...(remote !== undefined ? { remote } : {}),
    },
  });
  if (outcome.kind === "exited-immediately") {
    process.exitCode = 1;
  }
  // A refused Serve is a start that did not deliver what the block asked for.
  if (outcome.kind !== "exited-immediately" && outcome.serve?.state === "refused") {
    process.exitCode = 1;
  }
}
