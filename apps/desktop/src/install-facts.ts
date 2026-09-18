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
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { InstallDirectoryFacts, LocalInstall } from "phoebe-agent/contracts";
import { TENANT_CONFIG_FILE } from "../../../bootstrap/tenants.ts";
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

/** The seams the directory read reaches the disk through. */
export type DirectoryDeps = {
  read?: (file: string) => string;
  exists?: (file: string) => boolean;
};

/**
 * What the folder says with no container to ask (#527 §6, #508 §4).
 *
 * This is the whole of a stopped install's page: the config as the file holds
 * it, whether a `.env` is beside it, and the bootstrapper not running. Read
 * every time rather than held, like everything else here — an operator who edits
 * the config in a terminal and clicks refresh is asking exactly this question.
 *
 * The `.env` is checked for existence and never opened. Its contents are
 * secrets, and a fact that travels to a renderer is a fact that can end up in a
 * dev-tools console.
 */
export function directoryFacts(
  install: LocalInstall,
  deps: DirectoryDeps = {},
): InstallDirectoryFacts {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((file: string) => readFileSync(file, "utf8"));
  const configPath = path.join(install.dir, TENANT_CONFIG_FILE);

  let configText: string | null = null;
  try {
    if (exists(configPath)) configText = read(configPath);
  } catch {
    // A config that cannot be read reads as one that is not there. The state on
    // the install already says the folder is not initialised, and a second
    // rendering of the same fault helps nobody.
    configText = null;
  }

  return {
    configPath,
    configText,
    configFingerprint: configText === null ? null : fingerprint(configText),
    envPresent: exists(path.join(install.dir, ".env")),
    bootstrapperRunning: install.state === "running",
  };
}

/** The config's handle: short, stable, and enough to notice an edit (#503). */
function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
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
