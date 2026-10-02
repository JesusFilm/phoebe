// `phoebe config set <path> <value>` — the write half of `phoebe config` (#536;
// decision #503).
//
// One verb, three callers. An operator types it at a shell; the relay hands the
// same `{ path, value }` to the same writer (src/config-edit.ts) from a message;
// the companion calls {@link runConfigSet} in its main process for an install on
// this machine (#557). Nothing about the edit changes between the three — only
// where the fingerprint came from, whether there is a supervisor loop in this
// process to nudge, and whether there is a ledger volume to keep a record on.
//
// The command also carries the validation half the bootstrapper spawns:
// `--validate` loads the config through the engine's own loader, applies the
// patch to what it loaded, and prints a verdict without touching the disk. That
// is what makes "validated in the running engine's loader" literally true — the
// bootstrapper asks the materialized checkout the question, exactly as it asks
// that checkout for a tenant's pipelines and its effective config, so a
// deployment pinned to an older engine validates against the loader it is
// actually running.
//
// The patch is applied to the *loaded object* rather than to a re-imported
// candidate file, because there is nowhere to put a candidate: the deployment
// directory is `:ro` and the one writable file is the target itself. Nothing is
// lost by it. The splice substrate has already parsed the source and replaced
// one literal with a `JSON.stringify` of a scalar, so the candidate's syntax is
// a property of the mechanism; what is left to ask is whether the config still
// loads with that value in it, which is exactly what the loader answers.

import { readFileSync } from "node:fs";
import { matchConfigFlag } from "./cli-flags.ts";
import {
  applyConfigEdit,
  configEditLedgerPath,
  fingerprintOf,
  type PatchValidator,
} from "./config-edit.ts";
import { resolveConfig, validateUserConfig, type PhoebeUserConfig } from "./config-schema.ts";
import type { EditReceipt } from "./contracts/config-edit.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { resolveDataBase } from "./paths.ts";

export type ParsedConfigSetArgs = {
  help: boolean;
  json: boolean;
  validate: boolean;
  path?: string;
  value?: string;
  configPath?: string;
  id?: string;
  fingerprint?: string;
  by?: string;
};

const VALUE_FLAGS = new Set(["--id", "--fingerprint", "--by"]);

export function parseConfigSetArgs(argv: readonly string[]): ParsedConfigSetArgs {
  const parsed: ParsedConfigSetArgs = { help: false, json: false, validate: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--validate") {
      parsed.validate = true;
      continue;
    }
    const config = matchConfigFlag(argv, i);
    if (config !== undefined) {
      parsed.configPath = config.value;
      i += config.consumed - 1;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`\`${arg}\` needs a value. See \`phoebe config set --help\`.`);
      }
      if (arg === "--id") parsed.id = value;
      if (arg === "--fingerprint") parsed.fingerprint = value;
      if (arg === "--by") parsed.by = value;
      i += 1;
      continue;
    }
    // A leading `-` is a flag only when a letter follows it. `-1` is a value —
    // `priority` and the timeouts are numbers, and a negative one must reach the
    // loader to be rejected there rather than dying as an unknown flag here.
    if (/^--|^-[A-Za-z]/.test(arg)) {
      throw new Error(
        `Unknown flag \`${arg}\` for \`phoebe config set\`. See \`phoebe config set --help\`.`,
      );
    }
    positional.push(arg);
  }
  if (positional.length > 2) {
    throw new Error(
      `\`phoebe config set\` takes one path and one value (got ${positional.length} arguments). ` +
        `Quote a value that contains spaces.`,
    );
  }
  if (positional[0] !== undefined) parsed.path = positional[0];
  if (positional[1] !== undefined) parsed.value = positional[1];
  return parsed;
}

const CONFIG_SET_HELP_TEXT = `phoebe config set — change one field of the config, in place

Usage:
  phoebe config set <path> <value> [--config <path>]

  <path>   A dotted path into the config, the same path \`phoebe config\` prints
  <value>  JSON when it parses as JSON (42, true, null, "a b"), else a string

Flags:
  --json           Print the receipt instead of a sentence
  --fingerprint    Refuse unless the file still hashes to this (a console sends
                   the one the deployment report showed it)
  --id             Edit id; the same id twice is the same edit, applied once
  --by             Who asked, recorded in state/config-edits.json
  --validate       Answer whether the patched config loads, and write nothing

Only plain literals move. A leaf a PHOEBE_* variable already sets, the fleet
declaration, the engine pin, the relay block and the host's \`deployment\` block
are refused — and every refusal prints the edit to make by hand.
`;

/** The value at a dotted path, replaced, with only the objects along the path rebuilt. */
function withFieldAt(
  object: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (head === undefined) return object;
  const current = object[head];
  return {
    ...object,
    [head]:
      rest.length === 0
        ? value
        : withFieldAt(
            typeof current === "object" && current !== null
              ? (current as Record<string, unknown>)
              : {},
            rest,
            value,
          ),
  };
}

export type ValidateResult = { ok: true } | { ok: false; reason: string };

/**
 * Does the config still load with this value at this path?
 *
 * The workspace root takes the shorter answer on purpose. `resolveConfig` fills
 * a *tenant's* defaults and would reject a root for the five fields a root never
 * carries, so a root is validated by the shared field checks alone — which is
 * the same pair of arms `validateUserConfig` itself has.
 */
