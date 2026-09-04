// Multi-tenant lifecycle commands (#95/#169) — the in-container CLI surface for
// a deployment that owns many repos rather than a single scaffold. Workspace
// children are scaffolded by `phoebe init --tenant`, so there is no host-side
// add/remove verb here; registering a child is an edit to the root config the
// operator owns (#127 — Phoebe never writes it).
//
//   - `list`   enumerate tenants + health (config valid? env present? retained
//              /data?), through the same #91 discover walk boot supervises
//              with, and one nested line per pipeline (#427). Solo lists the
//              deployment root itself — it is the one tenant.
//   - `purge <owner/repo> --yes`  destructive wipe of a *removed* tenant's
//              retained /data/repos/<slug>; refuses while a live config exists.
//
// The functions here are pure filesystem operations parameterised by the config
// dir and data base, so they are unit-tested against temp dirs; the CLI layer
// (src/cli.ts) resolves those roots and prints the reports.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import { readConfigDir } from "../bootstrap/config-dir.ts";
import {
  type DiscoveredTenant,
  discoverUndeclaredInTreeTenants,
  discoverWorkspaceTenants,
  resolveDeclaredTenantDir,
  TENANT_CONFIG_FILE,
  TENANT_ENV_FILE,
  type WorkspaceHold,
} from "../bootstrap/tenants.ts";
import {
  isExplicitWorkspace,
  resolveWorkspace,
  type ResolvedWorkspace,
} from "../bootstrap/workspace-source.ts";
import { resolveCredentialArm, type CredentialArm } from "../bootstrap/credential-arm.ts";
import { loadUserConfig } from "./load-config.ts";
import { listPipelines, type LoadPipelines, type PipelineListing } from "./pipeline-listing.ts";

/**
 * The named model-A constraint (#61/#63): all tenants share uid 10001, so their
 * `.env` files are NOT DAC-isolated at rest. `init --tenant` prints this on
 * every run — it fires exactly when adding a tenant makes co-tenancy relevant.
 */
export const TRUST_DOMAIN_NOTE =
  "⚠️  One container = one trust domain. All tenants run as the same user, so a " +
  "prompt-injected agent in one repo can read every co-tenant's .env at rest. " +
  "Only co-locate repos whose mutual compromise is already acceptable (same " +
  "org / token scope). Mutually-untrusted repos need separate containers.";

/**
 * Validate and split an `owner/repo` slug. Throws on anything malformed.
 *
 * The character class allows `.` (real repo names contain it, e.g. `foo.js`),
 * so a segment could be exactly `.` or `..` — which every consumer joins into a
 * filesystem path (`purgeTenant`, an `rmSync`).
 * A traversing segment would escape the tenant tree / data base, so reject `.`
 * and `..` as whole segments explicitly (the regex alone cannot, since it must
 * still admit dots inside a name).
 */
export function parseSlug(slug: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(slug);
  if (!match) {
    throw new Error(`Invalid repo slug "${slug}". Expected "owner/repo" (e.g. acme/widget).`);
  }
  const [owner, repo] = [match[1]!, match[2]!];
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new Error(`Invalid repo slug "${slug}": "." and ".." are not allowed path segments.`);
  }
  return { owner, repo };
}

/** Derive the default HTTPS clone URL for a GitHub slug. */
export function defaultRepoUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/**
 * Strip `user[:password]@` userinfo from an http(s) URL so a tokenised origin
 * (e.g. `https://x-access-token:ghs_…@github.com/owner/repo.git`) never lands in
 * a committed `phoebe.config.ts` or a printed init report. SSH scp-like remotes
 * carry no secret and are returned unchanged; unparseable input is returned as-is.
 */
