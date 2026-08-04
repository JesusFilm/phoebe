// Tenant discovery — how `phoebe boot` finds what to supervise (#58/#63/#91).
//
// A deployment is workspace XOR nested XOR flat, selected by the detection
// ladder (#83): a root config with a `workspace` block → workspace mode (warns
// and ignores any `repos/`); else a `repos/` directory → nested; else flat.
//
//   flat  (no repos/)   /etc/phoebe/phoebe.config.ts   → one engine child, the
//                       config is the single tenant, run in place. The #63
//                       single-tenant fast-path: no scanning.
//   nested (repos/)     /etc/phoebe/repos/<owner>/<repo>/phoebe.config.ts
//                       → one engine child per tenant dir, discovered by scan.
//   workspace           children under the root that carry a root-level
//                       `phoebe.config.ts`; slug from that config's `repoSlug`.
//                       The root declaring `workspace` is never itself a tenant.
//
// Nested `<owner>/<repo>` path is the authoritative tenant identity (#58); in
// workspace mode the authoritative slug is the child's in-tree config (#85).
// Flat mode leaves the slug unknown to the supervisor (null).
//
// This module only *discovers* the current set. The reconcile diff (added /
// removed / changed / held since last poll) and the child lifecycle live in
// the supervisor (bootstrap/supervise-fleet.ts).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Canonical in-container deployment config dir (compose bind-mounts here). */
export const DEFAULT_CONFIG_DIR = "/etc/phoebe";
/** Per-tenant (and flat-top) config filename. */
export const TENANT_CONFIG_FILE = "phoebe.config.ts";
/** Per-tenant co-located secrets file. */
export const TENANT_ENV_FILE = ".env";
/** Subdir whose presence selects nested/multi-tenant mode (when not workspace). */
export const REPOS_DIR = "repos";

