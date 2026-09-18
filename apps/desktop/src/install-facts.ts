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
import { existsSync, readFileSync } from "node:fs";
import type { LocalInstall } from "phoebe-agent/contracts";
import { editConfigGetField, editConfigGetRelay } from "../../../src/config-handle.ts";
import {
  findPhoebeService,
  isContainerRunning,
  parseComposePsJson,
  resolveDeploymentCompose,
  runCompose,
  type CommandRunner,
} from "../../../src/deployment-compose.ts";
import type { StoredInstall } from "./companion-file.ts";

/** The config file at the root of an install. */
const CONFIG_FILE = "phoebe.config.ts";

/** The seams the derivation reaches the machine through. All injectable. */
export type FactsDeps = {
  runner?: CommandRunner;
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
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
  const base = {
    dir: stored.dir,
    name: path.basename(stored.dir),
    addedAt: stored.addedAt,
    ...configFacts(stored.dir, exists, deps.read ?? ((file) => readFileSync(file, "utf8"))),
  };

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

/**
 * The config file at the root of an install, and the two facts a rail reads off
 * it: what a relay would call this deployment, and which relay it dials.
 *
 * Read as *source*, never loaded. Loading it would execute the operator's
 * TypeScript in the companion's own process, on every list, for two strings.
 * A config that will not parse, or one that is not there yet, answers the same
 * way an absent block does — the folder's name, and no relay.
 */
function configFacts(
  dir: string,
  exists: (file: string) => boolean,
  read: (file: string) => string,
): { deploymentName: string; relayUrl: string | null } {
  const source = configSource(dir, exists, read);
  return source === null
    ? { deploymentName: path.basename(dir), relayUrl: null }
    : installConfigFacts(dir, source);
}

/**
 * The same two facts, from a config an caller already has in hand — which is
 * what pairing has, because it is about to rewrite it.
 *
 * The name is `relay.name`, or the solo `repoSlug`, or the folder's name: the
 * same order `deploymentName` in bootstrap/boot.ts resolves. A name the rail
 * matched on that the deployment does not answer to would join a local install
 * to somebody else's row.
 */
export function installConfigFacts(
  dir: string,
  configSourceText: string,
): { deploymentName: string; relayUrl: string | null } {
  const relay = editConfigGetRelay(configSourceText);
  const named = relay.ok ? relay.relay?.name : null;
  return {
    deploymentName: named ?? soloSlug(configSourceText) ?? path.basename(dir),
    relayUrl: (relay.ok ? relay.relay?.url : null) ?? null,
  };
}

/** The config's own `repoSlug`, when it declares a usable one. */
function soloSlug(configSourceText: string): string | null {
  const slug = editConfigGetField(configSourceText, "repoSlug");
  if (!slug.ok || !slug.found || typeof slug.literal !== "string") return null;
  const trimmed = slug.literal.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The root config's text, or null when there is none to read. */
function configSource(
  dir: string,
  exists: (file: string) => boolean,
  read: (file: string) => string,
): string | null {
  const file = path.join(dir, CONFIG_FILE);
  if (!exists(file)) return null;
  try {
    return read(file);
  } catch {
    return null;
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
