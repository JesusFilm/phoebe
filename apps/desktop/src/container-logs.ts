// A running install's container output, followed for the logs pane.
//
// `docker compose logs --follow` on the phoebe service, one child per install
// for as long as a pane wants it. The lines it prints are kept here, bounded,
// so a window that opens the pane late — or reloads — joins with the tail
// rather than an empty box, the same reason verb-runs.ts keeps its lines.
//
// It is not the events watcher (container-read.ts): that one re-subscribes when
// its stream ends, because the loop behind it must never go blind. A log stream
// that ends has said something — the container exited, Docker went away — and
// the pane shows that and waits for the operator, who reopens it when the
// container is back.

import {
  LOG_TAIL_LINES,
  MAX_LOG_LINES,
  type LogLine,
  type LogsEnded,
} from "phoebe-agent/contracts";
import { buildComposeArgv, type DeploymentCompose } from "../../../src/deployment-compose.ts";
import type { EventChild, EventSpawner } from "./container-read.ts";

/** The service whose output the pane shows — the one the rail watches. */
const PHOEBE_SERVICE = "phoebe";

export type LogsDeps = {
  /** Emitted as each line arrives. Main forwards these to every window. */
  onLine: (line: LogLine) => void;
  /** Emitted once when a stream stops on its own. Not on `stop`. */
  onEnded: (end: LogsEnded) => void;
};

export type ContainerLogs = {
  /**
   * Follow one install, or join the stream already following it. Returns the
   * lines held so far — empty for a fresh stream, whose tail arrives as lines.
   */
  follow: (install: string, deployment: DeploymentCompose, spawner: EventSpawner) => string[];
  /** End one install's stream and forget its lines. */
  stop: (install: string) => void;
  /** End every stream. The app is quitting. */
  stopAll: () => void;
};

type Following = {
  child: EventChild;
  lines: string[];
  /** The partial last line, held until its newline arrives. */
  rest: string;
};

export function createContainerLogs(deps: LogsDeps): ContainerLogs {
  const following = new Map<string, Following>();

  function push(install: string, entry: Following, line: string): void {
    entry.lines.push(line);
    if (entry.lines.length > MAX_LOG_LINES)
      entry.lines.splice(0, entry.lines.length - MAX_LOG_LINES);
    deps.onLine({ install, line });
  }

  function follow(install: string, deployment: DeploymentCompose, spawner: EventSpawner): string[] {
    const existing = following.get(install);
    if (existing !== undefined) return [...existing.lines];

    const argv = buildComposeArgv({
      composeFile: deployment.composeFile,
      envFile: deployment.envFile,
      args: [
        "logs",
        "--follow",
        "--tail",
        String(LOG_TAIL_LINES),
        // One service, so its name on every line is noise.
        "--no-log-prefix",
        PHOEBE_SERVICE,
      ],
    });

    let child: EventChild;
    try {
      child = spawner({ file: "docker", args: argv, cwd: deployment.containerDir });
    } catch (error) {
      deps.onEnded({ install, reason: messageOf(error) });
      return [];
    }

    const entry: Following = { child, lines: [], rest: "" };
    following.set(install, entry);

    child.stdout?.on("data", (chunk) => {
      entry.rest = emitLines(entry.rest + String(chunk), (line) => push(install, entry, line));
    });

    const ended = (reason: string): void => {
      // A stream `stop` already ended, or one replaced since, is not this one's
      // to report.
      if (following.get(install) !== entry) return;
      if (entry.rest.length > 0) push(install, entry, entry.rest);
      following.delete(install);
      deps.onEnded({ install, reason });
    };
    child.on("close", () => ended("the log stream ended — the container may have stopped"));
    child.on("error", (error: unknown) => ended(messageOf(error)));

    return [];
  }

  function stop(install: string): void {
    const entry = following.get(install);
    if (entry === undefined) return;
    // Forgotten before the kill, so the close that follows is not reported.
    following.delete(install);
    entry.child.kill("SIGTERM");
  }

  return {
    follow,
    stop,
    stopAll: () => {
      // Deleting while iterating a Map is defined: a removed key is not visited.
      for (const install of following.keys()) stop(install);
    },
  };
}

/** Emit every complete line in `buffered`; return the incomplete tail. */
function emitLines(buffered: string, emit: (line: string) => void): string {
  const pieces = buffered.split("\n");
  const rest = pieces.pop() ?? "";
  for (const piece of pieces) emit(piece.replace(/\r$/, ""));
  return rest;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
