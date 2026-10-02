// The **tenant secret store** — the per-tenant file of console-set secret
// values on the data volume (#504; map #497).
//
// It exists because the root `.env` is deliberately unreachable from inside the
// container: `compose.yml` masks it with a `/dev/null` bind mount, and it is
// Compose's *create-time* input anyway, so even unmasked a rotation would need a
// container recreate the bootstrapper cannot perform on itself. In solo there is
// no tenant `.env` in there at all — the tenant's env *is* the ambient process
// env. So a secret an operator sets without editing a file lands here instead,
// at `<data>/<owner>/<repo>/state/secrets.json`, mode `0600`, and
// `paths.stateDir` resolves to that shape for every fleet arm.
//
// Four rules hold the store to what #504 decided:
//
//   - **Tenant scope only.** The store never holds a deployment-scope secret:
//     not the App key (`GH_APP_*`), whose blast radius spans the App's whole
//     installation set, and not the engine-clone token, which lives in the
//     bootstrapper's own env and is never read from here. That is what preserves
//     the `/dev/null` mask's guarantee exactly. A tenant's own `GH_TOKEN` *is*
//     settable — in solo that means the agent's token rotates while the clone's
//     does not until a recreate, which #504 accepted and named.
//   - **The settable set is derived, never hardcoded**
//     ({@link settableSecretKeys}): every scheduled kind's `requiredEnv`, plus
//     `GH_TOKEN`, plus the vars `providerEnv` names. A hardcoded list goes stale
//     the moment somebody writes a custom kind.
//   - **It wins over the `.env`, but never silently.** The store is the top tier
//     above the four in `docs/configuration.md`; a key present in both is
//     flagged `shadowed` in the effective config's `env` section and raises a
//     doctor warn naming it.
//   - **No tombstone.** {@link clearSecret} removes the entry and the `.env` or
//     ambient value governs again. Revocation is *rotation* — a new value is
//     what stops a leaked token being used — and a lease cannot deliver an
//     absence anyway.
//
// At rest the file is plaintext at `0600`, which is exactly where the tenant
// `.env` already sits in the trust model: readable by sibling tenants sharing
// uid 10001, so it **joins** `docs/trust.md`'s accepted residual rather than
// widening it.

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { derivePaths } from "./paths.ts";
import { ENGINE_CREDENTIAL_KEYS } from "./shell-env.ts";

/** The store, on the tenant's own state dir. */
export const SECRET_STORE_FILE = "secrets.json";

/** The edit ledger, beside it. Keys and who set them; never a value. */
export const SECRET_EDITS_FILE = "secret-edits.json";

/** Owner-only, on both files. The store holds plaintext; the ledger names keys. */
export const SECRET_FILE_MODE = 0o600;

/**
 * The `schema` integer both files carry. Bump when a field's meaning changes in
 * a way an older reader would misread; adding an optional field does not move it.
 */
export const SECRET_STORE_SCHEMA = 1;

/** What one edit records: no value, no file path (#504). */
export type SecretEdit = {
  /** Idempotency key — the console's receipt that its set landed (#503's rule). */
  id: string;
  key: string;
  /** ISO 8601, when the edit was written. */
  at: string;
  /** Who asked. The relay stamps a person's email; a local run says `local`. */
  by: string;
};

/** What a local `phoebe secret set` stamps as the editor. */
export const LOCAL_EDITOR = "local";

/** The store as it is overlaid: plain `KEY=value`, like the `.env` it outranks. */
export type SecretValues = Record<string, string>;

export function secretStorePath(stateDir: string): string {
  return join(stateDir, SECRET_STORE_FILE);
}

export function secretEditsPath(stateDir: string): string {
  return join(stateDir, SECRET_EDITS_FILE);
}

/**
 * Where one tenant's store lives, from its slug and the deployment data base —
 * the same derivation every other per-tenant path goes through, so the store
 * lands beside `status.json` on every fleet arm with no new mount. Null slug in,
 * null out: a solo config that declares no usable `repoSlug` has no tenant
 * namespace to put a store in, and inventing one would write it somewhere
 * nothing else would ever look.
 */
export function tenantStateDir(slug: string | null, dataBase: string): string | null {
  if (slug === null || slug.trim().length === 0) return null;
  return derivePaths(slug.trim(), dataBase).stateDir;
}

// --- reading ----------------------------------------------------------------

