// The two ways main reaches a local install's container (#527 §5).
//
// **The read is one exec.** The deployment already writes its whole read model
// down — `state/deployment.json`, the file the relay sender ships and
// `phoebe status` prints (#501, #532) — so reading a local install is running
// that one verb inside the container and taking its stdout. No `config --json`
// beside it, no `doctor --json`: effective config rides in the report and
// doctor's fresh run is a verb run whose outcome is the report (#527 §5).
//
// **The watch is Compose's own event stream.** `docker compose events` is
// `docker events` already filtered to this project, which is what makes it the
// right subscription: main learns about a `start` or a `die` at the moment it
// happens rather than up to 15 s later. The poll is still there, because an
// event stream says nothing about a container that has been up all along.
//
// Both go through the same seams everything else host-side does — `runCompose`
// for the capture, an injectable spawner for the stream — so the loop above can
// be driven without a Docker daemon anywhere near it.

import { spawn } from "node:child_process";
import {
  buildComposeArgv,
  runCompose,
  type CommandRunner,
  type DeploymentCompose,
} from "../../../src/deployment-compose.ts";

/**
 * The service the engine runs as, in the scaffolded compose file. The same name
 * `install-facts.ts` looks for in `ps`.
 */
const PHOEBE_SERVICE = "phoebe";

/**
 * What main execs to get a report. `-T` because there is no TTY behind a window
 * and Compose allocating one would wrap the JSON in control characters.
 *
 * One constant rather than an inline array: `phoebe status --json` is #533's
 * verb, and if its flags move this is the line that moves with it.
 */
export const STATUS_ARGV: readonly string[] = [
  "exec",
  "-T",
  PHOEBE_SERVICE,
  "phoebe",
  "status",
  "--json",
];

/** One read of one container: the report it printed, or why there is none. */
export type ContainerRead =
  | { ok: true; schema: number; report: unknown }
  | { ok: false; reason: string };

/**
 * Exec `phoebe status --json` and make a report of what came back.
 *
 * Never throws. Every way this fails — the daemon down, the container gone
 * between the `ps` and the exec, an engine too old to know the verb, a report
 * whose `schema` is missing — is a sentence the page puts under an empty tab,
 * and a thrown error here would stop the loop that has to keep reading after it.
 */
export async function readContainerReport(opts: {
  deployment: DeploymentCompose;
  runner?: CommandRunner;
}): Promise<ContainerRead> {
  let result;
  try {
    result = await runCompose({
      deployment: opts.deployment,
      args: STATUS_ARGV,
      ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    });
  } catch (error) {
    return { ok: false, reason: firstLine(messageOf(error)) };
  }

  if (result.code !== 0) {
    return { ok: false, reason: firstLine(result.stderr || result.stdout) };
  }

  let body: unknown;
  try {
    body = JSON.parse(result.stdout.trim());
  } catch {
    return { ok: false, reason: "the container did not print a report as JSON" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "the container printed JSON that is not a report" };
  }
  const schema = (body as Record<string, unknown>)["schema"];
  if (typeof schema !== "number") {
    // A body with no schema integer cannot be checked for readability, and a
    // reader that guessed would be rendering fields it has no agreement about.
    return { ok: false, reason: "the report carries no `schema`" };
  }
  return { ok: true, schema, report: body };
}

/** Enough of a child process for the watcher. Injectable so a test is instant. */
export type EventChild = {
  stdout: { on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown } | null;
  on: (event: "close" | "error", listener: (...args: never[]) => void) => unknown;
  kill: (signal: NodeJS.Signals) => unknown;
};

export type EventSpawner = (spec: {
  file: string;
  args: readonly string[];
  cwd: string;
}) => EventChild;

export type WatchDeps = {
  spawn?: EventSpawner;
  /** How long to wait before re-subscribing when the stream ends. */
  restartMs?: number;
  /** Timers, injectable so a test does not wait out a restart. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * A stream that ends is a stream that has to be re-opened: Docker Desktop
 * restarting takes the subscription with it, and a loop that went blind at that
 * moment would be a loop that looks fine and reports nothing.
 */
export const EVENTS_RESTART_MS = 5_000;

/**
 * Subscribe to the install's container lifecycle. `onChange` fires once per
 * event Compose reports for the phoebe service; it carries no payload, because
 * every action means the same thing to the loop — go and look.
 *
 * Returns the unsubscribe.
 */
export function watchContainerEvents(opts: {
  deployment: DeploymentCompose;
  onChange: () => void;
  deps?: WatchDeps;
}): () => void {
  const deps = opts.deps ?? {};
  const spawner = deps.spawn ?? defaultEventSpawner;
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      // A re-subscription must not be the reason the app will not quit.
      handle.unref?.();
      return handle;
    });
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const restartMs = deps.restartMs ?? EVENTS_RESTART_MS;

  let stopped = false;
  let child: EventChild | null = null;
  let timer: unknown = null;

  function subscribe(): void {
    if (stopped) return;
    const argv = buildComposeArgv({
      composeFile: opts.deployment.composeFile,
      envFile: opts.deployment.envFile,
      args: ["events", "--json"],
    });
    let spawned: EventChild;
    try {
      spawned = spawner({ file: "docker", args: argv, cwd: opts.deployment.containerDir });
    } catch {
      // No `docker` to spawn. Try again later; the poll is not running either,
      // so this is the only thing that brings the install back.
      timer = setTimer(subscribe, restartMs);
      return;
    }
    child = spawned;

    // Compose prints one JSON object per line, and a chunk is not a line.
    let rest = "";
    spawned.stdout?.on("data", (chunk) => {
      rest += String(chunk);
      const pieces = rest.split("\n");
      rest = pieces.pop() ?? "";
      for (const piece of pieces) {
        if (concernsPhoebe(piece)) opts.onChange();
      }
    });

    const restart = () => {
      if (stopped) return;
      child = null;
      timer = setTimer(subscribe, restartMs);
    };
    spawned.on("close", restart as () => void);
    spawned.on("error", restart as () => void);
  }

  subscribe();

  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    child?.kill("SIGTERM");
    child = null;
  };
}

/**
 * Is this event line about the engine's own container? Compose scopes the stream
 * to the project already, so the only thing left to drop is a sibling service —
 * and a line that does not parse, which is Compose writing something this does
 * not know about rather than a container moving.
 */
function concernsPhoebe(line: string): boolean {
  const text = line.trim();
  if (text.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const service = (parsed as Record<string, unknown>)["service"];
  return service === undefined || service === PHOEBE_SERVICE;
}

const defaultEventSpawner: EventSpawner = (spec) =>
  spawn(spec.file, spec.args as string[], {
    cwd: spec.cwd,
    stdio: ["ignore", "pipe", "ignore"],
  }) as unknown as EventChild;

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 0 ? line : "the container did not say why";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
