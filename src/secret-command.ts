// `phoebe secret` — set, clear and list a tenant's secrets (#504; map #497).
//
// The local half of write-only secrets. One verb serves both callers, as #503
// decided: an operator types it in the container, and the console arm (#506)
// will call the same functions with the sender's email as `by` once a relay
// exists to carry an envelope.
//
// **The value arrives on stdin and nowhere else.** A value on the command line
// lands in shell history and in `/proc/<pid>/cmdline`, which a sibling tenant
// sharing uid 10001 can read — the one place this design would leak where the
// `.env` does not. So `set` takes a key and reads the value from the pipe, and
// nothing in this file ever puts a value in a log line, an error message or the
// ledger.
//
// **What may be set is derived, never listed** (`settableSecretKeys`): the union
// of what the tenant's scheduled kinds declare, `GH_TOKEN`, and the vars
// `providerEnv` names. An off-catalogue key is refused with the fallback —
// declare it in a work kind, or edit the `.env` — and the App credentials are
// refused outright, because their blast radius spans the App's whole
// installation set and the store is tenant scope only.
//
// **A successful set triggers a doctor run** (#507 §6). Setting a key is the
// moment an operator wants "did it work" answered, and doctor is the thing that
// answers it: the `declared-env` check reads the same env the child will hold,
// and the `token` check says which credential the tenant is running on.
// `--no-doctor` skips it for a scripted rotation of many keys.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import { readConfigDir } from "../bootstrap/config-dir.ts";
import { TENANT_ENV_FILE } from "../bootstrap/tenants.ts";
import { matchConfigFlag } from "./cli-flags.ts";
import { resolveConfig } from "./config-schema.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { resolveDataBase } from "./paths.ts";
import { enumerateDeclaredEnv } from "./pipeline-enumerate.ts";
import {
  clearSecret,
  lastEditFor,
  offCatalogueRefusal,
  readSecretEdits,
  readSecretStore,
  secretStorePath,
  setSecret,
  settableSecretKeys,
  tenantStateDir,
  type SecretValues,
} from "./secret-store.ts";
import { enumerateWorkspaceTenants } from "./tenant-commands.ts";

/** The three things `phoebe secret` does. */
export type SecretAction = "set" | "clear" | "ls";

export type ParsedSecretArgs = {
  help: boolean;
  json: boolean;
  /** Absent when the argv was only `--help`. */
  action?: SecretAction;
  key?: string;
  configPath?: string;
  /** Which tenant of a workspace root, as `owner/repo`. */
  tenant?: string;
  /** Skip the doctor run a successful set triggers. */
  noDoctor: boolean;
};

const SECRET_HELP_TEXT = `phoebe secret — the tenant secret store (write-only)

Usage:
  phoebe secret set <KEY> [--tenant <owner/repo>]     value on stdin, never in argv
  phoebe secret clear <KEY> [--tenant <owner/repo>]   fall back to the .env again
  phoebe secret ls [--tenant <owner/repo>] [--json]   presence and source, no values

The store is <data>/<owner>/<repo>/state/secrets.json, mode 0600, one per
tenant. It is the tier above the tenant's .env: a key set in both is reported
\`shadowed\` by \`phoebe config\` and raises a doctor warn. Clearing removes the
entry, so whatever the .env or the ambient env says governs again — there is no
tombstone, because revoking a secret means rotating it, not deleting it.

The value is read from stdin, to the end of the stream, with one trailing
newline stripped:

  printf %s "$ANTHROPIC_API_KEY" | phoebe secret set ANTHROPIC_API_KEY

Settable keys are whatever this tenant reads: every env key its scheduled work
kinds declare, GH_TOKEN, and the provider key names in \`providerEnv\`. The
GitHub App credentials are not settable at any scope — their blast radius spans
every repo the App is installed on, so they stay in the deployment's env-file.

A successful set runs \`phoebe doctor\`; \`--no-doctor\` skips it. Run against a
workspace root, \`--tenant\` picks the child; anywhere else the config found is
the tenant.
`;

