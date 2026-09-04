// The supervisor's per-tenant env scrub — isolation model A, §1 (#61).
//
// In a workspace/multi-tenant deployment the supervisor (boot.ts) spawns one engine
// child per tenant. Left as today's `stdio: "inherit"` with no `env`, every
// child would inherit the supervisor's full `process.env` — which holds the
// deployment engine-clone credential (#60) and, once several tenants' `.env`
// files are loaded, every tenant's secrets. That is exactly the cross-tenant
// exposure model A must prevent.
//
// So the supervisor builds each child's env here, **deny-by-default from an
// explicit allowlist**: a hardcoded base (PATH/HOME/git identity), the
// deployment-global `PHOEBE_*` knobs the engine reads, plus *only* tenant T's
// freshly-parsed `.env`. The supervisor's own `process.env` is never spread in,
// so the #60 clone credential — and any future secret dropped there — is
// fail-closed invisible to children (simply never on the list). Isolation is
// structural, not disciplinary: a child can only ever hold its own tenant's
// secrets. `buildAgentEnv` (src/agent-env.ts) then narrows correctly at the
// agent hop, unchanged, because the child's env already holds only tenant T's.
//
// Solo single-tenant mode does NOT use this: one tenant is one trust domain
// (the whole container), Docker injects exactly that tenant's secrets, and the
// child inherits the supervisor env as it does today.
//
// One axis is finer than the tenant, and only one: the subtractive row scrub
// (#425). A tenant that runs several rows still has one `.env`, but a key a
// kind declared belongs to the row scheduling that kind — so a row loses every
// key its siblings declared and it did not. Undeclared keys are nobody's in
// particular and reach every row, as they always have. Solo applies the same
// subtraction to the env it inherits.

import { createHash } from "node:crypto";

import { isSet } from "./credential-arm.ts";
import { gitIdentityEnv, type GitIdentity } from "./git-identity.ts";
import { type MintedCredentials } from "./tenants.ts";
import { WORK_KIND_NAMES } from "../src/config-schema.ts";
import { workKindEnvVar } from "../src/provider-selection.ts";

/**
 * Hardcoded base allowlist: process essentials plus the deployment-global git
 * identity every tenant shares. Not secrets, and not per-tenant.
 */
export const ENGINE_CHILD_BASE_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/**
 * Deployment-global `PHOEBE_*` knobs the engine reads that are safe to share
 * across every tenant. Deliberately excludes the per-tenant config-overlay keys
 * (`PHOEBE_REPO_SLUG`, `PHOEBE_INSTALL_COMMAND`, …): each tenant loads its own
 * `phoebe.config.ts`, so a global overlay would corrupt every tenant identically.
 */
export const ENGINE_CHILD_DEPLOYMENT_KNOBS = [
  "PHOEBE_POLL_INTERVAL_MS",
  "PHOEBE_RUN_TIMEOUT_MS",
  "PHOEBE_MAX_UNIT_TIMEOUTS",
  "PHOEBE_DATA_DIR",
  "PHOEBE_BASE",
  "PHOEBE_AGENT",
  "PHOEBE_MODEL",
  "PHOEBE_EFFORT",
  // The per-work-kind variants of the trio above (#300), e.g.
  // PHOEBE_REVIEWS_MODEL — generated so the list tracks the closed kind set.
  ...WORK_KIND_NAMES.flatMap((kind) =>
    (["AGENT", "MODEL", "EFFORT"] as const).map((knob) => workKindEnvVar(kind, knob)),
  ),
] as const;

/**
 * Parse a `.env` file's contents into a plain record. Minimal by design — the
 * supervisor only needs `KEY=VALUE` for a tenant's `GH_TOKEN` + provider key:
 * blank lines and `#` comments are skipped, an optional `export ` prefix and
 * surrounding single/double quotes are stripped, and `=` inside a value is
 * preserved. No interpolation, no multiline values.
 */
export function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (key.length === 0) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * The reconcile identity of one tenant's `.env` *contents*, minus `GH_TOKEN`'s
 * value — the `.env` half of the fleet's tenant fingerprint (#205).
 *
 * Every other `.env` value is frozen into the child env at spawn by
 * {@link buildEngineChildEnv}, so editing one must keep relaunching the child —
 * the relaunch is the only delivery those values have. `GH_TOKEN`'s *value*
 * alone is excluded: nothing in the engine caches it (gh, git, and the
 * agent-env builder all read `process.env` live), and the supervisor's
 * credential lease hands the current value to the running child per request.
 * Counting it here would spend a full drain-and-respawn on a rotation the
 * lease already delivers in place.
 *
 * The token's *presence* is still counted. The lease can deliver a new value
 * but not an absence — its null answer means "keep what you have" — so
 * removing (or blanking) the token must land on the relaunch axis: the
 * respawned child's scrubbed env then genuinely lacks it, and a PAT the
 * operator deleted stops being used. A blank `GH_TOKEN=` counts as absent,
 * matching the arm resolver's and the lease handler's `isSet` reading.
 *
 * Digests the *parsed* env (sorted keys), not the bytes, so reordering lines or
 * editing comments is as invisible to reconcile as it is to the child.
 *
 * `hidden` narrows it to what one row would actually hold: pass the keys the
 * subtractive scrub removes for that row and the digest stops moving for
 * rotations that row cannot see. Empty — the tenant-wide reading — is every
 * key, which is what the tenant fingerprint wants.
 */
