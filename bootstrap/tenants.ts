// Tenant discovery — how `phoebe boot` finds what to supervise (#58/#63/#91/#92).
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
//                       Path is *not* owner/repo layout (#58 path↔slug validation
//                       does not apply). Origin is a best-effort cross-check (#92).
//
// Nested `<owner>/<repo>` path is the authoritative tenant identity (#58); in
// workspace mode the authoritative slug is the child's in-tree config (#85).
// Flat mode leaves the slug unknown to the supervisor (null).
//
// This module only *discovers* the current set. The reconcile diff (added /
// removed / changed / held since last poll) and the child lifecycle live in
// the supervisor (bootstrap/supervise-fleet.ts).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { DEFAULT_TENANT_CONFIG_DIR } from "./config-dir.ts";
import { isExplicitWorkspace, type ResolvedWorkspace } from "./workspace-source.ts";

/** Canonical in-container deployment config dir (compose bind-mounts here). */
export const DEFAULT_CONFIG_DIR = "/etc/phoebe";
/** Per-tenant (and flat-top) config filename. */
export const TENANT_CONFIG_FILE = "phoebe.config.ts";
/** Per-tenant co-located secrets file. */
export const TENANT_ENV_FILE = ".env";
/** Subdir whose presence selects nested/multi-tenant mode (when not workspace). */
export const REPOS_DIR = "repos";

export type DiscoveredTenant = {
  /** Stable id and reconcile key: the tenant's normalized absolute config dir. */
  id: string;
  /** `owner/repo` in nested/workspace mode; null in flat (child derives it). */
  slug: string | null;
  /** Directory the engine child runs in (cwd): holds the config, `.env`, `prompts/`. */
  dir: string;
  /** Absolute path to the tenant's `phoebe.config.ts`. */
  configPath: string;
  /** Absolute path to the tenant's co-located `.env`. */
  envPath: string;
  /**
   * Declared spelling from `workspace.tenants`, retained for diagnostics only —
   * reconcile identity is always {@link id}.
   */
  declaredPath?: string;
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

/**
 * Fatal discovery error: two workspace children resolve to the same remote
 * origin slug (transport-normalised). Config `repoSlug` may still differ, but
 * both would clone/work the same GitHub repo — boot aborts (#92).
 */
export class DuplicateOriginSlugError extends Error {
  readonly originSlug: string;
  readonly paths: readonly [string, string];

  constructor(originSlug: string, firstDir: string, secondDir: string) {
    super(
      `workspace discovery: duplicate origin slug "${originSlug}" at ${firstDir} and ${secondDir} — ` +
        `boot cannot supervise two children whose checkouts point at the same remote.`,
    );
    this.name = "DuplicateOriginSlugError";
    this.originSlug = originSlug;
    this.paths = [firstDir, secondDir];
  }
}

/** A held tenant dir and why discovery could not start it this poll. */
export type WorkspaceHold = { id: string; reason: string };

/**
 * Raised when the root `workspace` block is deleted or its arm is switched on a
 * running supervisor — drain the fleet, then abort so boot re-runs the ladder.
 */
export class WorkspaceStructuralChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceStructuralChangeError";
  }
}

/**
 * Raised when the root config or `workspace` block is unreadable/malformed
 * mid-flight — skip the tenant axis this poll and leave the running fleet intact.
 */
export class WorkspaceTenantAxisSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTenantAxisSkip";
  }
}

/** Whether an error is a fatal workspace identity clash (boot must abort). */
export function isFatalWorkspaceDiscoveryError(
  error: unknown,
): error is DuplicateTenantSlugError | DuplicateOriginSlugError {
  return error instanceof DuplicateTenantSlugError || error instanceof DuplicateOriginSlugError;
}

/**
 * Parse a git remote URL to a normalised `owner/repo` slug when it points at
 * GitHub. SSH and HTTPS forms of the same repo return the same slug so the
 * origin↔config compare is transport-tolerant (#92/#85).
 *
 * Returns `null` for empty, malformed, or non-GitHub URLs — callers treat that
 * as an absent origin (admit on config authority).
 */
