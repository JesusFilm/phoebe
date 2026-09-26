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
//
// The version is derived the same way and from the same place `upgrade` moves:
// the `ARG PHOEBE_AGENT_VERSION` pin in `container/Dockerfile` (#525 §6). That
// is the `phoebe-agent` the image is built from, so it is what runs in there —
// and reading the file rather than the container means a stopped install still
// says which version it is stopped on, which is exactly when an operator asks.

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { InstallDirectoryFacts, LocalInstall } from "phoebe-agent/contracts";
import { TENANT_CONFIG_FILE } from "../../../bootstrap/tenants.ts";
import { fingerprintOf } from "../../../src/config-edit.ts";
import { editConfigGetField, editConfigGetRelay } from "../../../src/config-handle.ts";
import {
  defaultCommandRunner,
  findPhoebeService,
  isContainerRunning,
  parseComposePsJson,
  resolveDeploymentCompose,
  runCompose,
  type CommandRunner,
} from "../../../src/deployment-compose.ts";
import { readDockerfilePin, type DockerfilePin } from "../../../src/upgrade.ts";
import type { StoredInstall } from "./companion-file.ts";
import { deploymentDirOf } from "./deployment-dir.ts";
import { workspaceBlockOf, workspaceChildren } from "./workspace-children.ts";
import { wslLocationOf, wslRunner } from "./wsl.ts";

/** The config file at the root of an install. */
const CONFIG_FILE = "phoebe.config.ts";

/** The seams the derivation reaches the machine through. All injectable. */
export type FactsDeps = {
  runner?: CommandRunner;
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
  /** Is `docker` on PATH? False short-circuits the Compose probe. */
  dockerPresent?: boolean;
  /** How `container/Dockerfile` is read — `readFileSync` on a real machine. */
  readFile?: (file: string) => string;
  /** A directory's subdirectories, for a workspace's children. `readdirSync` on a real machine. */
  listDirs?: (dir: string) => string[];
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
  // A folder inside a WSL distro reads like any other; only Docker differs, and
  // for that every command below runs inside the distro (wsl.ts).
  const wsl = wslLocationOf(stored.dir);
  // The deployment's files may sit one folder down in `.phoebe/`
  // (deployment-dir.ts); every fact about the deployment is read from there.
  const root = deploymentDirOf(stored.dir, exists);
  const read = deps.read ?? ((file: string) => readFileSync(file, "utf8"));
  // A workspace root lists its children, found the way the bootstrapper finds
  // them (workspace-children.ts), so the rail can open the root out.
  const block = workspaceBlockOf(configSource(root.dir, exists, read));
  const workspace =
    block === null
      ? null
      : {
          children: workspaceChildren(root.dir, block, {
            exists,
            read,
            ...(deps.listDirs !== undefined ? { listDirs: deps.listDirs } : {}),
          }),
        };
  const base = {
    dir: stored.dir,
    // The operator's label when they gave one; else the folder's name. A WSL
    // folder is named by its Linux path's last segment: the same word on every
    // platform, where `basename` would need Windows's separator to see it.
    name:
      stored.name ??
      (wsl === null ? path.basename(stored.dir) : wsl.dir.split("/").pop() || wsl.distro),
    ...(stored.name === undefined ? {} : { label: stored.name }),
    addedAt: stored.addedAt,
    containerVersion: null,
    ...(wsl === null ? {} : { wsl }),
    ...(root.nested === null ? {} : { deploymentDir: root.nested }),
    ...(workspace === null ? {} : { workspace }),
    ...configFacts(root.dir, exists, read),
  };

  if (!exists(stored.dir)) {
    return { ...base, state: "not-initialised", detail: "this folder is not on disk any more" };
  }

  const deployment = resolveDeploymentCompose(root.dir, exists);
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

  const versioned = { ...base, containerVersion: containerVersion(deployment.containerDir, deps) };

  // This machine's PATH says nothing about a distro's. A WSL install asks its
  // own Compose, and a distro with no Docker answers for itself below.
  if (deps.dockerPresent === false && wsl === null) {
    return {
      ...versioned,
      state: "stopped",
      detail: "`docker` is not on PATH, so nothing can be running",
    };
  }

  const runner = wsl === null ? deps.runner : wslRunner(wsl, deps.runner ?? defaultCommandRunner);

  try {
    const result = await runCompose({
      deployment,
      args: ["ps", "-a", "--format", "json"],
      ...(runner !== undefined ? { runner } : {}),
    });
    if (result.code !== 0) {
      return { ...versioned, state: "stopped", detail: firstLine(result.stderr || result.stdout) };
    }
    const row = findPhoebeService(parseComposePsJson(result.stdout));
    if (row !== undefined && isContainerRunning(row)) return { ...versioned, state: "running" };
    return { ...versioned, state: "stopped" };
  } catch (error) {
    // A daemon that is not up, a compose file that does not parse, a JSON line
    // that is not JSON. All of them mean the same thing for the rail — nothing
    // is running — and differ only in what to tell the operator.
    return { ...versioned, state: "stopped", detail: firstLine(messageOf(error)) };
  }
}

/**
 * The version pinned in this install's Dockerfile, or null when there is none to
 * read. Never throws: an unreadable Dockerfile is a version the tab does not
 * state, and the local arm refuses nothing on a version either way (#525 §6).
 */
function containerVersion(containerDir: string, deps: FactsDeps): string | null {
  const read = deps.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  let pin: DockerfilePin;
  try {
    pin = readDockerfilePin(read(path.join(containerDir, "Dockerfile")));
  } catch {
    return null;
  }
  return pin.kind === "pinned" ? pin.version : null;
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
  const root = deploymentDirOf(install.dir, exists).dir;
  const configPath = path.join(root, TENANT_CONFIG_FILE);

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
    configFingerprint: configText === null ? null : fingerprintOf(configText),
    envPresent: exists(path.join(root, ".env")),
    bootstrapperRunning: install.state === "running",
  };
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
