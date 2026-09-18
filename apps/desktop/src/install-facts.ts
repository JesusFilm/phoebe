// What is true about a local install right now (#527 §12, #522 §7).
//
// Three states and no fourth: **running**, **stopped**, **not initialised**.
// The relay's connected / dark / unseen verdicts are a remote reader's
// inference from silence, and there is no silence to read here — the container
// is a process on this machine and Compose answers about it directly.
//
// Every one of these facts is derived on each read and none is stored. That is
// the rule `companion.json` is built around, and it is why a folder the operator
// initialised in a terminal shows up as initialised in the window without the
// companion being told.

import path from "node:path";
import { existsSync } from "node:fs";
import type { LocalInstall } from "phoebe-agent/contracts";
import {
  findPhoebeService,
  isContainerRunning,
  parseComposePsJson,
  resolveDeploymentCompose,
  runCompose,
  type CommandRunner,
} from "../../../src/deployment-compose.ts";
import type { StoredInstall } from "./companion-file.ts";

/** The seams the derivation reaches the machine through. All injectable. */
export type FactsDeps = {
  runner?: CommandRunner;
  exists?: (file: string) => boolean;
  /** Is `docker` on PATH? False short-circuits the Compose probe. */
  dockerPresent?: boolean;
};

/**
 * One install's facts.
 *
 * A folder with no `container/compose.yml` is **not initialised** — that file
 * is what `phoebe init` writes and what every lifecycle verb drives, so its
 * absence is the same question the install tab's init button answers.
 *
 * When Docker cannot be asked, the state is **stopped** with the reason on
 * `detail`. Stopped rather than a fourth "unknown" state, because nothing is
 * running when there is no Docker to run it, and a state the rail has to explain
 * is a state that earns its own colour, its own sort position and its own
 * sentence in three places.
 */
export async function installFacts(
  stored: StoredInstall,
  deps: FactsDeps = {},
): Promise<LocalInstall> {
  const exists = deps.exists ?? existsSync;
  const base = { dir: stored.dir, name: path.basename(stored.dir), addedAt: stored.addedAt };

  if (!exists(stored.dir)) {
    return { ...base, state: "not-initialised", detail: "this folder is not on disk any more" };
  }

  const deployment = resolveDeploymentCompose(stored.dir, exists);
  if ("kind" in deployment) {
    return {
      ...base,
      state: "not-initialised",
      detail:
        deployment.kind === "tenant-directory"
          ? "a workspace child, not a deployment — container lifecycle belongs to the workspace root"
          : "no container/compose.yml yet",
    };
  }

  if (deps.dockerPresent === false) {
    return {
      ...base,
      state: "stopped",
      detail: "`docker` is not on PATH, so nothing can be running",
    };
  }

  try {
    const result = await runCompose({
      deployment,
      args: ["ps", "-a", "--format", "json"],
      ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
    });
    if (result.code !== 0) {
      return { ...base, state: "stopped", detail: firstLine(result.stderr || result.stdout) };
    }
    const row = findPhoebeService(parseComposePsJson(result.stdout));
    if (row !== undefined && isContainerRunning(row)) return { ...base, state: "running" };
    return { ...base, state: "stopped" };
  } catch (error) {
    // A daemon that is not up, a compose file that does not parse, a JSON line
    // that is not JSON. All of them mean the same thing for the rail — nothing
    // is running — and differ only in what to tell the operator.
    return { ...base, state: "stopped", detail: firstLine(messageOf(error)) };
  }
}

/** Every install's facts, gathered together. One probe per install, in parallel. */
export function allInstallFacts(
  installs: readonly StoredInstall[],
  deps: FactsDeps = {},
): Promise<LocalInstall[]> {
  return Promise.all(installs.map((install) => installFacts(install, deps)));
}

/**
 * Compose can be wordy about a daemon that is down, and the rail has one line.
 * The first is the sentence; the rest is the stack behind it.
 */
function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 0 ? line : "the container's state could not be read";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
