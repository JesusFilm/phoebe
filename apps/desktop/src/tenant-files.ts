// The two files a tenant runs on, found the way the bootstrapper finds them.
//
// A tenant's folder has a `phoebe.config.ts` at its root. That file is usually
// the whole config, with the `.env` beside it. It may name an asset directory
// (`configDir`), and then the `.env` is in there. And it may be a pointer: a
// root that declares `configDir` and no `repoSlug`, whose asset directory holds
// the config the tenant actually runs on (#663, docs/configuration.md → One
// config for a repo deployed two ways).
//
// The bootstrapper answers this by loading the config (`governingConfigPath`,
// bootstrap/tenants.ts). The companion never loads one (install-facts.ts), so
// it reads the two fields off the source text and asks the same function. One
// rule, then, and two ways of reading its inputs.
//
// Everything in the companion that opens a tenant's config or its `.env` comes
// through here: the rail's slug, the config form, a `config set` that names a
// child, and the `.env` access check. A form that showed the pointer's one line
// as a tenant's settings, or a save that wrote a field into it, would be editing
// a file nothing reads.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TENANT_CONFIG_DIR, readConfigDir } from "../../../bootstrap/config-dir.ts";
import {
  governingConfigPath,
  TENANT_CONFIG_FILE,
  TENANT_ENV_FILE,
} from "../../../bootstrap/tenants.ts";
import { editConfigGetField } from "../../../src/config-handle.ts";

export type TenantFiles = {
  /** The config at the tenant's root: the whole config, or a pointer to it. */
  rootConfigPath: string;
  /** The config the tenant runs on. `rootConfigPath` unless that is a pointer. */
  configPath: string;
  /** The `.env` the tenant's engine is handed. */
  envPath: string;
};

export type TenantFilesDeps = {
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
};

/** The files the tenant in `tenantDir` runs on. Never throws: an unreadable root answers itself. */
export function tenantFilesOf(tenantDir: string, deps: TenantFilesDeps = {}): TenantFiles {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((file: string) => readFileSync(file, "utf8"));
  const rootConfigPath = path.join(tenantDir, TENANT_CONFIG_FILE);

  let source: string | null = null;
  try {
    if (exists(rootConfigPath)) source = read(rootConfigPath);
  } catch {
    source = null;
  }

  const configDir = configDirOf(source);
  return {
    rootConfigPath,
    configPath: governingConfigPath({
      dir: tenantDir,
      configDir,
      rootDeclaresSlug: declaresSlug(source),
      exists,
    }),
    envPath:
      configDir === DEFAULT_TENANT_CONFIG_DIR
        ? path.join(tenantDir, TENANT_ENV_FILE)
        : path.join(tenantDir, configDir, TENANT_ENV_FILE),
  };
}

/**
 * The `configDir` the source declares, or `"."`. A value the bootstrapper would
 * refuse (absolute, or reaching out with `..`) reads as none: it holds such a
 * tenant, and the companion does not go looking where it would not.
 */
function configDirOf(source: string | null): string {
  if (source === null) return DEFAULT_TENANT_CONFIG_DIR;
  const field = editConfigGetField(source, "configDir");
  if (!field.ok || !field.found || typeof field.literal !== "string") {
    return DEFAULT_TENANT_CONFIG_DIR;
  }
  try {
    return readConfigDir({ configDir: field.literal }).trim();
  } catch {
    return DEFAULT_TENANT_CONFIG_DIR;
  }
}

/**
 * Whether the root declares a `repoSlug` of its own. A slug that is there but
 * computed counts: the bootstrapper would load it and find a value, so the root
 * governs, and the companion must not decide otherwise from the text alone.
 */
function declaresSlug(source: string | null): boolean {
  if (source === null) return false;
  const field = editConfigGetField(source, "repoSlug");
  if (!field.ok || !field.found) return false;
  return typeof field.literal !== "string" || field.literal.trim().length > 0;
}