export function stripUrlCredentials(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Render a per-tenant `phoebe.config.ts`. Type-only import (like the shipped
 * solo scaffold) so it loads from the container mount with no `node_modules`;
 * deliberately carries NO `engine` field — engine source is shared, set in the
 * deployment-root config (#60/#63).
 *
 * Used by `init --tenant` (workspace child in-tree installs, #94).
 */
export function renderTenantConfig(fields: {
  repoSlug: string;
  repoUrl: string;
  installCommand: string;
  checkCommand: string;
  testCommand: string;
}): string {
  return `// Per-tenant Phoebe config — scaffolded by \`phoebe init --tenant\`.
//
// One tenant of a multi-tenant deployment. The shared engine source and
// fleet-global knobs live in the deployment-root phoebe.config.ts, not here.
// The written repoSlug is authoritative for workspace discovery (#85).
import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: ${JSON.stringify(fields.repoSlug)},
  repoUrl: ${JSON.stringify(fields.repoUrl)},
  installCommand: ${JSON.stringify(fields.installCommand)},
  checkCommand: ${JSON.stringify(fields.checkCommand)},
  testCommand: ${JSON.stringify(fields.testCommand)},

  // How this repo's commits are attributed (optional, #199). Declaring it here
  // means every deployment that adopts this repo agrees, instead of each one
  // restating it in a \`.env\`. This tenant's own \`.env\` still overrides it.
  // The email must be exactly the address GitHub knows, or the commits link to
  // no account at all.
  // gitIdentity: { name: "Phoebe", email: "12345+phoebe@users.noreply.github.com" },
};

export default config;
`;
}

/** Per-tenant secrets template — copy to `.env`. Written by `init --tenant`. */
export const TENANT_ENV_EXAMPLE = `# Per-tenant secrets — copy to \`.env\`. Read ONLY by this tenant's engine child
# (the supervisor scrubs every other tenant's secrets, #61).

# --- Required (pat arm) ---
# Leave blank when the deployment uses the app credential arm
# (GH_APP_ID / GH_APP_PRIVATE_KEY set on the deployment env-file).
GH_TOKEN=

# --- Provider key (set the one this repo's defaultProvider uses) ---
CURSOR_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_KEY=
`;

/**
 * Placeholder when a child has no `origin` (or an unparseable one) at scaffold
 * time — the operator fills real values before boot.
 */
export const TENANT_PLACEHOLDER_SLUG = "org/repo";
export const TENANT_PLACEHOLDER_URL = defaultRepoUrl(TENANT_PLACEHOLDER_SLUG);

/**
 * Derive `owner/repo` from a git remote URL (HTTPS, SSH scp-like, or ssh://).
 * Returns null when the URL does not yield a well-formed slug.
 */
export function slugFromRemoteUrl(url: string): string | null {
  const raw = url.trim();
  if (raw.length === 0) return null;

  let path: string | undefined;
  // scp-like `user@host:owner/repo` — any username, host without `:`/`/`.
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(raw);
  if (scp) {
    path = scp[1];
  } else {
    // https://host/owner/repo[.git], ssh://git@host/owner/repo, with optional userinfo
    const m = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?[^/\s]+[/:](.+)$/.exec(raw);
    path = m?.[1];
  }
  if (path === undefined) return null;

  // Strip terminal slashes before the `.git` suffix so `…/repo.git/` → `repo`.
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;

  // Last two path segments → owner/repo (GitHub; also last-two for deeper hosts).
  const owner = parts[parts.length - 2]!;
  const repo = parts[parts.length - 1]!;
  try {
    parseSlug(`${owner}/${repo}`);
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

export type TenantListing = {
  /** Display path: the declared entry, or the walk-relative tenant dir. */
  path: string;
  /** Authoritative `repoSlug` when the config was readable; null otherwise. */
  slug: string | null;
  /** Discovery would skip this dir now; the child may still be running (#129). */
  held: boolean;
  /** Observational hold reason; null when not held. */
  reason: string | null;
  configValid: boolean;
  envPresent: boolean;
  retainedData: boolean;
  /**
   * One line per pipeline beneath the tenant row (#427): the pipelines the
   * supervisor would spawn, plus any `state/<name>/` directory no pipeline
   * produces. A held tenant's lines come off disk — see {@link listPipelines}.
   */
  pipelines: PipelineListing[];
  /**
   * Resolved credential arm: `"pat"` when an explicit `GH_TOKEN` is present in
   * the tenant's `.env`, `"app"` when there is none and the deployment holds a
   * GitHub App key. Shared resolver — never re-derived per surface (#162).
   */
  arm: CredentialArm;
  /**
   * Whether the tenant's `phoebe.config.ts` declares `disabled: true` (#202).
   * A disabled tenant is still discovered and listed, but the engine starts no
   * new work for it. Distinct from `held` (a discovery error) and quarantine
   * (Phoebe's own decision): this is the operator's deliberate off-switch.
   */
  disabled: boolean;
};

export type ListTenantsResult = {
  listings: TenantListing[];
  /** Total rows (declared count on the explicit arm). */
  declared: number;
  /** Rows discovery would supervise now (non-held). */
  live: number;
  /** True when the root config uses `workspace.tenants`. */
  explicit: boolean;
  /** True when the root config is the tenant — a solo deployment (#427). */
  solo: boolean;
  /**
   * In-tree config-carrying dirs not declared in `workspace.tenants` (explicit
   * arm only; empty otherwise). Depth-1 scan — a hint, not a guarantee (#141).
   */
  undeclared: string[];
};

/** Legend line for held rows (#129). */
export const LIST_HELD_LEGEND =
  "held = discovery would skip this dir now; a held tenant may still be running — " +
  "the supervisor only drops a tenant when you edit the config.";

/** Legend line for stale pipeline dirs — the per-pipeline analogue of undeclared (#427). */
export const LIST_STALE_LEGEND =
  "stale = state/<name>/ directory this tenant's config no longer declares (a renamed or " +
  "deleted pipeline); nothing writes it, and deleting the directory is safe.";

/** Legend line for undeclared rows on the explicit arm (#141). */
export const LIST_UNDECLARED_LEGEND =
  "undeclared = in-tree directory with phoebe.config.ts not listed in workspace.tenants " +
  "(depth-1 scan only — out-of-tree and nested candidates are invisible by design).";

/** Whether a `.env` (not just the example) is present for a tenant dir. */
function envPresent(dir: string): boolean {
  return existsSync(join(dir, TENANT_ENV_FILE));
}

/**
 * Resolve the credential arm from a tenant's `.env` file, weighed against this
 * process's env for the deployment's App key. An absent or unreadable `.env`
 * resolves the same way an empty one would — no explicit token, so the App key
 * decides.
 */
function readTenantArm(envPath: string): CredentialArm {
  let tenantEnv: Record<string, string | undefined>;
  try {
    tenantEnv = parseDotenv(readFileSync(envPath, "utf8"));
  } catch {
    tenantEnv = {};
  }
  return resolveCredentialArm(tenantEnv, process.env);
}

/** The tenant's `state/` dir, or null when its slug was never recovered. */
function stateDirFor(dataBase: string, slug: string | null): string | null {
  return slug === null ? null : join(dataBase, slug, "state");
}

/** Health columns plus pipeline lines for one live tenant dir. */
async function listingForLive(opts: {
  path: string;
  slug: string;
  dir: string;
  configPath: string;
  dataBase: string;
  configValid: boolean;
  envPath?: string;
  disabled?: boolean;
  loadPipelines?: LoadPipelines;
}): Promise<TenantListing> {
  const resolvedEnvPath = opts.envPath ?? join(opts.dir, TENANT_ENV_FILE);
  const dataDir = join(opts.dataBase, opts.slug);
  return {
    path: opts.path,
    slug: opts.slug,
    held: false,
    reason: null,
    configValid: opts.configValid,
    envPresent: envPresent(opts.dir),
    retainedData: existsSync(dataDir),
    pipelines: await listPipelines({
      configPath: opts.configPath,
      stateDir: stateDirFor(opts.dataBase, opts.slug),
      dataBase: opts.dataBase,
      ...(opts.loadPipelines !== undefined ? { loadRows: opts.loadPipelines } : {}),
    }),
    arm: readTenantArm(resolvedEnvPath),
    disabled: opts.disabled ?? false,
  };
}

/**
 * Health columns for a held row; lit when discovery recovered a slug (#140).
 *
 * Its pipeline lines come off disk: a hold *is* the config being unreadable, so
 * there is no pipeline set to enumerate, and the snapshots are the only evidence of
 * what this tenant was running when discovery lost sight of it.
 */
async function listingForHeld(
  path: string,
  dir: string,
  hold: WorkspaceHold,
  dataBase: string,
): Promise<TenantListing> {
  const slug = hold.slug;
  const configReadable = slug !== null;
  const dataDir = slug !== null ? join(dataBase, slug) : null;
  return {
    path,
    slug,
    held: true,
    reason: hold.reason,
    configValid: configReadable,
    envPresent: envPresent(dir),
    retainedData: dataDir !== null && existsSync(dataDir),
    pipelines: await listPipelines({
      configPath: null,
      stateDir: stateDirFor(dataBase, slug),
      dataBase,
    }),
    arm: readTenantArm(join(dir, TENANT_ENV_FILE)),
    disabled: false,
  };
}

function relativeTenantPath(configDir: string, dir: string): string {
  const rel = relative(configDir, dir).replace(/\\/g, "/");
  return rel.length > 0 ? rel : dir;
}

/**
 * Load a workspace child's authoritative `repoSlug` (same contract boot uses).
 * Throws when the file will not load or the slug is missing — the discovery
 * walk then skip-and-warns and holds the dir.
 */
async function defaultLoadRepoSlug(configPath: string): Promise<string> {
  const user = await loadUserConfig(configPath);
  const slug = user.repoSlug;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error(`missing or empty repoSlug in ${configPath}`);
  }
  return slug.trim();
}

/**
 * Resolve the root `workspace` block, if any. A missing / unreadable root config
 * is not workspace mode (the detection ladder falls through to solo). A
 * present but *malformed* `workspace` field throws — same as boot.
 *
 * Returns the whole resolved block rather than a bare depth (#128): on the
 * explicit arm there is no `depth`, and reading one would yield `undefined`,
 * drop `phoebe list` out of workspace mode, and report a declared fleet as no
 * tenants at all.
 */
async function resolveRootWorkspace(configDir: string): Promise<ResolvedWorkspace | null> {
  const rootConfigPath = join(configDir, TENANT_CONFIG_FILE);
  if (!existsSync(rootConfigPath)) return null;
  let root: Record<string, unknown>;
  try {
    root = (await loadUserConfig(rootConfigPath)) as Record<string, unknown>;
  } catch {
    return null;
  }
  return resolveWorkspace(root, { root: configDir });
}

/**
 * Load a workspace child's bootstrapper-only `configDir` (#98) — the asset
 * subdir its `.env` lives in. Mirrors boot's reader so a caller that needs a
 * tenant's real `envPath` (`scripts/verify-tenant-token.mjs`, #154) gets the
 * same path the engine child will.
 */
async function defaultLoadConfigDir(configPath: string): Promise<string> {
  const user = await loadUserConfig(configPath);
  return readConfigDir(user as unknown as Record<string, unknown>);
}

/**
 * Read `disabled` from a tenant config (#202). Returns `false` when the file
 * cannot be loaded or the field is absent — safe default matches the engine's
 * CONFIG_DEFAULTS.
 */
async function defaultLoadDisabled(configPath: string): Promise<boolean> {
  try {
    const user = await loadUserConfig(configPath);
    return (user as { disabled?: unknown }).disabled === true;
  } catch {
    return false;
  }
}

export type WorkspaceEnumeration = {
  workspace: ResolvedWorkspace;
  explicit: boolean;
  tenants: DiscoveredTenant[];
  holds: WorkspaceHold[];
};

/**
 * The injectable halves of workspace discovery: how a child's config is read,
 * and how its checkout's origin is. Every fleet-wide entry point takes the same
 * bundle and forwards it unchanged, so `phoebe list`, `phoebe purge`, and a
 * token sweep can never disagree about what the fleet is. Each is optional and
 * defaults to the real reader; tests override them to avoid on-disk configs and
 * git calls.
 */
export type TenantDiscoverySeams = {
  loadRepoSlug?: (configPath: string) => string | Promise<string>;
  loadConfigDir?: (configPath: string) => string | Promise<string>;
  readOriginUrl?: (tenantDir: string) => string | null | Promise<string | null>;
  /** Read `disabled` from a tenant config; defaults to reading `phoebe.config.ts`. */
  loadDisabled?: (configPath: string) => boolean | Promise<boolean>;
  /** Enumerate a tenant's pipelines; defaults to the in-process enumerator (#427). */
  loadPipelines?: LoadPipelines;
};

/** Drop the unset seams, so an absent override never shadows a default. */
function definedSeams(seams: TenantDiscoverySeams): TenantDiscoverySeams {
  return {
    ...(seams.loadRepoSlug !== undefined ? { loadRepoSlug: seams.loadRepoSlug } : {}),
    ...(seams.loadConfigDir !== undefined ? { loadConfigDir: seams.loadConfigDir } : {}),
    ...(seams.readOriginUrl !== undefined ? { readOriginUrl: seams.readOriginUrl } : {}),
    ...(seams.loadDisabled !== undefined ? { loadDisabled: seams.loadDisabled } : {}),
    ...(seams.loadPipelines !== undefined ? { loadPipelines: seams.loadPipelines } : {}),
  };
}

/**
 * Resolve the root `workspace` block and run the same discovery boot runs,
 * returning the raw {@link DiscoveredTenant}s rather than display rows — the
 * single seam every fleet-wide caller shares (#154). `phoebe list` renders these
 * rows (via {@link listWorkspaceTenants}) and `scripts/verify-tenant-token.mjs`
 * probes their tokens, so a sweep can never enumerate a different fleet from the
 * one the supervisor supervises. `null` when the root is not a workspace,
 * letting callers fall through the detection ladder (#83) as boot does.
 */
export async function enumerateWorkspaceTenants(
  opts: TenantDiscoverySeams & { configDir: string },
): Promise<WorkspaceEnumeration | null> {
  const workspace = await resolveRootWorkspace(opts.configDir);
  if (workspace === null) return null;
  const discovery = await discoverWorkspaceTenants(opts.configDir, workspace, {
    loadRepoSlug: opts.loadRepoSlug ?? defaultLoadRepoSlug,
    loadConfigDir: opts.loadConfigDir ?? defaultLoadConfigDir,
    ...(opts.readOriginUrl !== undefined ? { readOriginUrl: opts.readOriginUrl } : {}),
  });
  return {
    workspace,
    explicit: isExplicitWorkspace(workspace),
    tenants: discovery.tenants,
    holds: discovery.holds,
  };
}

/**
 * Render one {@link WorkspaceEnumeration} as `phoebe list` rows (#91/#140). The
 * explicit arm prints one row per declared entry in declared order; the walk arm
 * keeps its slug sort. Held dirs surface a first-class `held — <reason>` row
 * rather than a line of ✗s.
 */
async function listWorkspaceTenants(opts: {
  configDir: string;
  dataBase: string;
  enumeration: WorkspaceEnumeration;
  loadDisabled?: TenantDiscoverySeams["loadDisabled"];
  loadPipelines?: LoadPipelines;
}): Promise<ListTenantsResult> {
  const { explicit, workspace, ...discovery } = opts.enumeration;
  const loadDisabledFn = opts.loadDisabled ?? defaultLoadDisabled;

  // Discovery keys both tenants and holds by normalized absolute dir (#139), so
  // the declared spelling is resolved the same way before either lookup.
  const tenantByDir = new Map(discovery.tenants.map((tenant) => [tenant.id, tenant]));
  const holdByDir = new Map(discovery.holds.map((hold) => [hold.dir, hold]));
  const listings: TenantListing[] = [];

  if (isExplicitWorkspace(workspace)) {
    for (const entry of workspace.tenants) {
      const dir = resolveDeclaredTenantDir(opts.configDir, entry);
      const tenant = tenantByDir.get(dir);
      if (tenant !== undefined) {
        const disabled = await loadDisabledFn(tenant.configPath);
        listings.push(
          await listingForLive({
            path: entry,
            slug: tenant.slug!,
            dir: tenant.dir,
            configPath: tenant.configPath,
            dataBase: opts.dataBase,
            configValid: true,
            envPath: tenant.envPath,
            disabled,
            ...(opts.loadPipelines !== undefined ? { loadPipelines: opts.loadPipelines } : {}),
          }),
        );
        continue;
      }
      // Holds are structural (`declared − successful`), so every non-tenant
      // declared dir has one; fall back rather than assert if that ever slips.
      const hold: WorkspaceHold = holdByDir.get(dir) ?? {
        dir,
        reason: "discovery failed",
        slug: null,
      };
      listings.push(await listingForHeld(entry, dir, hold, opts.dataBase));
    }
  } else {
    for (const tenant of discovery.tenants) {
      const disabled = await loadDisabledFn(tenant.configPath);
      listings.push(
        await listingForLive({
          path: relativeTenantPath(opts.configDir, tenant.dir),
          slug: tenant.slug!,
          dir: tenant.dir,
          configPath: tenant.configPath,
          dataBase: opts.dataBase,
          configValid: true,
          envPath: tenant.envPath,
          disabled,
          ...(opts.loadPipelines !== undefined ? { loadPipelines: opts.loadPipelines } : {}),
        }),
      );
    }
    for (const hold of discovery.holds) {
      listings.push(
        await listingForHeld(
          relativeTenantPath(opts.configDir, hold.dir),
          hold.dir,
          hold,
          opts.dataBase,
        ),
      );
    }
    listings.sort((a, b) => (a.slug ?? a.path).localeCompare(b.slug ?? b.path));
  }

  const live = listings.filter((listing) => !listing.held).length;
  const undeclared = isExplicitWorkspace(workspace)
    ? discoverUndeclaredInTreeTenants(opts.configDir, workspace.tenants)
    : [];
  return { listings, declared: listings.length, live, explicit, solo: false, undeclared };
}

/**
 * Enumerate tenants with health signals for `phoebe list` (#95).
 *
 * Detection ladder matches boot (#83): root config has a `workspace` block →
 * walk the workspace tree (same walk as #91); else empty (solo has nothing to
 * list beyond "no tenants").
 */
export async function listTenants(
  opts: TenantDiscoverySeams & { configDir: string; dataBase: string },
): Promise<ListTenantsResult> {
  const enumeration = await enumerateWorkspaceTenants({
    configDir: opts.configDir,
    ...definedSeams(opts),
  });
  if (enumeration !== null) {
    return listWorkspaceTenants({
      configDir: opts.configDir,
      dataBase: opts.dataBase,
      enumeration,
      loadDisabled: opts.loadDisabled,
      ...(opts.loadPipelines !== undefined ? { loadPipelines: opts.loadPipelines } : {}),
    });
  }
  return await listSoloTenant(opts);
}

/**
 * Solo: one tenant, and it is the deployment root itself (#427).
 *
 * The row was empty before pipelines, because a fleet of one had nothing to
 * account for. Its pipeline lines do — a solo deployment runs pipelines like any
 * other tenant, and `No tenants` was hiding them. That message now means what
 * it says: nothing is declared here at all.
 */
async function listSoloTenant(
  opts: TenantDiscoverySeams & { configDir: string; dataBase: string },
): Promise<ListTenantsResult> {
  const empty: ListTenantsResult = {
    listings: [],
    declared: 0,
    live: 0,
    explicit: false,
    solo: false,
    undeclared: [],
  };
  const configPath = join(opts.configDir, TENANT_CONFIG_FILE);
  if (!existsSync(configPath)) return empty;

  // Slug and `disabled` come from the root config the same way a child's do;
  // an unreadable root is listed with its columns dark rather than dropped,
  // since the directory plainly claims to be a deployment.
  let slug: string | null = null;
  let disabled = false;
  try {
    slug = await (opts.loadRepoSlug ?? defaultLoadRepoSlug)(configPath);
    disabled = await (opts.loadDisabled ?? defaultLoadDisabled)(configPath);
  } catch {
    slug = null;
  }
  const listing: TenantListing =
    slug === null
      ? {
          path: opts.configDir,
          slug: null,
          held: false,
          reason: null,
          configValid: false,
          envPresent: envPresent(opts.configDir),
          retainedData: false,
          pipelines: [],
          arm: readTenantArm(join(opts.configDir, TENANT_ENV_FILE)),
          disabled: false,
        }
      : await listingForLive({
          path: opts.configDir,
          slug,
          dir: opts.configDir,
          configPath,
          dataBase: opts.dataBase,
          configValid: true,
          disabled,
          ...(opts.loadPipelines !== undefined ? { loadPipelines: opts.loadPipelines } : {}),
        });
  return { listings: [listing], declared: 1, live: 1, explicit: false, solo: true, undeclared: [] };
}

/**
 * The config dir still claiming `slug` in this deployment, or `null` when no
 * live config does.
 *
 * A *held* child counts: discovery would skip it now, but its config dir is
 * still on disk and its engine child may still be running (#129), so its data is
 * not a removed tenant's to reclaim. Solo answers from the root config itself —
 * the deployment root *is* the tenant there.
 */
async function liveConfigDirForSlug(
  configDir: string,
  slug: string,
  seams: TenantDiscoverySeams,
): Promise<string | null> {
  const enumeration = await enumerateWorkspaceTenants({ configDir, ...definedSeams(seams) });
  if (enumeration !== null) {
    const tenant = enumeration.tenants.find((candidate) => candidate.slug === slug);
    if (tenant !== undefined) return tenant.dir;
    return enumeration.holds.find((hold) => hold.slug === slug)?.dir ?? null;
  }
  const rootConfigPath = join(configDir, TENANT_CONFIG_FILE);
  if (!existsSync(rootConfigPath)) return null;
  try {
    const root = await loadUserConfig(rootConfigPath);
    return root.repoSlug === slug ? configDir : null;
  } catch {
    return null;
  }
}

/**
 * Destructively wipe a *removed* tenant's retained `/data/repos/<slug>`. Refuses
 * while a live config still claims that slug (purge is for removed tenants only
 * — otherwise it would nuke a running tenant's clone), and requires an explicit
 * `confirm` (the CLI's `--yes`).
 *
 * The refusal is advisory about what to do next and stops there: unregistering a
 * child means editing the root `phoebe.config.ts`, which Phoebe never writes on
 * the operator's behalf (#127).
 */
export async function purgeTenant(
  opts: TenantDiscoverySeams & {
    configDir: string;
    dataBase: string;
    slug: string;
    confirm: boolean;
  },
): Promise<{ purged: string }> {
  const { owner, repo } = parseSlug(opts.slug);
  if (!opts.confirm) {
    throw new Error(`Refusing to purge ${opts.slug} without --yes (this is irreversible).`);
  }
  const liveDir = await liveConfigDirForSlug(opts.configDir, opts.slug, opts);
  if (liveDir !== null) {
    throw new Error(
      `Tenant ${opts.slug} still has a live config at ${liveDir}. ` +
        `Remove the child from \`workspace.tenants\` in the deployment-root ` +
        `phoebe.config.ts and/or delete its config dir, then purge — purge only ` +
        `reclaims data for removed tenants.`,
    );
  }
  const dataDir = join(opts.dataBase, owner, repo);
  if (!existsSync(dataDir)) {
    throw new Error(`No retained data at ${dataDir} for ${opts.slug}.`);
  }
  rmSync(dataDir, { recursive: true, force: true });
  return { purged: dataDir };
}
