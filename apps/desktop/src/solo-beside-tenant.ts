// A tenant's folder given a deployment of its own, beside the tenant config it
// already carries.
//
// A folder that is a workspace child has `phoebe.config.ts` and nothing to run
// it with: the container is the workspace root's. It can also be a deployment
// in its own right, the way this repository is: the deployment's files sit in
// `.phoebe/` under the folder.
//
// Two deployments must not mean two configs. This used to copy the tenant's
// top-level settings onto the scaffolded config and leave both files standing,
// and the two drifted from the first edit: the copy had no pipelines, no kind
// tuning, nothing nested, and nothing compared them afterwards. So the config
// moves instead (#663). The tenant's `phoebe.config.ts` goes into `.phoebe/`
// whole, where the new deployment reads it, and the root is left a pointer that
// sends the workspace to the same file (docs/configuration.md → One config for a
// repo deployed two ways).
//
// A move is refused where it would break the tenant, and the old copy is made
// in its place, with a line saying why and what is left to do by hand:
//
//   - `.phoebe/phoebe.config.ts` was already there. It is somebody's.
//   - The config names a file relative to itself. One directory down, the same
//     words name a different file.
//   - It already names a `configDir` that is not `.phoebe`.
//   - The workspace above is on an older `phoebe-agent` than this companion,
//     and may hold a tenant whose root has no `repoSlug`.
//
// Every step leaves an existing file alone the way `init` does, so running it
// twice changes nothing.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InitScaffoldOutcome, VerbIo } from "phoebe-agent/contracts";
import { TENANT_CONFIG_FILE, TENANT_ENV_FILE } from "../../../bootstrap/tenants.ts";
import {
  editConfigGetField,
  editConfigInsertFieldSource,
  editConfigRemoveField,
  editConfigSetField,
} from "../../../src/config-handle.ts";
import { runInit, type InitDeps } from "../../../src/init.ts";
import { SETTINGS } from "../../../src/settings-catalogue.ts";
import { compareVersions, readDockerfilePin } from "../../../src/upgrade.ts";
import { NESTED_DEPLOYMENT_DIR } from "./deployment-dir.ts";
import { tenantFilesOf } from "./tenant-files.ts";
import { workspaceBlockOf } from "./workspace-children.ts";

/** The settings a tenant config may hold that a copied deployment should hold too. */
const CARRIED = SETTINGS.filter(
  (setting) => setting.envOnly !== true && !setting.path.includes("."),
).map((setting) => setting.path);

/**
 * What the scaffold says that a tenant config has no reason to: which engine
 * the deployment runs and where its own faults are reported. A workspace reads
 * neither from a child, so a moved config gains them from the scaffold unless it
 * already says otherwise.
 */
const DEPLOYMENT_FIELDS = ["engine", "reporting"] as const;

