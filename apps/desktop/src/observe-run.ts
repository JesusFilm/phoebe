// Starting an observer run on a local install (#938): one exec of `phoebe
// observe` in its running container. The verb drops its ask for the
// bootstrapper and returns on the ack (#937), so this waits seconds, not for
// the run. The console's History tab then shows the run like any other unit.
//
// The verb prints prose, not JSON, so the answer is read off its exit and its
// first line. Exit 0 printed `[phoebe] <detail>`: the run started. Anything
// else printed `[phoebe] <why>` on stderr, and that is a refusal to show the
// operator, whether the bootstrapper refused or never answered. An engine from
// before #937 does not know the verb, and that reads as "too old" (null).

import type { ObserveRequest, ObserveResponse } from "phoebe-agent/contracts";
import {
  runCompose,
  type CommandRunner,
  type DeploymentCompose,
} from "../../../src/deployment-compose.ts";
import { BridgeRefusal } from "./channels.ts";
import { PHOEBE_SERVICE } from "./container-read.ts";

/**
 * The compose args for one ask. `--name=value` rather than two words, so a
 * value that starts with a dash is still a value. `-T` because there is no TTY
 * behind a window.
 */
export function observeExecArgs(request: ObserveRequest): string[] {
  const args = ["exec", "-T", PHOEBE_SERVICE, "phoebe", "observe"];
  if (request.tenant !== undefined) args.push(`--tenant=${request.tenant}`);
  if (request.lookback !== undefined) args.push(`--lookback=${request.lookback}`);
  return args;
}

/** What an engine that predates `phoebe observe` prints when asked for it. */
const UNKNOWN_VERB = /Unknown command `observe`/;

/** The verb's own lead-in on a refusal, which the console already says in its own words. */
const REFUSED_LEAD = /^the observer run was refused:\s*/;

/**
 * Exec the verb and read its answer. Null when the container's phoebe-agent is
 * too old to know the verb. Rejects only when the exec itself could not run.
 */
export async function runContainerObserve(opts: {
  deployment: DeploymentCompose;
  request: ObserveRequest;
  runner?: CommandRunner;
}): Promise<ObserveResponse | null> {
  let result;
  try {
    result = await runCompose({
      deployment: opts.deployment,
      args: observeExecArgs(opts.request),
      ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    });
  } catch (error) {
    throw new BridgeRefusal({
      code: "unknown",
      message: firstLine(error instanceof Error ? error.message : String(error)),
    });
  }

  if (result.code === 0) {
    const detail = firstLine(result.stdout);
    return {
      outcome: "started",
      detail: detail.length > 0 ? detail : "observer run started.",
      ...(opts.request.tenant === undefined ? {} : { tenant: opts.request.tenant }),
    };
  }
  if (UNKNOWN_VERB.test(`${result.stderr}\n${result.stdout}`)) return null;
  const said = firstLine(result.stderr || result.stdout).replace(REFUSED_LEAD, "");
  return { outcome: "refused", detail: said.length > 0 ? said : "the container did not say why" };
}

/** The first line the container said, without the `[phoebe]` every line of it carries. */
function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.replace(/^\[phoebe\]\s*/, "");
}
