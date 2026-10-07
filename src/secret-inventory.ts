// The **secrets inventory** — section 6 of the deployment report, built here so
// `phoebe secret ls` and the console's secrets tab answer from one derivation
// (#504, #550; map #497 and the rule in #501).
//
// The deployment is the only side that can build it. Which keys a tenant may
// set comes from loading that tenant's work kinds and reading their
// `requiredEnv` — module loading, inside the container, against the checkout
// the engine actually runs — so a relay or a browser that tried to compute it
// would be guessing. What crosses the wire is the answer.
//
// **Presence and provenance, never a value.** Nothing in this module reads a
// value except to ask whether it is a non-empty string. The store's plaintext is
// on the volume and stays there.
//
// **Every key that matters gets a line, settable or not.** Three sources make
// the list: what the tenant's kinds declare, whatever the store already holds —
// including a stale entry from a retired kind, which is still the value a child
// would hold — and the deployment-scope credentials, which no relay may ever
// set and which are listed with the reason rather than hidden. A page that
// omitted the App key would leave an operator hunting for the one key they can
// see is in use.
//
// **A tenant whose config will not load is one line, not an omission.** It
// reports `error` and no keys, the way the effective config does for the same
// tenant: from out here a held tenant, an unreadable file and a missing
// `repoSlug` are the same fact — this tenant's secrets are unknown.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import { readConfigDir } from "../bootstrap/config-dir.ts";
import { TENANT_ENV_FILE } from "../bootstrap/tenants.ts";
import { resolveConfig } from "./config-schema.ts";
import type { SecretListing, SecretsSection, TenantSecrets } from "./contracts/secrets.ts";
import { applyEnvOverlay, loadUserConfig } from "./load-config.ts";
import { enumerateDeclaredEnv } from "./pipeline-enumerate.ts";
import { listSecrets } from "./secret-command.ts";
import {
  DEPLOYMENT_SCOPE_KEYS,
  offCatalogueRefusal,
  readSecretEdits,
  readSecretStore,
  settableSecretKeys,
  tenantStateDir,
  unsettableReason,
} from "./secret-store.ts";

/** One tenant, as the caller already knows it — no discovery happens here. */
export type InventoryTenant = {
  /** Absolute path to the tenant's `phoebe.config.ts`. */
  configPath: string;
  /** The tenant directory a console displays. */
  path: string;
  /** `owner/repo` when discovery recovered it; null when it did not. */
  slug: string | null;
  /** Why this tenant is held, when it is. Held tenants report the hold and no keys. */
  heldReason?: string | null;
};

export type InventoryDeps = {
  dataBase: string;
  processEnv: NodeJS.ProcessEnv;
};

/**
 * The whole section, one entry per tenant, in the order they were handed over.
 * Never throws: one tenant that will not load is one `error` line, and the rest
 * of the fleet is still worth reporting.
 */
export async function secretInventory(
  tenants: readonly InventoryTenant[],
  deps: InventoryDeps,
): Promise<Omit<SecretsSection, "updatedAt">> {
  const rows: TenantSecrets[] = [];
  for (const tenant of tenants) rows.push(await tenantSecrets(tenant, deps));
  return { tenants: rows };
}

/**
 * One tenant's keys. The `.env` path is derived the way the supervisor derives
 * it — beside the config unless `configDir` moved it — so what this reports as
 * `tenantEnv` is the file the child will actually be handed.
 */