export function slugFromUrl(url: string): string | null {
  const raw = url.trim();
  if (raw.length === 0) return null;

  // git@github.com:owner/repo.git  (also without .git)
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)$/i.exec(raw);
  if (scp) {
    return normalizeGithubSlug(scp[1]!, scp[2]!);
  }

  // https://github.com/owner/repo(.git) — credentials/port allowed via URL parse
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (!/^github\.com$/i.test(parsed.hostname)) return null;
      const segments = parsed.pathname
        .replace(/^\//, "")
        .split("/")
        .filter((s) => s.length > 0);
      if (segments.length < 2) return null;
      return normalizeGithubSlug(segments[0]!, segments[1]!);
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeGithubSlug(owner: string, repoWithOptionalGit: string): string | null {
  const ownerClean = owner.trim();
  const repoClean = repoWithOptionalGit.trim().replace(/\.git$/i, "");
  if (ownerClean.length === 0 || repoClean.length === 0) return null;
  if (ownerClean.includes("..") || repoClean.includes("..")) return null;
  if (ownerClean.includes("/") || repoClean.includes("/")) return null;
  return `${ownerClean}/${repoClean}`;
}

/**
 * Read `remote.origin.url` from a child checkout (never `.gitmodules`). An
 * unset or unreadable origin is `null` — admitted on config `repoSlug` (#92).
 */
export function readTenantOriginUrl(tenantDir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", tenantDir, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function tenantDirId(configDir: string, dir: string): string {
  return isAbsolute(dir) ? normalize(dir) : resolve(configDir, dir);
}

function tenantAt(
  configDir: string,
  dir: string,
  slug: string | null,
  configDirRel: string = DEFAULT_TENANT_CONFIG_DIR,
  declaredPath?: string,
): DiscoveredTenant {
  const absDir = tenantDirId(configDir, dir);
  // `configDirRel` relocates the tenant's asset dir (its `.env` + prompts) to a
  // subdir of `dir` (#98). The config itself always stays at `dir`; only the
  // `.env` — and thus the engine child's cwd, `dirname(envPath)` — moves.
  const assetsDir =
    configDirRel === DEFAULT_TENANT_CONFIG_DIR ? absDir : join(absDir, configDirRel);
  return {
    id: absDir,
    slug,
    dir: absDir,
    configPath: join(absDir, TENANT_CONFIG_FILE),
    envPath: join(assetsDir, TENANT_ENV_FILE),
    ...(declaredPath === undefined ? {} : { declaredPath }),
  };
}

/**
 * Return a copy of `tenant` with its `.env` (and thus its engine child's cwd,
 * `dirname(envPath)`) relocated under `configDir`, a subdirectory of the tenant
 * dir (#98). `"."` is a no-op. Nested discovery uses this because its sync scan
 * builds tenants before any config is loaded; workspace discovery instead
 * threads `configDir` straight through {@link tenantAt}.
 */
export function withTenantConfigDir(tenant: DiscoveredTenant, configDir: string): DiscoveredTenant {
  if (configDir === DEFAULT_TENANT_CONFIG_DIR) return tenant;
  return { ...tenant, envPath: join(tenant.dir, configDir, TENANT_ENV_FILE) };
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
  /** Per-hold reason strings keyed by tenant id. */
  holdReasons?: ReadonlyMap<string, string>;
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
    return { mode: "flat", tenants: [tenantAt(configDir, configDir, null)] };
  }
  const reposRoot = join(configDir, REPOS_DIR);
  const tenants: DiscoveredTenant[] = [];
  for (const owner of listDirs(reposRoot)) {
    for (const repo of listDirs(join(reposRoot, owner))) {
      const dir = join(reposRoot, owner, repo);
      if (existsSync(join(dir, TENANT_CONFIG_FILE))) {
        tenants.push(tenantAt(configDir, dir, `${owner}/${repo}`));
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
  /**
   * Load a child `phoebe.config.ts` and return its bootstrapper-only `configDir`
   * (asset subdir), or `"."` when unset (#98). Throws/rejects on an unreadable
   * config or a malformed value — the walker then skip-and-warns the dir, the
   * same as a bad `repoSlug`. Defaults to `() => "."` (co-located), so existing
   * callers and tests need no change.
   */
  loadConfigDir?: (configPath: string) => string | Promise<string>;
  /**
   * Read the child checkout's `remote.origin.url` for a best-effort cross-check
   * against config `repoSlug` (#92). Never reads `.gitmodules`. Defaults to
   * {@link readTenantOriginUrl}. Return `null` when origin is absent/unreadable.
   */
  readOriginUrl?: (tenantDir: string) => string | null | Promise<string | null>;
  warn?: (message: string) => void;
};

export type WorkspaceDiscoveryResult = {
  mode: "workspace";
  tenants: DiscoveredTenant[];
  holdIds: string[];
  holdReasons: Map<string, string>;
  /** Set on the explicit arm — how many entries the config declared. */
  declaredCount?: number;
};

/**
 * Discover workspace tenants for either discovery arm (#82/#91/#92/#130).
 *
 * Dispatches candidate enumeration on the arm only; {@link considerTenant} is
 * shared verbatim (slug load, uniqueness, origin cross-check, `configDir`, build).
 */
export async function discoverWorkspaceTenants(
  configDir: string,
  workspace: ResolvedWorkspace,
  deps: DiscoverWorkspaceDeps,
): Promise<WorkspaceDiscoveryResult> {
  if (isExplicitWorkspace(workspace)) {
    return discoverExplicitWorkspaceTenants(configDir, workspace.tenants, deps);
  }
  return discoverWalkWorkspaceTenants(configDir, workspace.depth, deps);
}

type ConsiderOutcome = { ok: true } | { ok: false; reason: string };

async function considerTenant(
  configDir: string,
  absDir: string,
  deps: DiscoverWorkspaceDeps,
  ctx: {
    warn: (message: string) => void;
    readOrigin: (tenantDir: string) => string | null | Promise<string | null>;
    bySlug: Map<string, string>;
    byOriginSlug: Map<string, string>;
    tenants: DiscoveredTenant[];
    declaredPath?: string;
  },
): Promise<ConsiderOutcome> {
  const configPath = join(absDir, TENANT_CONFIG_FILE);
  try {
    const slug = (await deps.loadRepoSlug(configPath)).trim();
    if (slug.length === 0) {
      return { ok: false, reason: "phoebe.config.ts has an empty repoSlug" };
    }

    const priorSlug = ctx.bySlug.get(slug);
    if (priorSlug !== undefined) {
      throw new DuplicateTenantSlugError(slug, priorSlug, absDir);
    }
    ctx.bySlug.set(slug, absDir);

    const originUrl = await ctx.readOrigin(absDir);
    const originSlug =
      originUrl === null || originUrl.trim().length === 0 ? null : slugFromUrl(originUrl);
    if (originSlug !== null) {
      const priorOrigin = ctx.byOriginSlug.get(originSlug);
      if (priorOrigin !== undefined) {
        throw new DuplicateOriginSlugError(originSlug, priorOrigin, absDir);
      }
      ctx.byOriginSlug.set(originSlug, absDir);
    }

    if (originSlug !== null && originSlug !== slug) {
      return {
        ok: false,
        reason: `origin slug "${originSlug}" does not match config repoSlug "${slug}"`,
      };
    }

    const tenantConfigDir = deps.loadConfigDir
      ? (await deps.loadConfigDir(configPath)).trim()
      : DEFAULT_TENANT_CONFIG_DIR;
    ctx.tenants.push(tenantAt(configDir, absDir, slug, tenantConfigDir, ctx.declaredPath));
    return { ok: true };
  } catch (error) {
    if (isFatalWorkspaceDiscoveryError(error)) throw error;
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function discoverWalkWorkspaceTenants(
  configDir: string,
  depth: number,
  deps: DiscoverWorkspaceDeps,
): Promise<WorkspaceDiscoveryResult> {
  const warn = deps.warn ?? (() => {});
  const readOrigin = deps.readOriginUrl ?? readTenantOriginUrl;
  const tenants: DiscoveredTenant[] = [];
  const holdIds: string[] = [];
  const holdReasons = new Map<string, string>();
  const bySlug = new Map<string, string>();
  const byOriginSlug = new Map<string, string>();

  const consider = async (dir: string): Promise<void> => {
    const absDir = tenantDirId(configDir, dir);
    const outcome = await considerTenant(configDir, absDir, deps, {
      warn,
      readOrigin,
      bySlug,
      byOriginSlug,
      tenants,
    });
    if (outcome.ok) return;
    warn(`[phoebe] boot: workspace: skipping ${absDir} — ${outcome.reason}.`);
    holdIds.push(absDir);
    holdReasons.set(absDir, outcome.reason);
  };

  const walk = async (parent: string, remaining: number): Promise<void> => {
    if (remaining < 1) return;
    for (const name of listDirs(parent)) {
      if (shouldSkipWorkspaceDir(name)) continue;
      const dir = join(parent, name);
      if (existsSync(join(dir, TENANT_CONFIG_FILE))) {
        await consider(dir);
      } else {
        await walk(dir, remaining - 1);
      }
    }
  };

  await walk(configDir, depth);
  tenants.sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? ""));
  return { mode: "workspace", tenants, holdIds, holdReasons };
}

async function discoverExplicitWorkspaceTenants(
  configDir: string,
  declared: string[],
  deps: DiscoverWorkspaceDeps,
): Promise<WorkspaceDiscoveryResult> {
  const warn = deps.warn ?? (() => {});
  const readOrigin = deps.readOriginUrl ?? readTenantOriginUrl;
  const tenants: DiscoveredTenant[] = [];
  const holdReasons = new Map<string, string>();
  const bySlug = new Map<string, string>();
  const byOriginSlug = new Map<string, string>();
  const declaredIds: string[] = [];

  for (const entry of declared) {
    const absDir = tenantDirId(configDir, entry);
    declaredIds.push(absDir);

    if (!existsSync(absDir)) {
      holdReasons.set(absDir, "directory does not exist");
      warn(
        `[phoebe] boot: workspace: ${entry} — directory does not exist ` +
          `(resolved to ${absDir}).`,
      );
      continue;
    }

    const configPath = join(absDir, TENANT_CONFIG_FILE);
    if (!existsSync(configPath)) {
      holdReasons.set(absDir, "no phoebe.config.ts");
      warn(`[phoebe] boot: workspace: ${entry} — no phoebe.config.ts at ${absDir}.`);
      continue;
    }

    const outcome = await considerTenant(configDir, absDir, deps, {
      warn,
      readOrigin,
      bySlug,
      byOriginSlug,
      tenants,
      declaredPath: entry,
    });
    if (outcome.ok) continue;
    holdReasons.set(absDir, outcome.reason);
    warn(`[phoebe] boot: workspace: ${entry} — ${outcome.reason}.`);
  }

  const successfulIds = new Set(tenants.map((t) => t.id));
  const holdIds = declaredIds.filter((id) => !successfulIds.has(id));
  return {
    mode: "workspace",
    tenants,
    holdIds,
    holdReasons,
    declaredCount: declared.length,
  };
}