export function parseSecretArgs(argv: readonly string[]): ParsedSecretArgs {
  let help = false;
  let json = false;
  let noDoctor = false;
  let action: SecretAction | undefined;
  let key: string | undefined;
  let configPath: string | undefined;
  let tenant: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--no-doctor") {
      noDoctor = true;
      continue;
    }
    if (arg === "--tenant" || arg.startsWith("--tenant=")) {
      const inline = arg.startsWith("--tenant=") ? arg.slice("--tenant=".length) : argv[++i];
      if (inline === undefined || inline.length === 0 || inline.startsWith("-")) {
        throw new Error("`--tenant` requires an `owner/repo` argument.");
      }
      tenant = inline;
      continue;
    }
    const config = matchConfigFlag(argv, i);
    if (config !== undefined) {
      configPath = config.value;
      i += config.consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown flag \`${arg}\` for \`phoebe secret\`. See \`phoebe secret --help\`.`,
      );
    }
    if (action === undefined) {
      if (arg !== "set" && arg !== "clear" && arg !== "ls") {
        throw new Error(`Unknown \`phoebe secret\` command \`${arg}\`. Expected set, clear or ls.`);
      }
      action = arg;
      continue;
    }
    if (key === undefined) {
      key = arg;
      continue;
    }
    throw new Error(
      `\`phoebe secret ${action}\` takes one key. A value is never an argument — pipe it in.`,
    );
  }
  if (!help && action === undefined) {
    throw new Error("`phoebe secret` needs a command: set, clear or ls.");
  }
  if (!help && action !== "ls" && key === undefined) {
    throw new Error(`\`phoebe secret ${action}\` needs a key, e.g. \`ANTHROPIC_API_KEY\`.`);
  }
  return {
    help,
    json,
    noDoctor,
    ...(action !== undefined ? { action } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
  };
}

// --- which tenant -----------------------------------------------------------

/** The one tenant a `phoebe secret` run acts on, with everywhere its env comes from. */
export type SecretTarget = {
  slug: string;
  configPath: string;
  envPath: string;
  stateDir: string;
  /** Every key this tenant may set, derived from its own config. */
  settable: string[];
};

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

/**
 * What this tenant may set. The scan loads the tenant's kind modules, so a kind
 * that will not load takes its declared keys with it — the settable set is then
 * `GH_TOKEN` plus the provider names, and the refusal an operator gets names the
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

/**
 * Resolve the tenant the run acts on. A workspace root has no secrets of its
 * own — the store is tenant scope only — so it demands `--tenant`; anything else
 * is one tenant, itself, and `--tenant` there is only allowed to agree with it.
 */
export async function resolveSecretTarget(opts: {
  configPath: string;
  dataBase: string;
  processEnv: NodeJS.ProcessEnv;
  tenant?: string;
}): Promise<SecretTarget> {
  const rootDir = dirname(opts.configPath);
  const enumeration = await enumerateWorkspaceTenants({ configDir: rootDir });
  let configPath = opts.configPath;
  if (enumeration !== null) {
    const slugs = enumeration.tenants.map((tenant) => tenant.slug).filter((s) => s !== null);
    if (opts.tenant === undefined) {
      throw new Error(
        `This is a workspace root, which holds no secrets of its own. Name the tenant: ` +
          `\`--tenant <owner/repo>\` (${slugs.join(", ") || "no tenants discovered"}).`,
      );
    }
    const match = enumeration.tenants.find((tenant) => tenant.slug === opts.tenant);
    if (match === undefined) {
      throw new Error(
        `No tenant \`${opts.tenant}\` in this workspace (${slugs.join(", ") || "none discovered"}).`,
      );
    }
    configPath = match.configPath;
  }

  const user = (await loadUserConfig(configPath)) as unknown as Record<string, unknown>;
  const slug = readSlug(user);
  if (slug === null) {
    throw new Error(
      `${configPath} declares no \`repoSlug\`, so this tenant has no state directory to ` +
        `keep a secret store in.`,
    );
  }
  if (enumeration === null && opts.tenant !== undefined && opts.tenant !== slug) {
    throw new Error(`\`--tenant ${opts.tenant}\` does not match this deployment's ${slug}.`);
  }
  const stateDir = tenantStateDir(slug, opts.dataBase);
  if (stateDir === null) throw new Error(`Could not derive a state directory for ${slug}.`);
  return {
    slug,
    configPath,
    envPath: envPathFor(configPath, user),
    stateDir,
    settable: await settableFor(user, configPath, opts.processEnv, opts.dataBase),
  };
}

