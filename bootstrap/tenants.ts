// Tenant discovery — how `phoebe boot` finds what to supervise (#58/#63).
//
// A deployment is single (flat) XOR multi-tenant (nested), selected by the
// presence of a `repos/` directory beside the top `phoebe.config.ts`:
//
//   flat  (no repos/)   /etc/phoebe/phoebe.config.ts   → one engine child, the
//                       config is the single tenant, run in place. The #63
//                       single-tenant fast-path: no scanning.
//   nested (repos/)     /etc/phoebe/repos/<owner>/<repo>/phoebe.config.ts
//                       → one engine child per tenant dir, discovered by scan.
//
// The nested `<owner>/<repo>` path is the authoritative tenant identity (#58):
// the filesystem enforces 1:1 repo↔config, and the slug the child validates its
// own config against. In flat mode the slug is unknown to the supervisor (it
// never parses the full config); the child derives it from its loaded config.
//
// This module only *discovers* the current set. The reconcile diff (added /
// removed / changed since last poll) and the child lifecycle live in the
// supervisor (bootstrap/reconcile.ts).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Canonical in-container deployment config dir (compose bind-mounts here). */
export const DEFAULT_CONFIG_DIR = "/etc/phoebe";
/** Per-tenant (and flat-top) config filename. */
export const TENANT_CONFIG_FILE = "phoebe.config.ts";
/** Per-tenant co-located secrets file. */
export const TENANT_ENV_FILE = ".env";
/** Subdir whose presence selects nested/multi-tenant mode. */
export const REPOS_DIR = "repos";

export type DiscoveredTenant = {
  /** Stable id and reconcile key: the tenant's config dir (unique per tenant). */
  id: string;
  /** `owner/repo` in nested mode; null in flat (the child derives it from config). */
  slug: string | null;
  /** Directory the engine child runs in (cwd): holds the config, `.env`, `prompts/`. */
  dir: string;
  /** Absolute path to the tenant's `phoebe.config.ts`. */
  configPath: string;
  /** Absolute path to the tenant's co-located `.env`. */
  envPath: string;
};

export type Discovery =
  | { mode: "flat"; tenants: [DiscoveredTenant] }
  | { mode: "nested"; tenants: DiscoveredTenant[] };

function tenantAt(dir: string, slug: string | null): DiscoveredTenant {
  return {
    id: dir,
    slug,
    dir,
    configPath: join(dir, TENANT_CONFIG_FILE),
    envPath: join(dir, TENANT_ENV_FILE),
  };
}

/** Directory names (only) directly under `parent`; empty if it cannot be read. */
function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Whether a `repos/` dir beside the top config selects nested mode. */
export function isNestedDeployment(configDir: string): boolean {
  try {
    return statSync(join(configDir, REPOS_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover the tenants a deployment should supervise right now. Flat mode always
 * yields exactly one tenant (the top config, run in place); nested mode scans
 * `repos/<owner>/<repo>/` for any dir carrying a `phoebe.config.ts`, sorted by
 * slug for a deterministic, stable supervision order (#58: first in order wins
 * the frontier). An empty `repos/` is a valid nested deployment with zero
 * tenants (mid-add / mid-remove).
 */
export function discoverTenants(configDir: string): Discovery {
  if (!isNestedDeployment(configDir)) {
    return { mode: "flat", tenants: [tenantAt(configDir, null)] };
  }
  const reposRoot = join(configDir, REPOS_DIR);
  const tenants: DiscoveredTenant[] = [];
  for (const owner of listDirs(reposRoot)) {
    for (const repo of listDirs(join(reposRoot, owner))) {
      const dir = join(reposRoot, owner, repo);
      if (existsSync(join(dir, TENANT_CONFIG_FILE))) {
        tenants.push(tenantAt(dir, `${owner}/${repo}`));
      }
    }
  }
  tenants.sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? ""));
  return { mode: "nested", tenants };
}