/** `./x` or `../x` in a string: an import, a custom kind's module, a prompt. */
const RELATIVE_SPECIFIER = /["'`](\.{1,2}\/[^"'`]*)["'`]/;

/** How far above the folder its workspace root is looked for. */
const WORKSPACE_SEARCH_DEPTH = 3;

const NESTED_CONFIG = `${NESTED_DEPLOYMENT_DIR}/${TENANT_CONFIG_FILE}`;

/** The root a moved config leaves behind. */
export const POINTER_SOURCE = `// The config this repository runs on is ${NESTED_CONFIG}.
//
// This file is a pointer to it. A workspace that lists this folder as a tenant
// finds the folder by this file, reads \`configDir\`, and runs the tenant on the
// config in that directory: the same file the deployment in ${NESTED_DEPLOYMENT_DIR}/
// runs on. Change settings there. Nothing else written here is read.
// See docs/configuration.md, "One config for a repo deployed two ways".
export default { configDir: "${NESTED_DEPLOYMENT_DIR}" };
`;

/** The disk, as this module reaches it. Real by default; a test hands in its own. */
export type SoloBesideTenantFs = {
  exists: (file: string) => boolean;
  read: (file: string) => string;
  write: (file: string, text: string) => void;
  copy: (from: string, to: string) => void;
};

const REAL_FS: SoloBesideTenantFs = {
  exists: existsSync,
  read: (file) => readFileSync(file, "utf8"),
  write: (file, text) => writeFileSync(file, text),
  copy: copyFileSync,
};

export function initSoloBesideTenant(opts: {
  /** The tenant's folder. */
  install: string;
  io: VerbIo;
  /** The pin the scaffolded image installs: the companion's own version. */
  cliVersion: string;
  deps?: InitDeps;
  fs?: SoloBesideTenantFs;
}): InitScaffoldOutcome {
  const fs = opts.fs ?? REAL_FS;
  const tenantConfigPath = path.join(opts.install, TENANT_CONFIG_FILE);
  if (!fs.exists(tenantConfigPath)) {
    throw new Error(
      `${opts.install} carries no ${TENANT_CONFIG_FILE}, so there is no tenant here.`,
    );
  }
  const nested = path.join(opts.install, NESTED_DEPLOYMENT_DIR);
  const soloPath = path.join(nested, TENANT_CONFIG_FILE);
  // Asked before the scaffold writes one: a config that was already there is
  // somebody's, and one this run made is ours to fill.
  const hadNestedConfig = fs.exists(soloPath);

  // 1. The deployment's files, under the folder rather than in it.
  opts.io.stdout(`[phoebe] init ${nested}`);
  const outcome = runInit({
    targetDir: nested,
    profile: "solo",
    params: { cliVersion: opts.cliVersion },
    ...(opts.deps === undefined ? {} : { deps: opts.deps }),
  });
  for (const file of outcome.created) opts.io.stdout(`  created  ${file}`);
  for (const file of outcome.updated) opts.io.stdout(`  updated  ${file}`);
  for (const file of outcome.skipped) opts.io.stdout(`  kept     ${file}`);

  // 2. One config for both deployments.
  const tenantSource = fs.read(tenantConfigPath);
  const governing = tenantFilesOf(opts.install, { exists: fs.exists, read: fs.read }).configPath;
  if (governing !== tenantConfigPath) {
    // Already a pointer: a second run, or a folder set up by hand.
    opts.io.stdout(`  kept     ${TENANT_CONFIG_FILE}: it already points at ${NESTED_CONFIG}`);
  } else {
    const blocker = hadNestedConfig
      ? `${NESTED_CONFIG} was already there`
      : moveBlocker({ tenantSource, install: opts.install, cliVersion: opts.cliVersion, fs });
    const moved: MoveResult =
      blocker === null ? moveConfig(tenantSource, fs.read(soloPath)) : { ok: false };
    if (moved.ok) {
      fs.write(soloPath, moved.content);
      fs.write(tenantConfigPath, POINTER_SOURCE);
      opts.io.stdout(`  moved    ${TENANT_CONFIG_FILE} into ${NESTED_CONFIG}`);
      if (moved.added.length > 0) {
        opts.io.stdout(`  added    ${moved.added.join(", ")} from the scaffold`);
      }
      opts.io.stdout(
        `  wrote    ${TENANT_CONFIG_FILE} as a pointer: configDir: "${NESTED_DEPLOYMENT_DIR}"`,
      );
    } else {
      const why = blocker ?? `it could not be edited (${moved.reason ?? "unknown"})`;
      copySettings({ tenantSource, tenantConfigPath, soloPath, outcome, fs, io: opts.io });
      // A config that was already under `.phoebe/` is the layout as someone
      // left it, not a fault. Anything else is a move that did not happen.
      const say = hadNestedConfig ? opts.io.stdout : opts.io.stderr;
      say(`  left     ${TENANT_CONFIG_FILE} where it is: ${why}.`);
      say(
        `           The folder has two configs now. To keep one, move what the root says ` +
          `into ${NESTED_CONFIG} and leave \`export default { configDir: "${NESTED_DEPLOYMENT_DIR}" };\` at the root.`,
      );
    }
  }

  // 3. The tenant's `.env`, where both will read it from now on.
  const rootEnv = path.join(opts.install, TENANT_ENV_FILE);
  const nestedEnv = path.join(nested, TENANT_ENV_FILE);
  if (fs.exists(rootEnv) && !fs.exists(nestedEnv)) {
    fs.copy(rootEnv, nestedEnv);
    opts.io.stdout(`  copied   ${TENANT_ENV_FILE} into ${NESTED_DEPLOYMENT_DIR}/`);
  }

  return outcome;
}

/** Why the tenant's config cannot move into `.phoebe/`, or null when it can. */
function moveBlocker(opts: {
  tenantSource: string;
  install: string;
  cliVersion: string;
  fs: SoloBesideTenantFs;
}): string | null {
  const configDir = editConfigGetField(opts.tenantSource, "configDir");
  if (configDir.ok && configDir.found && configDir.literal !== NESTED_DEPLOYMENT_DIR) {
    return `it names \`configDir: ${configDir.raw}\`, and the deployment is scaffolded into ${NESTED_DEPLOYMENT_DIR}/`;
  }
  const relative = RELATIVE_SPECIFIER.exec(opts.tenantSource);
  if (relative !== null) {
    return `it names a file relative to itself (\`${relative[1]}\`), and one directory down those words name a different file`;
  }
  const workspace = olderWorkspaceAbove(opts.install, opts.cliVersion, opts.fs);
  if (workspace !== null) {
    return (
      `the workspace in ${workspace.dir} runs phoebe-agent ${workspace.version}, older than this ` +
      `companion (${opts.cliVersion}), and may hold a tenant whose root is a pointer. Update it first`
    );
  }
  return null;
}