// --- the value on stdin -----------------------------------------------------

/**
 * The value, read to the end of stdin with one trailing newline stripped — so
 * `printf %s` and `echo` both land the same value, and a secret that genuinely
 * ends in a newline is still reachable by sending two.
 *
 * A terminal on stdin is refused rather than waited on: a verb that silently
 * blocks reading a value the operator was never told to type looks like a hang.
 */
export async function readSecretValue(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY === true) {
    throw new Error(
      "A secret value is read from stdin, never from the command line. Pipe it in: " +
        '`printf %s "$KEY" | phoebe secret set <KEY>`.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

// --- listing ----------------------------------------------------------------

/** Where the value a child would hold came from. `missing` is nowhere at all. */
export type SecretSource = "store" | "tenantEnv" | "process" | "missing";

/** One key as `phoebe secret ls` reports it: presence and provenance, never a value. */
export type SecretListing = {
  key: string;
  present: boolean;
  source: SecretSource;
  /** The store set this key and a lower tier also has it (#504). */
  shadowed?: boolean;
  /** When the store entry was written, from the ledger. */
  setAt?: string;
  /** Who wrote it, from the ledger. */
  by?: string;
};

function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Every key worth a line: what the tenant may set, plus anything the store
 * already holds — a stale entry from a retired work kind is still the value a
 * child would hold, and a listing that hid it would be the one place this
 * design surprises somebody.
 */
export function listSecrets(opts: {
  settable: readonly string[];
  store: SecretValues;
  tenantEnv: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
  edits: readonly { id: string; key: string; at: string; by: string }[];
}): SecretListing[] {
  const keys = [...new Set([...opts.settable, ...Object.keys(opts.store)])].sort();
  return keys.map((key) => {
    const lower = isSet(opts.tenantEnv[key]) || isSet(opts.processEnv[key]);
    if (isSet(opts.store[key])) {
      const edit = lastEditFor(opts.edits, key);
      return {
        key,
        present: true,
        source: "store" as const,
        ...(lower ? { shadowed: true } : {}),
        ...(edit !== undefined ? { setAt: edit.at, by: edit.by } : {}),
      };
    }
    if (isSet(opts.tenantEnv[key])) return { key, present: true, source: "tenantEnv" as const };
    if (isSet(opts.processEnv[key])) return { key, present: true, source: "process" as const };
    return { key, present: false, source: "missing" as const };
  });
}

/** The listing as a terminal shows it. */
export function formatSecretListing(slug: string, listings: readonly SecretListing[]): string {
  const lines = [`${slug}`];
  if (listings.length === 0) {
    lines.push("  (this tenant declares no settable keys)");
    return `${lines.join("\n")}\n`;
  }
  const width = Math.max(...listings.map((listing) => listing.key.length));
  for (const listing of listings) {
    const parts: string[] = [listing.present ? listing.source : "missing"];
    if (listing.shadowed === true) parts.push("shadows the .env");
    if (listing.setAt !== undefined) parts.push(`set ${listing.setAt} by ${listing.by}`);
    lines.push(`  ${listing.key.padEnd(width)}  ${parts.join("  ")}`);
  }
  return `${lines.join("\n")}\n`;
}

// --- the verb ---------------------------------------------------------------

/** Where output goes, so the tests never write to the real stdout. */
export type SecretIo = {
  out: (text: string) => void;
  err: (text: string) => void;
};

const defaultIo: SecretIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/**
 * `phoebe secret` entry. Returns the doctor verdict when a set ran one, so the
 * CLI can turn a failing report into a non-zero exit — the set itself succeeded,
 * and saying so while the exit code says "go look" is the honest pair.
 */
export async function runSecretCli(
  argv: readonly string[],
  deps: {
    io?: SecretIo;
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    stdin?: NodeJS.ReadStream;
    /** Injected so a test never spawns doctor. */
    runDoctorFor?: (
      configDir: string,
      env: NodeJS.ProcessEnv,
    ) => Promise<{ ok: boolean; text: string }>;
  } = {},
): Promise<{ doctorOk: boolean } | void> {
  const parsed = parseSecretArgs(argv);
  const io = deps.io ?? defaultIo;
  if (parsed.help || parsed.action === undefined) {
    io.out(SECRET_HELP_TEXT);
    return;
  }
  const processEnv = deps.processEnv ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const configPath = resolveConfigPath(parsed.configPath, cwd);
  const dataBase = resolveDataBase(processEnv);
  const target = await resolveSecretTarget({
    configPath,
    dataBase,
    processEnv,
    ...(parsed.tenant !== undefined ? { tenant: parsed.tenant } : {}),
  });

  if (parsed.action === "ls") {
    const listings = listSecrets({
      settable: target.settable,
      store: readSecretStore(target.stateDir),
      tenantEnv: readEnvFile(target.envPath),
      processEnv,
      edits: readSecretEdits(target.stateDir),
    });
    io.out(
      parsed.json
        ? `${JSON.stringify({ tenant: target.slug, secrets: listings })}\n`
        : formatSecretListing(target.slug, listings),
    );
    return;
  }

  const key = parsed.key!;
  if (!target.settable.includes(key)) {
    throw new Error(offCatalogueRefusal(key, target.settable));
  }

  if (parsed.action === "clear") {
    const { cleared, edit } = clearSecret({ stateDir: target.stateDir, key });
    io.out(
      cleared
        ? `[phoebe] secret: cleared ${key} for ${target.slug} (edit ${edit!.id}). ` +
            `The .env or ambient value governs again.\n`
        : `[phoebe] secret: ${key} was not in ${target.slug}'s store — nothing to clear.\n`,
    );
    return;
  }

  const value = await readSecretValue(deps.stdin ?? process.stdin);
  if (value.length === 0) {
    throw new Error(
      `No value on stdin for ${key}. A blank is not a secret — \`phoebe secret clear ${key}\` ` +
        `is how you hand the key back to the .env.`,
    );
  }
  const edit = setSecret({ stateDir: target.stateDir, key, value });
  io.out(
    `[phoebe] secret: wrote ${key} for ${target.slug} (edit ${edit.id}) to ` +
      `${secretStorePath(target.stateDir)}.\n`,
  );

  if (parsed.noDoctor) return;
  // The receipt ends at `written` (#503): this run says whether the deployment
  // is healthy *now*, not whether the child has picked the value up. The
  // supervisor's own relaunch and its lease are what deliver it.
  const runDoctorFor = deps.runDoctorFor ?? defaultRunDoctor;
  const verdict = await runDoctorFor(dirname(configPath), processEnv);
  io.out(verdict.text);
  return { doctorOk: verdict.ok };
}

/** The real doctor run, imported lazily so `phoebe secret ls` never loads it. */
async function defaultRunDoctor(
  configDir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; text: string }> {
  const { formatDoctorReport, runDoctor } = await import("./doctor.ts");
  const report = await runDoctor({ configDir }, { env });
  return { ok: report.ok, text: `${formatDoctorReport(report)}\n` };
}