export async function validateConfigPatch(opts: {
  configPath: string;
  path: string;
  value: string | number | boolean | null;
  env?: NodeJS.ProcessEnv;
  dataBase?: string;
}): Promise<ValidateResult> {
  const env = opts.env ?? process.env;
  try {
    const user = await loadUserConfig(opts.configPath, { reloadKey: String(Date.now()) });
    const patched = withFieldAt(
      user as unknown as Record<string, unknown>,
      opts.path.split("."),
      opts.value,
    ) as unknown as PhoebeUserConfig;
    validateUserConfig(patched);
    if (patched.workspace === undefined) {
      resolveConfig(applyEnvOverlay(patched, env), {
        dataBase: opts.dataBase ?? resolveDataBase(env),
      });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** `<value>` as the config would hold it: JSON when it is JSON, else the string typed. */
export function parseSetValue(raw: string): string | number | boolean | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null) return null;
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      return parsed;
    }
  } catch {
    /* not JSON — the operator typed a bare string */
  }
  return raw;
}

/**
 * An id for an edit nobody gave one to. Derived from what the edit is and what
 * it was made against, so typing the same command twice in a row against an
 * unchanged file is one edit rather than two ledger entries.
 */
export function localEditId(opts: {
  path: string;
  value: string | number | boolean | null;
  fingerprint: string;
}): string {
  return `local:${fingerprintOf(`${opts.path}=${JSON.stringify(opts.value)}@${opts.fingerprint}`).slice(7, 23)}`;
}

/** The receipt as a sentence: what landed, or why it did not and what to type. */
export function formatReceipt(receipt: EditReceipt): string {
  if (receipt.state === "written") {
    return (
      `wrote ${receipt.path} = ${JSON.stringify(receipt.value)} in ${receipt.file}\n` +
      `  fingerprint ${receipt.fingerprint}\n` +
      `  the deployment reconciles onto it the way it would a hand edit.\n`
    );
  }
  return `refused (${receipt.reason}): ${receipt.why}\n\n${receipt.instruction}\n`;
}

/** What one `config set` is, wherever it was asked for. */
export type ConfigSetRequest = {
  /** The root config to edit. The one file any arm of this verb may write. */
  configPath: string;
  path: string;
  value: string | number | boolean | null;
  /**
   * The `sha256:<hex>` the caller was shown (#503). Absent only for a caller
   * that read the file and writes it in the same breath, with no report in
   * between to go stale — the shell run below is the one of those.
   */
  fingerprint?: string;
  id?: string;
  by?: string;
};

export type ConfigSetDeps = {
  env?: NodeJS.ProcessEnv;
  /**
   * Where the edit ledger lives. Defaults to the deployment's own data volume;
   * pass null for a caller with no redelivery to answer (see
   * {@link ConfigEditDeps.ledgerPath}).
   */
  ledgerPath?: string | null;
};

/**
 * Apply one field patch and answer with the receipt. The whole verb, with no
 * argv and no stdout in it — which is what lets the companion call it in main
 * and stream the receipt into an install tab (#527 §3).
 */
export async function runConfigSet(
  request: ConfigSetRequest,
  deps: ConfigSetDeps = {},
): Promise<EditReceipt> {
  const env = deps.env ?? process.env;
  const fingerprint = request.fingerprint ?? fingerprintOf(readConfigOrEmpty(request.configPath));
  const validate: PatchValidator = async (candidate) =>
    await validateConfigPatch({
      configPath: request.configPath,
      path: candidate.path,
      value: candidate.value,
      env,
    });

  return await applyConfigEdit(
    {
      id: request.id ?? localEditId({ path: request.path, value: request.value, fingerprint }),
      path: request.path,
      value: request.value,
      fingerprint,
      ...(request.by !== undefined ? { by: request.by } : {}),
    },
    {
      file: request.configPath,
      ledgerPath:
        deps.ledgerPath === undefined
          ? configEditLedgerPath(resolveDataBase(env))
          : deps.ledgerPath,
      validate,
      env,
    },
  );
}

/** `phoebe config set` entry. */
export async function runConfigSetCli(argv: readonly string[]): Promise<void> {
  const parsed = parseConfigSetArgs(argv);
  if (parsed.help) {
    process.stdout.write(CONFIG_SET_HELP_TEXT);
    return;
  }
  if (parsed.path === undefined || parsed.value === undefined) {
    throw new Error(
      "`phoebe config set` needs a path and a value: `phoebe config set <path> <value>`. " +
        "See `phoebe config set --help`.",
    );
  }
  const configPath = resolveConfigPath(parsed.configPath, process.cwd());
  const value = parseSetValue(parsed.value);

  if (parsed.validate) {
    const verdict = await validateConfigPatch({ configPath, path: parsed.path, value });
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    if (!verdict.ok) process.exitCode = 1;
    return;
  }

  // A shell run has no fingerprint to check itself against — it read the file
  // and writes it in one process, with no report in between to go stale. The
  // verb takes the file as it stands now and checks against that.
  const receipt = await runConfigSet({
    configPath,
    path: parsed.path,
    value,
    ...(parsed.fingerprint !== undefined ? { fingerprint: parsed.fingerprint } : {}),
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    ...(parsed.by !== undefined ? { by: parsed.by } : {}),
  });

  process.stdout.write(parsed.json ? `${JSON.stringify(receipt)}\n` : formatReceipt(receipt));
  if (receipt.state === "refused") process.exitCode = 1;
}

/** The config's bytes, or the empty string — an unreadable file is the writer's refusal to make. */
function readConfigOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