type MoveResult = { ok: true; content: string; added: string[] } | { ok: false; reason?: string };

/**
 * The tenant's config as the deployment in `.phoebe/` runs it: every word of
 * it, less a `configDir` (the pointer says that now), plus the scaffold's
 * deployment fields where the tenant had none.
 */
function moveConfig(tenantSource: string, scaffoldSource: string): MoveResult {
  const removed = editConfigRemoveField(tenantSource, "configDir");
  if (!removed.ok) return removed;
  let content = removed.content;
  const added: string[] = [];
  for (const key of DEPLOYMENT_FIELDS) {
    const scaffolded = editConfigGetField(scaffoldSource, key);
    if (!scaffolded.ok || !scaffolded.found) continue;
    const inserted = editConfigInsertFieldSource(content, key, scaffolded.raw);
    if (!inserted.ok) return inserted;
    if (inserted.inserted === true) added.push(key);
    content = inserted.content;
  }
  return { ok: true, content, added };
}

/**
 * The copy a refused move falls back to, and what this did before pointers: the
 * tenant's plain top-level settings onto the scaffolded config, and the tenant
 * entry told where the shared folder is. Only literals move, and only onto a
 * field the scaffold left at its placeholder or never wrote — a value already
 * there is somebody's.
 */
function copySettings(opts: {
  tenantSource: string;
  tenantConfigPath: string;
  soloPath: string;
  outcome: InitScaffoldOutcome;
  fs: SoloBesideTenantFs;
  io: VerbIo;
}): void {
  const { fs, io, tenantSource } = opts;
  const scaffolded = opts.outcome.created.some((file) => file.endsWith(TENANT_CONFIG_FILE));
  let soloSource = fs.read(opts.soloPath);
  const carried: string[] = [];
  for (const key of CARRIED) {
    const from = editConfigGetField(tenantSource, key);
    if (!from.ok || !from.found || from.literal === undefined || from.literal === null) continue;
    const at = editConfigGetField(soloSource, key);
    // A config that was already here keeps every value it has.
    if (at.ok && at.found && !scaffolded) continue;
    const set = editConfigSetField(soloSource, key, from.literal);
    if (!set.ok) {
      io.stderr(`  left     ${key}: ${set.reason}`);
      continue;
    }
    soloSource = set.content;
    carried.push(key);
  }
  if (carried.length > 0) {
    fs.write(opts.soloPath, soloSource);
    io.stdout(`  carried  ${carried.join(", ")} into ${NESTED_CONFIG}`);
  }

  const configDir = editConfigGetField(tenantSource, "configDir");
  if (configDir.ok && !configDir.found) {
    const set = editConfigSetField(tenantSource, "configDir", NESTED_DEPLOYMENT_DIR);
    if (set.ok) {
      fs.write(opts.tenantConfigPath, set.content);
      io.stdout(`  set      configDir: "${NESTED_DEPLOYMENT_DIR}" in ${TENANT_CONFIG_FILE}`);
    } else {
      io.stderr(`  left     configDir: ${set.reason}`);
    }
  } else if (configDir.ok && configDir.found) {
    io.stdout(`  kept     configDir as ${TENANT_CONFIG_FILE} already sets it`);
  }
}

/**
 * The workspace root above `install`, when its image is pinned to a
 * `phoebe-agent` older than this companion.
 *
 * A pointer is read by the workspace's bootstrapper, which is the version its
 * image was built from, and one that predates pointers holds the tenant for a
 * missing `repoSlug`. The companion cannot ask a container what it understands,
 * but it does know its own version reads them. So a workspace at or past that
 * version is safe, one behind it is not known to be, and a root this cannot find
 * or cannot read a pin from is not second-guessed.
 */
function olderWorkspaceAbove(
  install: string,
  cliVersion: string,
  fs: SoloBesideTenantFs,
): { dir: string; version: string } | null {
  const mine = versionOf(cliVersion);
  if (mine === null) return null;
  let dir = install;
  for (let level = 0; level < WORKSPACE_SEARCH_DEPTH; level++) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    try {
      const config = path.join(dir, TENANT_CONFIG_FILE);
      if (!fs.exists(config) || workspaceBlockOf(fs.read(config)) === null) continue;
      const dockerfile = path.join(dir, "container", "Dockerfile");
      if (!fs.exists(dockerfile)) return null;
      const pin = readDockerfilePin(fs.read(dockerfile));
      if (pin.kind !== "pinned") return null;
      const theirs = versionOf(pin.version);
      return theirs !== null && compareVersions(theirs, mine) < 0
        ? { dir, version: pin.version }
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** `1.2.3` as numbers, or null for anything that is not a plain release. */
function versionOf(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}
