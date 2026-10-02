// The verb-run registry (#527 §2, §13) — the part of a run that has nothing to
// do with which verb it is.
//
// Runs live in main, not in the renderer, and this is the whole reason: an
// operator who reloads the window mid-upgrade rejoins the same run with the
// lines it has already printed, and closing the window does not abandon a
// `migrate` half way through a fleet.
//
// One run per install, parallel across installs. A second run on a busy install
// is **refused**, never queued: a queue lets an operator stack `stop` behind
// `start` and then watch the wrong one win, minutes later, with no way to say
// which they asked for first.
//
// Which verb does what is not in here — that is verb-dispatch.ts. This module
// knows about ids, buffers, busy-ness and cancellation, and it is the half worth
// testing without a Docker daemon anywhere near it.

import {
  CANCELLABLE_VERBS,
  MAX_RUN_LINES,
  type RunExit,
  type RunLine,
  type VerbIo,
  type VerbOutcome,
  type VerbRun,
  type VerbRunRequest,
} from "phoebe-agent/contracts";
import { BridgeRefusal } from "./channels.ts";

/** Something a cancel can terminate — the shape of a spawned child. */
export type Killable = { kill: (signal: NodeJS.Signals) => unknown };

/**
 * What a run does, once the registry has given it an id and somewhere to write.
 * `register` is how a dispatch hands back the children it spawned, so cancel has
 * something to signal.
 */
export type Dispatch = (
  request: VerbRunRequest,
  context: { io: VerbIo; register: (child: Killable) => void },
) => Promise<VerbOutcome>;

export type RunsDeps = {
  dispatch: Dispatch;
  /** Emitted as each line arrives. Main forwards these to the window. */
  onLine: (line: RunLine) => void;
  /** Emitted once, when the run ends. */
  onExit: (exit: RunExit) => void;
  now?: () => Date;
  /** Run ids. Injectable so a test can read the ids it asserts on. */
  newRunId?: () => string;
};

export type VerbRuns = {
  /** Start a run. Throws {@link BridgeRefusal} `busy` when one is in flight. */
  start: (request: VerbRunRequest) => string;
  /** The install's current or last run, or null when it has never had one. */
  current: (install: string) => VerbRun | null;
  /** SIGTERM the run's children. Throws when the run is over or uncancellable. */
  cancel: (runId: string) => void;
};

type LiveRun = {
  record: VerbRun;
  children: Killable[];
  cancelled: boolean;
};

export function createVerbRuns(deps: RunsDeps): VerbRuns {
  const now = deps.now ?? (() => new Date());
  let counter = 0;
  const newRunId = deps.newRunId ?? (() => `run-${++counter}`);

  /** Keyed by install directory — which is what makes runs parallel across installs. */
  const byInstall = new Map<string, LiveRun>();

  function find(runId: string): LiveRun | undefined {
    for (const run of byInstall.values()) if (run.record.runId === runId) return run;
    return undefined;
  }

  function append(run: LiveRun, stream: "stdout" | "stderr", text: string): void {
    // A verb may hand over a chunk with newlines in it; the contract is one line
    // per event, so the split happens here rather than in six verb modules.
    for (const piece of text.split("\n")) {
      const line: RunLine = { runId: run.record.runId, stream, line: piece };
      run.record.lines.push(line);
      if (run.record.lines.length > MAX_RUN_LINES) run.record.lines.shift();
      deps.onLine(line);
    }
  }

  function finish(run: LiveRun, exit: RunExit): void {
    run.record.exit = exit;
    run.children = [];
    deps.onExit(exit);
  }

  return {
    start(request) {
      const inFlight = byInstall.get(request.install);
      if (inFlight !== undefined && inFlight.record.exit === undefined) {
        throw new BridgeRefusal({
          code: "busy",
          message: `\`phoebe ${inFlight.record.verb}\` is already running on this install`,
          instruction: `Wait for it to finish, or cancel it, then run \`phoebe ${request.verb}\` again.`,
        });
      }

      const runId = newRunId();
      const run: LiveRun = {
        record: {
          runId,
          install: request.install,
          verb: request.verb,
          startedAt: now().toISOString(),
          lines: [],
        },
        children: [],
        cancelled: false,
      };
      byInstall.set(request.install, run);

      const io: VerbIo = {
        stdout: (line) => append(run, "stdout", line),
        stderr: (line) => append(run, "stderr", line),
      };
      const register = (child: Killable) => {
        // A cancel that landed while the child was still spawning still has to
        // reach it, which is why the flag is checked here and not only in cancel.
        if (run.cancelled) child.kill("SIGTERM");
        else run.children.push(child);
      };

      deps.dispatch(request, { io, register }).then(
        (outcome) => {
          if (run.record.exit !== undefined) return;
          // Cancelled and still returning an outcome means the verb caught its
          // child's death and reported it. It is not a success.
          finish(run, run.cancelled ? { runId, code: 1 } : { runId, code: 0, outcome });
        },
        (error: unknown) => {
          if (run.record.exit !== undefined) return;
          // Runs never reject (#527 §2). The reason is a stderr line, where the
          // operator is already reading, and a non-zero exit beside it.
          append(run, "stderr", messageOf(error));
          finish(run, { runId, code: 1 });
        },
      );

      return runId;
    },

    current(install) {
      return byInstall.get(install)?.record ?? null;
    },

    cancel(runId) {
      const run = find(runId);
      if (run === undefined || run.record.exit !== undefined) {
        throw new BridgeRefusal({
          code: "refused",
          message: "that run has already finished",
        });
      }
      if (!CANCELLABLE_VERBS.includes(run.record.verb)) {
        throw new BridgeRefusal({
          code: "refused",
          message: `\`phoebe ${run.record.verb}\` runs in this process and spawns nothing to cancel`,
        });
      }
      run.cancelled = true;
      append(run, "stderr", "[phoebe] cancelled — sending SIGTERM.");
      for (const child of run.children) child.kill("SIGTERM");
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