/** A value the store actually supplies. Blank reads as unset, as everywhere. */
function isSet(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseStore(contents: string, path: string): SecretValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a secret store (expected an object).`);
  }
  const values = (parsed as { values?: unknown }).values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error(`${path} is not a secret store (expected a \`values\` object).`);
  }
  const out: SecretValues = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (isSet(value)) out[key] = value;
  }
  return out;
}

/**
 * The store, strictly. A file that exists but will not parse **throws** — this
 * is the read the write path takes, and overwriting a store it could not
 * understand would silently drop every secret in it.
 */
export function readSecretStore(stateDir: string): SecretValues {
  const path = secretStorePath(stateDir);
  if (!existsSync(path)) return {};
  return parseStore(readFileSync(path, "utf8"), path);
}

/**
 * The store as a delivery path reads it: a missing, unreadable or malformed file
 * is no store at all. Fail-closed on purpose — the alternative is a supervisor
 * that refuses to spawn a child over a corrupt overlay file, when falling back
 * to the `.env` is both correct and what the operator would ask for. Doctor is
 * the one that says the file is broken.
 */
export function tenantSecrets(stateDir: string | null): SecretValues {
  if (stateDir === null) return {};
  try {
    return readSecretStore(stateDir);
  } catch {
    return {};
  }
}

/** The ledger, oldest first. Tolerant like {@link tenantSecrets}: it is a record, not a gate. */
export function readSecretEdits(stateDir: string): SecretEdit[] {
  const path = secretEditsPath(stateDir);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const edits = (parsed as { edits?: unknown } | null)?.edits;
  if (!Array.isArray(edits)) return [];
  return edits.filter(
    (edit): edit is SecretEdit =>
      typeof edit === "object" &&
      edit !== null &&
      isSet((edit as SecretEdit).id) &&
      isSet((edit as SecretEdit).key) &&
      isSet((edit as SecretEdit).at) &&
      isSet((edit as SecretEdit).by),
  );
}

/** The last edit recorded for `key`, or undefined — the store's `setAt` / `by`. */
export function lastEditFor(edits: readonly SecretEdit[], key: string): SecretEdit | undefined {
  return edits.filter((edit) => edit.key === key).at(-1);
}

// --- writing ----------------------------------------------------------------

/**
 * Replace a file atomically at `0600`. The temp name carries the pid so two
 * processes writing the same volume cannot clobber each other's partial file —
 * the guard `writeDeploymentReport` and `writeStatus` already use — and the mode
 * is set on the temp file *before* it holds anything, so the plaintext is never
 * world-readable for even the width of a syscall.
 */