export function envReconcileDigest(contents: string, hidden: readonly string[] = []): string {
  const parsed = parseDotenv(contents);
  const hasToken = isSet(parsed["GH_TOKEN"]);
  delete parsed["GH_TOKEN"];
  // The per-row reading (#425): a row's child env never holds a key a sibling
  // declared and it did not, so a rotation of that key is nothing this row
  // could act on — counting it would drain and respawn a child to hand it an
  // env byte-for-byte identical to the one it already has.
  for (const key of hidden) delete parsed[key];
  const hash = createHash("sha256");
  hash.update(hasToken ? "token" : "no-token");
  hash.update("\0");
  for (const key of Object.keys(parsed).sort()) {
    hash.update(key);
    hash.update("\0");
    hash.update(parsed[key]!);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Runtime allowlist for keys copied from `mintedEnv` into the child env.
 * Mirrors the fields of {@link MintedCredentials} — the type is the
 * compile-time barrier; this set is the runtime one (defense in depth).
 */
export const MINTED_ENV_ALLOWED_KEYS: ReadonlySet<keyof MintedCredentials> = new Set([
  "GH_TOKEN",
  "PHOEBE_GH_LOGIN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]);

/**
 * Build a scrubbed, tenant-only env for one engine child. Deny-by-default: start
 * empty, copy the allowlisted base + deployment knobs from `base` (the
 * supervisor's `process.env`), then overlay the supervisor-minted credentials
 * (GH_TOKEN from an App installation token, PHOEBE_GH_LOGIN, fallback git
 * identity), then overlay tenant T's parsed `.env`. Because `base`'s `GH_TOKEN`
 * is not on either allowlist, the only `GH_TOKEN` a child can hold is the one
 * its tenant explicitly carries or the supervisor minted for it. App credential
 * keys (GH_APP_*) are structurally absent — simply never on any list.
 *
 * Layer order (later wins):
 *   1. allowlisted base + deployment knobs  (PATH, HOME, PHOEBE_*, …)
 *   2. mintedEnv  (GH_TOKEN, PHOEBE_GH_LOGIN, git identity from App minting)
 *   3. configIdentity  (the tenant config's `gitIdentity`, #199)
 *   4. tenantEnv  (tenant's parsed .env — always wins every collision)
 *   5. scrubKeys  (subtracted: keys a sibling row declared and this one did not)
 */
export function buildEngineChildEnv(opts: {
  base: Record<string, string | undefined>;
  tenantEnv: Record<string, string>;
  /**
   * Supervisor-minted credentials (GH_TOKEN, PHOEBE_GH_LOGIN, fallback git
   * identity) for tenants without their own GH_TOKEN. Applied before
   * `tenantEnv` so an explicit `GH_TOKEN` in the tenant's file always wins.
   */
  mintedEnv?: MintedCredentials | Record<string, string>;
  /**
   * The tenant config's declared `gitIdentity` (#199), applied after
   * `mintedEnv` and before `tenantEnv`: a repo's own declaration outranks
   * anything the deployment says fleet-wide (the base allowlist, the App-mode
   * bot fallback) and is outranked by the tenant's own `.env`. Absent ⇒ the
   * child env is byte-for-byte what it was before the field existed.
   */
  configIdentity?: GitIdentity | null;
  /**
   * The subtractive row scrub (#425): keys a *sibling* row of this tenant
   * declared and this row did not. Removed last, after every overlay, so it
   * catches the key wherever it entered — the tenant's `.env`, most of the
   * time. Empty (the default) leaves the child env exactly as it was before
   * rows could declare anything.
   */
  scrubKeys?: readonly string[];
}): Record<string, string> {
  const { base, tenantEnv, mintedEnv, configIdentity, scrubKeys = [] } = opts;
  const env: Record<string, string> = {};
  for (const key of [...ENGINE_CHILD_BASE_KEYS, ...ENGINE_CHILD_DEPLOYMENT_KNOBS]) {
    const value = base[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  // Minted credentials overlay the base before the tenant's own values so an
  // explicit GH_TOKEN (or any other key) in the tenant's .env always wins.
  // The runtime allowlist ensures keys outside MintedCredentials never reach
  // the child even if the caller bypasses the type system.
  if (mintedEnv) {
    for (const [key, value] of Object.entries(mintedEnv)) {
      if ((MINTED_ENV_ALLOWED_KEYS as ReadonlySet<string>).has(key) && value !== "")
        env[key] = value;
    }
  }
  // The repo's own declaration, over every deployment-wide default and under
  // the tenant's `.env` below.
  for (const [key, value] of Object.entries(gitIdentityEnv(configIdentity))) {
    if (value !== "") env[key] = value;
  }
  // Tenant secrets last: they are the tenant's own, and win over any collision.
  for (const [key, value] of Object.entries(tenantEnv)) {
    if (value !== "") env[key] = value;
  }
  // Then the row scrub, which is a subtraction and therefore has to come after
  // everything that could add. Reserved keys can never be declared, so nothing
  // here can take away the token, the bot login or the git identity.
  for (const key of scrubKeys) delete env[key];
  return env;
}
