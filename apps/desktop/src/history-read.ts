// Reading a local install's unit history (#931): one exec of `phoebe history
// --json` in its running container, which prints the same `HistoryPage` a
// remote deployment's `GET /api/history` answers (#930). The console's History
// tab asks for one page at a time, so nothing here is cached or followed.
//
// The verb rather than the files. The history query lives in the engine
// (src/history.ts) and reads the report for its cells, and the host arm of
// `phoebe history` execs itself in the container exactly this way. The secret
// writer (secret-write.ts) execs `phoebe` the same way too.
//
// An engine from before #930 does not know the verb. Its refusal names the
// command, and that is read as "too old" (null) rather than as a failure, so
// the tab can say why there is nothing to show instead of drawing an empty
// table.

import type { HistoryPage, HistoryQuery } from "phoebe-agent/contracts";
import {
  runCompose,
  type CommandRunner,
  type DeploymentCompose,
} from "../../../src/deployment-compose.ts";
import { BridgeRefusal } from "./channels.ts";
import { PHOEBE_SERVICE } from "./container-read.ts";

/** The query fields the verb takes as flags, in the order the argv carries them. */
const QUERY_FLAGS = [
  "cell",
  "kind",
  "outcome",
  "provider",
  "model",
  "since",
  "before",
  "limit",
] as const satisfies readonly (keyof HistoryQuery)[];

/**
 * The compose args for one page. `--name=value` rather than two words, so a
 * value that starts with a dash is still a value. `-T` because there is no TTY
 * behind a window.
 */
export function historyExecArgs(query: HistoryQuery): string[] {
  const args = ["exec", "-T", PHOEBE_SERVICE, "phoebe", "history"];
  for (const name of QUERY_FLAGS) {
    const value = query[name];
    if (value !== undefined) args.push(`--${name}=${String(value)}`);
  }
  args.push("--json");
  return args;
}

/** What an engine that predates `phoebe history` prints when asked for it. */
const UNKNOWN_VERB = /Unknown command `history`/;

/**
 * Exec the verb and read the page it printed. Null when the container's
 * phoebe-agent is too old to know the verb; a refusal for every other way it
 * fails, carrying the first line the container said.
 */
export async function readContainerHistory(opts: {
  deployment: DeploymentCompose;
  query: HistoryQuery;
  runner?: CommandRunner;
}): Promise<HistoryPage | null> {
  let result;
  try {
    result = await runCompose({
      deployment: opts.deployment,
      args: historyExecArgs(opts.query),
      ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    });
  } catch (error) {
    throw unknown(firstLine(error instanceof Error ? error.message : String(error)));
  }

  if (result.code !== 0) {
    const said = `${result.stderr}\n${result.stdout}`;
    if (UNKNOWN_VERB.test(said)) return null;
    throw unknown(firstLine(result.stderr || result.stdout));
  }

  let body: unknown;
  try {
    body = JSON.parse(result.stdout.trim());
  } catch {
    throw unknown("the container did not print a history page as JSON");
  }
  if (!isHistoryPage(body)) throw unknown("the container printed JSON that is not a history page");
  return body;
}

function isHistoryPage(body: unknown): body is HistoryPage {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const page = body as Record<string, unknown>;
  return (
    Array.isArray(page["records"]) &&
    typeof page["summary"] === "object" &&
    page["summary"] !== null &&
    typeof page["retained"] === "object" &&
    page["retained"] !== null &&
    (page["nextBefore"] === null || typeof page["nextBefore"] === "string")
  );
}

function unknown(message: string): BridgeRefusal {
  return new BridgeRefusal({ code: "unknown", message });
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 0 ? line : "the container did not say why";
}