export type DiscoveredTenant = {
  /** Stable id and reconcile key: the tenant's config dir (unique per tenant). */
  id: string;
  /** `owner/repo` in nested/workspace mode; null in flat (child derives it). */
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
  | { mode: "nested"; tenants: DiscoveredTenant[] }
  | { mode: "workspace"; tenants: DiscoveredTenant[] };

/**
 * Fatal discovery error: two workspace children claim the same `repoSlug`.
 * Boot aborts (must not soft-skip like a transient read error).
 */
export class DuplicateTenantSlugError extends Error {
  readonly slug: string;
  readonly paths: readonly [string, string];

  constructor(slug: string, firstDir: string, secondDir: string) {
    super(
      `workspace discovery: duplicate repoSlug "${slug}" at ${firstDir} and ${secondDir} — ` +
        `boot cannot supervise two children under one slug.`,
    );
    this.name = "DuplicateTenantSlugError";
    this.slug = slug;
    this.paths = [firstDir, secondDir];
  }
}

function tenantAt(dir: string, slug: string | null): DiscoveredTenant {
  return {
    id: dir,
    slug,
    dir,
    configPath: join(dir, TENANT_CONFIG_FILE),
    envPath: join(dir, TENANT_ENV_FILE),
  };
}

/** A tenant paired with its config fingerprint (mtime:size) at one poll. */
export type TenantSample = { tenant: DiscoveredTenant; fingerprint: string | null };

/**
 * Result of one discovery poll for the fleet supervisor. Flat/nested mode only
 * fills `samples`; workspace mode also lists dirs whose config is transiently
 * unreadable so `diffFleet` *holds* a running child rather than draining it (#86).
 */
export type FleetDiscoverResult = {
  samples: TenantSample[];
  /** Tenant ids (dirs) still present with an unusable config — hold, do not remove. */
  hold?: readonly string[];
};

/**
 * The per-tenant reconcile decision (#58/#86): what changed between the last
 * poll's fingerprint map and the current discovered set.
 * - `added`: a tenant dir that appeared → the supervisor spawns a child.
 * - `removed`: a tenant id that vanished → the supervisor drains + reaps it.
 * - `changed`: a tenant whose config/`.env` fingerprint moved → relaunch it.
 * A null fingerprint on either side is "unknown" and never counts as a change,
 * mirroring the single-engine `detectChange` (a mid-rewrite/unreadable config
 * must not churn the child).
 * Dirs listed in `hold` are still present with a temporarily unusable config:
 * they are not added to `removed` even when absent from `current` (#86 hold).
 */
export type FleetDiff = {
  added: DiscoveredTenant[];
  removed: string[];
  changed: DiscoveredTenant[];
};

export function diffFleet(
  previous: ReadonlyMap<string, string | null>,
  current: readonly TenantSample[],
  hold: ReadonlySet<string> = new Set(),
): FleetDiff {
  const added: DiscoveredTenant[] = [];
  const changed: DiscoveredTenant[] = [];
  const seen = new Set<string>();

  for (const { tenant, fingerprint } of current) {
    seen.add(tenant.id);
    if (!previous.has(tenant.id)) {
      added.push(tenant);
      continue;
    }
    const before = previous.get(tenant.id) ?? null;
    if (before !== null && fingerprint !== null && before !== fingerprint) {
      changed.push(tenant);
    }
  }

  const removed = [...previous.keys()].filter((id) => !seen.has(id) && !hold.has(id));
  return { added, removed, changed };
}

/**
 * Directory names (only) directly under `parent`. A missing `parent` (`ENOENT`)
 * is a real empty set; any *other* error (`EACCES` after a remount, `EMFILE`, …)
 * is unknown state and is re-thrown, never flattened to "no dirs". Flattening it
 * would make `discoverTenants` report zero tenants and the supervisor would drain
 * the entire fleet on a transient blip — the same conservatism `detectChange`
 * applies to an unreadable config.
 */
function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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
 * Discover the tenants a flat or nested deployment should supervise right now.
 * Flat mode always yields exactly one tenant (the top config, run in place);
 * nested mode scans `repos/<owner>/<repo>/` for any dir carrying a
 * `phoebe.config.ts`, sorted by slug for a deterministic, stable supervision
 * order (#58: first in order wins the frontier). An empty `repos/` is a valid
 * nested deployment with zero tenants (mid-add / mid-remove).
 *
 * Workspace mode is *not* selected here — it needs the loaded root config's
 * `workspace` block and async child-config parsing. Call
 * {@link discoverWorkspaceTenants} after {@link readWorkspaceField}.
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

/**
 * Directory names that must never be walked as workspace children — package
 * nests, VCS metadata, and other hidden / tooling dirs (#82).
 */
function shouldSkipWorkspaceDir(name: string): boolean {
  if (name === "node_modules" || name === ".git") return true;
  return name.startsWith(".");
}

export type DiscoverWorkspaceDeps = {
  /**
   * Load a child `phoebe.config.ts` and return its authoritative `repoSlug`.
   * Throws (or rejects) when the file is unreadable or unparseable; the walker
   * then skip-and-warns and records the dir as a hold candidate.
   */
  loadRepoSlug: (configPath: string) => string | Promise<string>;
  warn?: (message: string) => void;
};

/**
 * Walk a workspace tree and discover tenants (#82/#91).
 *
 * - Scan under `configDir` to `depth` (default applied by the caller via
 *   `readWorkspaceField`); the root itself is never a tenant.
 * - Any dir with a root-level `phoebe.config.ts` is a tenant candidate; the
 *   walk prunes there (no tenants inside a found tenant).
 * - A child that cannot be read/parsed is skip-and-warned and listed in
 *   `holdIds` (reconcile holds a still-running child rather than draining).
 * - Two children with the same `repoSlug` throw {@link DuplicateTenantSlugError}.
 */
export async function discoverWorkspaceTenants(
  configDir: string,
  depth: number,
  deps: DiscoverWorkspaceDeps,
): Promise<{ mode: "workspace"; tenants: DiscoveredTenant[]; holdIds: string[] }> {
  const warn = deps.warn ?? (() => {});
  const tenants: DiscoveredTenant[] = [];
  const holdIds: string[] = [];
  const bySlug = new Map<string, string>();

  const consider = async (dir: string): Promise<void> => {
    const configPath = join(dir, TENANT_CONFIG_FILE);
    try {
      const slug = (await deps.loadRepoSlug(configPath)).trim();
      if (slug.length === 0) {
        warn(`[phoebe] boot: workspace: skipping ${dir} — phoebe.config.ts has an empty repoSlug.`);
        holdIds.push(dir);
        return;
      }
      const prior = bySlug.get(slug);
      if (prior !== undefined) {
        throw new DuplicateTenantSlugError(slug, prior, dir);
      }
      bySlug.set(slug, dir);
      tenants.push(tenantAt(dir, slug));
    } catch (error) {
      if (error instanceof DuplicateTenantSlugError) throw error;
      warn(
        `[phoebe] boot: workspace: skipping ${dir} — ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
      holdIds.push(dir);
    }
  };

  const walk = async (parent: string, remaining: number): Promise<void> => {
    if (remaining < 1) return;
    for (const name of listDirs(parent)) {
      if (shouldSkipWorkspaceDir(name)) continue;
      const dir = join(parent, name);
      if (existsSync(join(dir, TENANT_CONFIG_FILE))) {
        // Prune-at-first-hit: this dir is a tenant candidate, never descend.
        await consider(dir);
      } else {
        await walk(dir, remaining - 1);
      }
    }
  };

  await walk(configDir, depth);
  tenants.sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? ""));
  return { mode: "workspace", tenants, holdIds };
}