function writePrivate(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${basename(path)}.tmp`);
  writeFileSync(tmp, contents, { mode: SECRET_FILE_MODE });
  chmodSync(tmp, SECRET_FILE_MODE);
  renameSync(tmp, path);
}

/** Write the store. Callers pass the whole map — there is no partial write. */
export function writeSecretStore(stateDir: string, values: SecretValues): void {
  const sorted: SecretValues = {};
  for (const key of Object.keys(values).sort()) {
    if (isSet(values[key])) sorted[key] = values[key];
  }
  writePrivate(
    secretStorePath(stateDir),
    `${JSON.stringify({ schema: SECRET_STORE_SCHEMA, values: sorted }, null, 2)}\n`,
  );
}

/**
 * Append one edit to the ledger. Separate from `state/config-edits.json`
 * because it has no commit axis: a config edit rolls to history when the
 * operator commits it, and a secret is never committed, so there is nothing to
 * roll against.
 */
export function appendSecretEdit(stateDir: string, edit: SecretEdit): void {
  const edits = [...readSecretEdits(stateDir), edit];
  writePrivate(
    secretEditsPath(stateDir),
    `${JSON.stringify({ schema: SECRET_STORE_SCHEMA, edits }, null, 2)}\n`,
  );
}

/** A fresh edit id. Idempotency carries over from #503; concurrency does not. */
export function newEditId(): string {
  return randomUUID();
}

/**
 * Set one key and record the edit. Returns the edit so a caller can hand back
 * the receipt — which ends at `written`, as #503 decided: the *pickup* is what
 * the deployment report shows.
 */
export function setSecret(opts: {
  stateDir: string;
  key: string;
  value: string;
  by?: string;
  at?: string;
  id?: string;
}): SecretEdit {
  const store = readSecretStore(opts.stateDir);
  writeSecretStore(opts.stateDir, { ...store, [opts.key]: opts.value });
  const edit: SecretEdit = {
    id: opts.id ?? newEditId(),
    key: opts.key,
    at: opts.at ?? new Date().toISOString(),
    by: opts.by ?? LOCAL_EDITOR,
  };
  appendSecretEdit(opts.stateDir, edit);
  return edit;
}

/**
 * Clear one key. No tombstone: the entry goes and whatever the `.env` or the
 * ambient env says governs again. Returns false when the store did not hold the
 * key, which is a no-op worth saying out loud rather than a failure.
 */
export function clearSecret(opts: {
  stateDir: string;
  key: string;
  by?: string;
  at?: string;
  id?: string;
}): { cleared: boolean; edit?: SecretEdit } {
  const store = readSecretStore(opts.stateDir);
  if (!(opts.key in store)) return { cleared: false };
  delete store[opts.key];
  writeSecretStore(opts.stateDir, store);
  const edit: SecretEdit = {
    id: opts.id ?? newEditId(),
    key: opts.key,
    at: opts.at ?? new Date().toISOString(),
    by: opts.by ?? LOCAL_EDITOR,
  };
  appendSecretEdit(opts.stateDir, edit);
  return { cleared: true, edit };
}

// --- what may be set --------------------------------------------------------

/**
 * The App credentials, which the store never holds whatever a kind declares.
 * `GH_TOKEN` is the one member of {@link ENGINE_CREDENTIAL_KEYS} that stays
 * settable: at tenant scope it is the agent's token, and the deployment's
 * engine-clone token is a different variable in a different process's env.
 */
export const DEPLOYMENT_SCOPE_KEYS: readonly string[] = ENGINE_CREDENTIAL_KEYS.filter(
  (key) => key !== "GH_TOKEN",
);

/** Attribution is the config's job (`gitIdentity`), not a secret. */
export const IDENTITY_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/**
 * Why `key` may not be set, or null when it may. Three families, all from #504:
 * the App credentials (deployment scope), the `PHOEBE_*` settings (knobs, not
 * secrets — `phoebe config set` is their channel), and the git identity vars.
 * Everything else is judged by whether the tenant actually needs it, which is
 * {@link settableSecretKeys}'s question, not this one's.
 */
export function unsettableReason(key: string): string | null {
  if (DEPLOYMENT_SCOPE_KEYS.includes(key)) {
    return (
      `${key} is a deployment-scope credential: it is the App's private key material, whose ` +
      `blast radius spans every repo the App is installed on. Edit the deployment's env-file ` +
      `and recreate the container.`
    );
  }
  if ((IDENTITY_KEYS as readonly string[]).includes(key)) {
    return `${key} is commit attribution, not a secret — set \`gitIdentity\` in the config.`;
  }
  if (key.startsWith("PHOEBE_")) {
    return `${key} is a setting, not a secret — \`phoebe config\` is where those live.`;
  }
  return null;
}

/**
 * Every key this tenant may set, derived rather than listed: the union of what
 * its scheduled kinds declare (`requiredEnv` — exactly what doctor's
 * `declared-env` check already enumerates), `GH_TOKEN`, and the vars
 * `providerEnv` names, minus the three excluded families. So the settable set is
 * exactly the set doctor already knows how to check, and a custom kind's key is
 * settable the day the kind is written.
 */
export function settableSecretKeys(opts: {
  declaredEnv: readonly string[];
  providerEnv: Readonly<Record<string, string>>;
}): string[] {
  const names = new Set<string>([
    "GH_TOKEN",
    ...opts.declaredEnv,
    ...Object.values(opts.providerEnv),
  ]);
  return [...names].filter((key) => key.trim().length > 0 && unsettableReason(key) === null).sort();
}

/**
 * The refusal an off-catalogue key gets, naming the fallback. An operator who
 * needs a key no kind declares is not stuck — they are pointed at the file the
 * store sits above.
 */
export function offCatalogueRefusal(key: string, settable: readonly string[]): string {
  const reason = unsettableReason(key);
  if (reason !== null) return reason;
  return (
    `${key} is not a key this tenant reads. The store holds only what the tenant needs: ` +
    `${settable.join(", ") || "(nothing declared)"}. Declare it in a work kind's ` +
    `\`requiredEnv\`, or set it in the tenant's .env.`
  );
}
