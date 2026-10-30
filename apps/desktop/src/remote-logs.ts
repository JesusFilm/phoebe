// A remote's container output, followed for the console (map #690).
//
// The local arm follows `docker compose logs` (container-logs.ts). A remote
// has no Docker here to ask, so this holds `GET /api/logs` open on the
// deployment instead: the backlog it sends first, then a line per line, each
// one already redacted on the deployment's side. The lines are kept here,
// bounded the same way, so a window that opens the pane late joins with what
// the deployment held rather than an empty box.
//
// Not the supervisor (remote-supervisor.ts). That one climbs a ladder because
// the rail must never go blind; this one ends when its stream does, says so,
// and waits for the pane to follow again — which the console does when the
// record comes back to connected, exactly as it re-follows a local install
// whose container came back.

import { MAX_LOG_LINES } from "phoebe-agent/contracts";
import type { RemoteLogLine, RemoteLogsEnded } from "phoebe-agent/contracts";
import { REMOTE_ROUTES } from "phoebe-agent/contracts";
import { ESTABLISH_TIMEOUT_MS } from "../../console/src/reachability.ts";
import { BridgeRefusal } from "./channels.ts";
import { createSseReader } from "./sse.ts";

export type RemoteLogsDeps = {
  fetchFn: typeof fetch;
  /** Emitted as each line arrives. Main forwards these to every window. */
  onLine: (line: RemoteLogLine) => void;
  /** Emitted once when a stream stops on its own. Not on `stop`. */
  onEnded: (end: RemoteLogsEnded) => void;
  log?: (line: string) => void;
};

export type RemoteLogs = {
  /**
   * Follow one remote, or join the stream already following it. Resolves with
   * the lines held once the backlog has arrived; rejects when the deployment
   * could not be reached or refused the stream.
   */
  follow: (
    deploymentId: string,
    target: { url: string; bearer: string | null },
  ) => Promise<string[]>;
  /** End one remote's stream and forget its lines. */
  stop: (deploymentId: string) => void;
  /** End every stream. The app is quitting. */
  stopAll: () => void;
};

type Following = {
  controller: AbortController;
  lines: string[];
  /** Resolves with the backlog, for a pane that joins while it is still on its way. */
  ready: Promise<string[]>;
};

export function createRemoteLogs(deps: RemoteLogsDeps): RemoteLogs {
  const log = deps.log ?? (() => {});
  const following = new Map<string, Following>();

  function push(deploymentId: string, entry: Following, line: string): void {
    entry.lines.push(line);
    if (entry.lines.length > MAX_LOG_LINES)
      entry.lines.splice(0, entry.lines.length - MAX_LOG_LINES);
    deps.onLine({ deploymentId, line });
  }

  function follow(
    deploymentId: string,
    target: { url: string; bearer: string | null },
  ): Promise<string[]> {
    const existing = following.get(deploymentId);
    if (existing !== undefined) return existing.ready;

    const controller = new AbortController();
    let settled = false;
    let resolveReady!: (lines: string[]) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<string[]>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const entry: Following = { controller, lines: [], ready };
    following.set(deploymentId, entry);

    const ended = (reason: string): void => {
      // A stream `stop` already ended, or one replaced since, is not this one's
      // to report.
      if (following.get(deploymentId) !== entry) return;
      following.delete(deploymentId);
      if (!settled) {
        settled = true;
        rejectReady(new BridgeRefusal({ code: "undelivered", message: reason }));
        return;
      }
      deps.onEnded({ deploymentId, reason });
    };

    void (async () => {
      // Fifteen seconds to establish, as the supervisor allows: the headers,
      // then the backlog.
      const establish = setTimeout(() => controller.abort(), ESTABLISH_TIMEOUT_MS);
      establish.unref?.();
      let response: Response;
      try {
        response = await deps.fetchFn(`${target.url}${REMOTE_ROUTES.logs}`, {
          signal: controller.signal,
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${target.bearer ?? ""}`,
          },
        });
      } catch (error) {
        clearTimeout(establish);
        ended(
          controller.signal.aborted
            ? `${target.url} did not answer in time`
            : `${target.url} did not answer: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (response.status !== 200 || response.body === null) {
        clearTimeout(establish);
        ended(await refusalLine(response));
        return;
      }
      const feed = createSseReader((frame) => {
        let body: unknown;
        try {
          body = JSON.parse(frame.data);
        } catch {
          return;
        }
        if (frame.name === "backlog") {
          const lines = (body as { lines?: unknown }).lines;
          if (!Array.isArray(lines)) return;
          clearTimeout(establish);
          entry.lines = lines
            .filter((line): line is string => typeof line === "string")
            .slice(-MAX_LOG_LINES);
          if (!settled) {
            settled = true;
            resolveReady([...entry.lines]);
          }
          return;
        }
        if (frame.name === "line") {
          const line = (body as { line?: unknown }).line;
          if (typeof line === "string") push(deploymentId, entry, line);
        }
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let reason = "the log stream ended — the deployment closed it";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        reason = controller.signal.aborted
          ? settled
            ? "the log stream was closed"
            : `${target.url} sent no backlog in time`
          : `the log stream dropped: ${error instanceof Error ? error.message : String(error)}`;
      }
      clearTimeout(establish);
      log(`[phoebe] remote ${target.url}: log stream ended.`);
      ended(reason);
    })();

    return ready;
  }

  function stop(deploymentId: string): void {
    const entry = following.get(deploymentId);
    if (entry === undefined) return;
    // Forgotten before the abort, so the ending that follows is not reported.
    following.delete(deploymentId);
    entry.controller.abort();
  }

  return {
    follow,
    stop,
    stopAll: () => {
      // Deleting while iterating a Map is defined: a removed key is not visited.
      for (const deploymentId of following.keys()) stop(deploymentId);
    },
  };
}

/** What a refused stream says: the deployment's own reason when it gave one. */
async function refusalLine(response: Response): Promise<string> {
  if (response.status === 401) return "the session no longer works here — pair again";
  if (response.status === 403) return "needs read: this session cannot read the deployment";
  if (response.status === 404) return "this deployment keeps no output to show; update it";
  if (response.status === 503) return "the deployment has too many streams open; try again shortly";
  let detail = "";
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = ` ${body.error}`;
  } catch {
    // No body to quote.
  }
  return `the deployment answered ${response.status}${detail}`;
}