export async function tenantSecrets(
  tenant: InventoryTenant,
  deps: InventoryDeps,
): Promise<TenantSecrets> {
  const base = { tenant: tenant.slug ?? tenant.path, path: tenant.path };
  if (tenant.heldReason !== undefined && tenant.heldReason !== null) {
    return { ...base, error: tenant.heldReason, keys: [] };
  }
  let user: Record<string, unknown>;
  try {
    user = (await loadUserConfig(tenant.configPath)) as unknown as Record<string, unknown>;
  } catch (error) {
    return { ...base, error: messageOf(error), keys: [] };
  }
  const slug = tenant.slug ?? readSlug(user);
  if (slug === null) {
    return {
      ...base,
      error:
        `${tenant.configPath} declares no \`repoSlug\`, so this tenant has no state ` +
        `directory to keep a secret store in.`,
      keys: [],
    };
  }
  const stateDir = tenantStateDir(slug, deps.dataBase);
  if (stateDir === null) {
    return {
      ...base,
      tenant: slug,
      error: `Could not derive a state directory for ${slug}.`,
      keys: [],
    };
  }

  const settable = await settableFor(user, tenant.configPath, deps.processEnv, deps.dataBase);
  let keys: SecretListing[];
  try {
    keys = listSecrets({
      settable,
      store: readSecretStore(stateDir),
      tenantEnv: readEnvFile(envPathFor(tenant.configPath, user)),
      processEnv: deps.processEnv,
      edits: readSecretEdits(stateDir),
    });
  } catch (error) {
    // A store that will not parse is worth saying out loud rather than
    // reporting as a tenant with no secrets: doctor says the same thing, and an
    // operator who sees "no keys" would go looking in the wrong place.
    return { ...base, tenant: slug, error: messageOf(error), keys: [] };
  }

  const listed = new Set(keys.map((listing) => listing.key));
  return {
    ...base,
    tenant: slug,
    error: null,
    keys: [
      ...keys.map((listing) => withVerdict(listing, settable)),
      ...DEPLOYMENT_SCOPE_KEYS.filter((key) => !listed.has(key)).map((key) =>
        deploymentScopeListing(key, deps.processEnv),
      ),
    ].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

/**
 * Why this key may not be set, attached to the line that shows it. Every
 * refusal a console can hit is decided on the deployment — the same function
 * `phoebe secret set` refuses with — so the button is disabled for exactly the
 * keys the request would have turned away, with exactly that sentence.
 */
function withVerdict(listing: SecretListing, settable: readonly string[]): SecretListing {
  if (settable.includes(listing.key)) return listing;
  return { ...listing, unsettable: offCatalogueRefusal(listing.key, settable) };
}

/**
 * One deployment-scope credential's line. Presence from the ambient env, which
 * is where it lives: the App key reaches the bootstrapper's own process, never a
 * tenant's store.
 */
function deploymentScopeListing(key: string, processEnv: NodeJS.ProcessEnv): SecretListing {
  const present = isSet(processEnv[key]);
  return {
    key,
    present,
    source: present ? "process" : "missing",
    unsettable: unsettableReason(key) ?? `${key} is not settable from a console.`,
  };
}

/**
 * What this tenant may set. The scan loads the tenant's kind modules, so a kind
 * that will not load takes its declared keys with it — the settable set is then
 * `GH_TOKEN` plus the provider names, and the console's refusal names the
 * fallback rather than pretending the key does not exist.
 */
async function settableFor(
  user: Record<string, unknown>,
  configPath: string,
  env: NodeJS.ProcessEnv,
  dataBase: string,
): Promise<string[]> {
  const config = resolveConfig(applyEnvOverlay(user as never, env), { dataBase });
  let declaredEnv: string[] = [];
  try {
    const declarations = await enumerateDeclaredEnv(config, dirname(configPath));
    declaredEnv = declarations.flatMap((declaration) => declaration.keys);
  } catch {
    declaredEnv = [];
  }
  return settableSecretKeys({ declaredEnv, providerEnv: config.providerEnv });
}

function readSlug(user: Record<string, unknown>): string | null {
  const declared = user["repoSlug"];
  return typeof declared === "string" && declared.trim().length > 0 ? declared.trim() : null;
}

/** Where a tenant's `.env` lives — beside its config unless `configDir` moved it. */
function envPathFor(configPath: string, user: Record<string, unknown>): string {
  try {
    return join(dirname(configPath), readConfigDir(user), TENANT_ENV_FILE);
  } catch {
    return join(dirname(configPath), TENANT_ENV_FILE);
  }
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
