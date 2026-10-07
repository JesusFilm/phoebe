// Can the container read a tenant's `.env`?
//
// A workspace's container runs as an unprivileged user, uid 10001
// (templates/container/Dockerfile), and reads each tenant's `.env` through the
// read-only mount of the workspace folder. A `.env` an operator made the usual
// way is mode 0600 and theirs alone, so the container cannot open it. Nothing
// says so: the supervisor finds no `GH_TOKEN`, hands the engine child nothing,
// and the child, having no token, takes itself for the GitHub App arm and
// reports the App's keys missing. The message names a credential arm; the
// cause is a mode bit.
//
// The companion is on the host, where the file's owner, mode and ACL are plain
// to read. So it asks, once per read of the install, for every tenant at once,
// and says which files the container cannot open. And it can fix one: read
// access for that one user and no other, which is how a secrets file should be
// shared with a container. A machine with no ACL tools gets the wider `o+r`,
// and the answer says which of the two was done.
//
// Only a Linux filesystem has anything to ask. A folder on Windows's own disk
// reaches the container through Docker Desktop, which serves every file
// readable; there the answer is nothing, and nothing is warned about.

import path from "node:path";
import type { TenantEnvFacts } from "phoebe-agent/contracts";
import { TENANT_ENV_FILE } from "../../../bootstrap/tenants.ts";
import { editConfigGetField } from "../../../src/config-handle.ts";
import { defaultCommandRunner, type CommandRunner } from "../../../src/deployment-compose.ts";
import { wslLocationOf, wslRunner } from "./wsl.ts";

/** The user every tenant's engine child runs as inside the container. */
export const CONTAINER_UID = 10001;

/**
 * Where a tenant's `.env` is: beside its config, or in the folder its
 * `configDir` names (docs/configuration.md → Asset directory).
 */
export function tenantEnvPath(tenantDir: string, configText: string | null): string {
  const configDir = configText === null ? null : editConfigGetField(configText, "configDir");
  const sub =
    configDir !== null && configDir.ok && configDir.found && typeof configDir.literal === "string"
      ? configDir.literal
      : null;
  return sub === null
    ? path.join(tenantDir, TENANT_ENV_FILE)
    : path.join(tenantDir, sub, TENANT_ENV_FILE);
}

/**
 * One line per file: `<index>|<uid> <gid> <mode>|<acl entries for the container user>`,
 * or `<index>|missing`. `getfacl` may not be installed, and then says nothing.
 * An ACL entry the mask has cut down to nothing is not counted.
 */
const PROBE =
  'i=0; for f in "$@"; do ' +
  'if [ -e "$f" ]; then ' +
  "s=$(stat -c '%u %g %a' \"$f\" 2>/dev/null); " +
  `a=$(getfacl -cn "$f" 2>/dev/null | grep "^user:${CONTAINER_UID}:r" | grep -vc "#effective:-"); ` +
  'echo "$i|$s|$a"; ' +
  'else echo "$i|missing"; fi; ' +
  "i=$((i+1)); done";

/** Give the container's user read access, and say which way it was given. */
const GRANT =
  `if setfacl -m u:${CONTAINER_UID}:r "$1" 2>/dev/null; then echo acl; ` +
  'elif chmod o+r "$1"; then echo mode; else echo failed; fi';

/** What one probe line says about one file. */
export function accessOf(line: string): TenantEnvFacts["access"] | null {
  const [, facts, acl] = line.trim().split("|");
  if (facts === undefined) return null;
  if (facts === "missing") return "missing";
  const [uid, gid, mode] = facts.split(" ");
  if (uid === undefined || gid === undefined || mode === undefined) return null;
  const bits = mode.padStart(3, "0").slice(-3);
  const owner = Number(bits[0]);
  const group = Number(bits[1]);
  const other = Number(bits[2]);
  if (Number.isNaN(owner) || Number.isNaN(group) || Number.isNaN(other)) return null;
  const readable =
    (Number(uid) === CONTAINER_UID && (owner & 4) !== 0) ||
    (Number(gid) === CONTAINER_UID && (group & 4) !== 0) ||
    (other & 4) !== 0 ||
    Number(acl ?? "0") > 0;
  return readable ? "readable" : "unreadable";
}

export type EnvAccessDeps = {
  runner?: CommandRunner;
  /** `process.platform`; a test hands in the one it is about. */
  platform?: string;
};

/**
 * Ask about every file at once, in one child. The answer is by path; a file the
 * probe could not speak for is left out, and so is every file on a filesystem
 * with no permissions to ask about.
 */
export async function probeEnvAccess(
  installDir: string,
  files: readonly string[],
  deps: EnvAccessDeps = {},
): Promise<Map<string, TenantEnvFacts["access"]>> {
  const answers = new Map<string, TenantEnvFacts["access"]>();
  const run = shellFor(installDir, deps);
  if (run === null || files.length === 0) return answers;
  try {
    const result = await run(["-c", PROBE, "sh", ...files]);
    for (const line of result.stdout.split("\n")) {
      const index = Number(line.split("|")[0]);
      const file = files[index];
      const access = accessOf(line);
      if (file !== undefined && access !== null && line.trim() !== "") answers.set(file, access);
    }
  } catch {
    // A distro that is not running, a host with no `sh`: there is nothing to
    // say about these files, which is not the same as something being wrong.
  }
  return answers;
}

/** How read access was given, or that it could not be. */
export type GrantOutcome = "acl" | "mode" | "failed";

/** Let the container's user read one file. */
export async function grantEnvAccess(
  installDir: string,
  file: string,
  deps: EnvAccessDeps = {},
): Promise<GrantOutcome> {
  const run = shellFor(installDir, deps);
  if (run === null) return "failed";
  try {
    const said = (await run(["-c", GRANT, "sh", file])).stdout.trim();
    return said === "acl" || said === "mode" ? said : "failed";
  } catch {
    return "failed";
  }
}

/**
 * `sh`, where the install's files are: inside the distro for a WSL folder, on
 * this machine for a Linux or macOS one. Null on Windows's own filesystem.
 */
function shellFor(
  installDir: string,
  deps: EnvAccessDeps,
): ((args: string[]) => ReturnType<CommandRunner>) | null {
  const runner = deps.runner ?? defaultCommandRunner;
  const wsl = wslLocationOf(installDir);
  if (wsl !== null) {
    const inside = wslRunner(wsl, runner);
    return (args) => inside({ file: "sh", args });
  }
  if ((deps.platform ?? process.platform) === "win32") return null;
  return (args) => runner({ file: "sh", args });
}
