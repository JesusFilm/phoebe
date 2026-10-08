// A tenant's folder given a deployment of its own, beside the tenant config it
// already carries.
//
// A folder that is a workspace child has `phoebe.config.ts` and nothing to run
// it with: the container is the workspace root's. It can also be a deployment
// in its own right, the way this repository is (`configDir`, docs/configuration.md):
// the deployment's files sit in `.phoebe/` under the folder, and the tenant
// entry at the root points the workspace at that same folder for its `.env`
// and prompts, so nothing is kept twice.
//
// That is what this does, in four steps and no more. `init --solo` into
// `.phoebe/`; the tenant config's own settings copied onto the scaffolded
// config, so the new deployment works the same repository the same way; the
// tenant entry told where the shared folder is; and a root `.env` copied down,
// since the tenant reads it from `.phoebe/` from now on. Every step leaves an
// existing file alone the way `init` does, so running it twice changes nothing.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InitScaffoldOutcome, VerbIo } from "phoebe-agent/contracts";
import { TENANT_CONFIG_FILE, TENANT_ENV_FILE } from "../../../bootstrap/tenants.ts";
import { editConfigGetField, editConfigSetField } from "../../../src/config-handle.ts";
import { runInit, type InitDeps } from "../../../src/init.ts";
import { SETTINGS } from "../../../src/settings-catalogue.ts";
import { NESTED_DEPLOYMENT_DIR } from "./deployment-dir.ts";

/** The settings a tenant config may hold that the new deployment should hold too. */
const CARRIED = SETTINGS.filter(
  (setting) => setting.envOnly !== true && !setting.path.includes("."),
).map((setting) => setting.path);

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

  // 2. The tenant's settings onto the new config: the same repository, worked
  // the same way. Only plain literals move, and only onto a field the scaffold
  // left at its placeholder or never wrote — a value already there is somebody's.
  const tenantSource = fs.read(tenantConfigPath);
  const soloPath = path.join(nested, TENANT_CONFIG_FILE);
  let soloSource = fs.read(soloPath);
  const carried: string[] = [];
  for (const key of CARRIED) {
    const from = editConfigGetField(tenantSource, key);
    if (!from.ok || !from.found || from.literal === undefined || from.literal === null) continue;
    const at = editConfigGetField(soloSource, key);
    if (at.ok && at.found && !outcome.created.some((file) => file.endsWith(TENANT_CONFIG_FILE))) {
      // A config that was already here keeps every value it has.
      continue;
    }
    const set = editConfigSetField(soloSource, key, from.literal);
    if (!set.ok) {
      opts.io.stderr(`  left     ${key}: ${set.reason}`);
      continue;
    }
    soloSource = set.content;
    carried.push(key);
  }
  if (carried.length > 0) {
    fs.write(soloPath, soloSource);
    opts.io.stdout(
      `  carried  ${carried.join(", ")} into ${NESTED_DEPLOYMENT_DIR}/${TENANT_CONFIG_FILE}`,
    );
  }

  // 3. The tenant entry points the workspace at the shared folder.
  const configDir = editConfigGetField(tenantSource, "configDir");
  if (configDir.ok && !configDir.found) {
    const set = editConfigSetField(tenantSource, "configDir", NESTED_DEPLOYMENT_DIR);
    if (set.ok) {
      fs.write(tenantConfigPath, set.content);
      opts.io.stdout(`  set      configDir: "${NESTED_DEPLOYMENT_DIR}" in ${TENANT_CONFIG_FILE}`);
    } else {
      opts.io.stderr(`  left     configDir: ${set.reason}`);
    }
  } else if (configDir.ok && configDir.found) {
    opts.io.stdout(`  kept     configDir as ${TENANT_CONFIG_FILE} already sets it`);
  }

  // 4. The tenant's `.env`, where both will read it from now on.
  const rootEnv = path.join(opts.install, TENANT_ENV_FILE);
  const nestedEnv = path.join(nested, TENANT_ENV_FILE);
  if (fs.exists(rootEnv) && !fs.exists(nestedEnv)) {
    fs.copy(rootEnv, nestedEnv);
    opts.io.stdout(`  copied   ${TENANT_ENV_FILE} into ${NESTED_DEPLOYMENT_DIR}/`);
  }

  return outcome;
}
