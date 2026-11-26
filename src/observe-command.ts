// `phoebe observe` (#937, spec #924): start an observer run now rather than
// when its `every` says.
//
// Inside the container it drops an ask under `state/` for the bootstrapper,
// the way `phoebe sessions revoke` does, and returns on the ack. The
// bootstrapper picks the tenant, refuses with a reason or forwards the ask to
// the observer's pipeline, and the run starts on that pipeline's next pass,
// which the ask itself brings forward. Nothing waits for the run: its record
// lands in `phoebe history --kind observer`.
//
// On the host it execs itself in the running container with the same flags,
// as `phoebe history` does.

import { randomBytes } from "node:crypto";
import { observeAckDir, observeDropDir } from "../bootstrap/observe.ts";
import { askDrop, type DropAnswer } from "../bootstrap/file-drop.ts";
import { runningDeployment, type ContainerExecDeps } from "./container-exec.ts";
import { runCompose } from "./deployment-compose.ts";
import { isInsideContainer } from "./execution-gate.ts";
import { isPeriod } from "./manual-run.ts";
import { resolveDataBase } from "./paths.ts";
import { PHOEBE_SERVICE } from "./status.ts";

/** How long the shell waits for the bootstrapper's ack. */
export const OBSERVE_ACK_WAIT_MS = 10_000;

export const OBSERVE_HELP_TEXT = `phoebe observe — start an observer run now

Usage:
  phoebe observe [--tenant <owner/repo>] [--lookback <period>]

Options:
  --tenant <owner/repo>   The tenant to observe. Needed only when more than one
                          tenant declares the observer kind
  --lookback <period>     How far back this run reads, like 14d or 36h. The
                          configured lookback is left as it is

The run skips the observer's \`every\` schedule and starts on its pipeline's
next pass, within seconds. It is refused, never queued, when a run is already
in flight for that tenant, when the fleet is stopped, or when the tenant does
not declare the observer. Follow it with \`phoebe history --kind observer\`.
Run it either side of the container wall: on the host it execs itself in the
running container.
`;

export type ParsedObserveArgs = { help: boolean; tenant: string | null; lookback: string | null };

/** Parse the argv after `observe`. The lookback is checked here too, so a typo fails on the host. */
export function parseObserveArgs(argv: readonly string[]): ParsedObserveArgs {
  const parsed: ParsedObserveArgs = { help: false, tenant: null, lookback: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    const name = (["tenant", "lookback"] as const).find(
      (flag) => arg === `--${flag}` || arg.startsWith(`--${flag}=`),
    );
    if (name === undefined) {
      throw new Error(
        `Unknown ${arg.startsWith("-") ? "flag" : "argument"} \`${arg}\` for \`phoebe observe\`. ` +
          "See `phoebe observe --help`.",
      );
    }
    const inline = arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined;
    const value = inline ?? argv[i + 1];
    if (
      value === undefined ||
      value.length === 0 ||
      (inline === undefined && value.startsWith("-"))
    ) {
      throw new Error(`\`--${name}\` needs a value. See \`phoebe observe --help\`.`);
    }
    if (inline === undefined) i += 1;
    parsed[name] = value;
  }
  if (parsed.lookback !== null && !isPeriod(parsed.lookback)) {
    throw new Error(
      `\`--lookback\` must be a period like 14d or 36h — got ${JSON.stringify(parsed.lookback)}.`,
    );
  }
  return parsed;
}

/** The flags the in-container run is handed, rebuilt rather than forwarded raw. */
export function observeExecArgv(parsed: ParsedObserveArgs): string[] {
  const argv = ["exec", "-T", PHOEBE_SERVICE, "phoebe", "observe"];
  if (parsed.tenant !== null) argv.push(`--tenant=${parsed.tenant}`);
  if (parsed.lookback !== null) argv.push(`--lookback=${parsed.lookback}`);
  return argv;
}

export type ObserveDeps = Partial<ContainerExecDeps> & {
  inContainer?: boolean;
  env?: NodeJS.ProcessEnv;
  ask?: (nonce: string, content: string) => Promise<DropAnswer>;
  random?: (n: number) => Buffer;
  stdout?: (text: string) => void;
};

/** The in-container arm: drop the ask, wait for the ack, and return what it said. */
export async function runObserveInContainer(
  parsed: ParsedObserveArgs,
  deps: ObserveDeps = {},
): Promise<string> {
  const dataBase = resolveDataBase(deps.env ?? process.env);
  const nonce = (deps.random ?? randomBytes)(12).toString("base64url");
  const ask =
    deps.ask ??
    ((n: string, content: string) =>
      askDrop(n, content, {
        dir: observeDropDir(dataBase),
        ackDir: observeAckDir(dataBase),
        waitMs: OBSERVE_ACK_WAIT_MS,
      }));
  let answer: DropAnswer;
  try {
    answer = await ask(nonce, JSON.stringify({ tenant: parsed.tenant, lookback: parsed.lookback }));
  } catch (error) {
    // The drop directory is the bootstrapper's to make; with none, nothing is listening.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notRunning();
    throw error;
  }
  if (answer.kind === "unanswered") throw notRunning();
  if (answer.kind === "refused") throw new Error(`the observer run was refused: ${answer.detail}`);
  return answer.detail;
}

function notRunning(): Error {
  return new Error(
    `the bootstrapper did not answer within ${OBSERVE_ACK_WAIT_MS / 1000} s — is \`phoebe boot\` ` +
      "running on an engine that has the observer?",
  );
}

/** `phoebe observe`. */
export async function runObserveCli(
  argv: readonly string[],
  deps: ObserveDeps = {},
): Promise<void> {
  const parsed = parseObserveArgs(argv);
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  if (parsed.help) {
    stdout(OBSERVE_HELP_TEXT);
    return;
  }
  if (deps.inContainer ?? isInsideContainer()) {
    const detail = await runObserveInContainer(parsed, deps);
    stdout(
      `[phoebe] ${detail.length > 0 ? detail : "observer run started."}\n` +
        "[phoebe] Its record lands in `phoebe history --kind observer` when it settles.\n",
    );
    return;
  }
  const execDeps: ContainerExecDeps = { ...deps, cwd: deps.cwd ?? process.cwd() };
  const deployment = await runningDeployment("observe", execDeps);
  const result = await runCompose({
    deployment,
    args: observeExecArgv(parsed),
    inheritStdio: true,
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
  });
  if (result.code !== 0) process.exitCode = result.code;
}
