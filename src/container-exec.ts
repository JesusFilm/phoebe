// One exec into the running container from the host, answered as a typed
// outcome (map #690). `phoebe pair` and `phoebe sessions` are host verbs whose
// work happens inside the container — the mint drop and the sessions file are
// both on the far side of the wall — so each runs its in-container half with
// `--json` through Compose, reads the outcome off stdout, and prints it in its
// own words. The same thin exec `phoebe status` is, with the output read
// rather than passed through.

import type { ResolvedRemote } from "./config-schema.ts";
import {
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

export type ContainerExecDeps = {
  cwd: string;
  runner?: CommandRunner;
  dockerAvailable?: boolean;
  exists?: (path: string) => boolean;
  remote?: ResolvedRemote;
  env?: NodeJS.ProcessEnv;
};

/** The deployment, resolved and running — or the reason it is not. */
export async function runningDeployment(
  verb: string,
  deps: ContainerExecDeps,
): Promise<DeploymentCompose> {
  if (!(deps.dockerAvailable ?? dockerOnPath())) throw new Error(noDockerMessage(verb));
  const resolved = resolveDeploymentCompose(deps.cwd, deps.exists);
  if ("kind" in resolved) throw new Error(formatResolveFailure(resolved));
  const ps = await runCompose({
    deployment: resolved,
    args: ["ps", "-a", "--format", "json"],
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
    ...(deps.remote !== undefined ? { remote: deps.remote } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  });
  if (ps.code !== 0) throw composeFailureError(ps, "ps");
  const service = findPhoebeService(parseComposePsJson(ps.stdout));
  if (service === undefined || !isContainerRunning(service)) {
    throw new Error(
      `container not running — \`phoebe ${verb}\` needs it up. Start it with \`phoebe start\`.`,
    );
  }
  return resolved;
}

/**
 * Run `phoebe <args>` inside the container, as `user` when given, and read the
 * last JSON object line off its stdout. A non-zero exit is the in-container
 * half's own message, re-thrown here.
 */
export async function execJsonInContainer<T>(opts: {
  deployment: DeploymentCompose;
  args: readonly string[];
  user?: "root";
  deps: ContainerExecDeps;
}): Promise<T> {
  const argv = ["exec", "-T"];
  if (opts.user !== undefined) argv.push("-u", opts.user);
  argv.push(PHOEBE_SERVICE, "phoebe", ...opts.args);
  const result = await runCompose({
    deployment: opts.deployment,
    args: argv,
    ...(opts.deps.runner !== undefined ? { runner: opts.deps.runner } : {}),
    ...(opts.deps.remote !== undefined ? { remote: opts.deps.remote } : {}),
    ...(opts.deps.env !== undefined ? { env: opts.deps.env } : {}),
  });
  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      said.replace(/^\[phoebe\] /, "") ||
        `phoebe ${opts.args[0]} exited ${result.code} in the container`,
    );
  }
  const line = result.stdout
    .split("\n")
    .map((piece) => piece.trim())
    .filter((piece) => piece.startsWith("{"))
    .at(-1);
  if (line === undefined) {
    throw new Error(`phoebe ${opts.args[0]} printed no outcome in the container`);
  }
  return JSON.parse(line) as T;
}
