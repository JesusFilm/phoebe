// `phoebe config` — print the effective config (#531; decisions #502, #513).
//
// The read-only verb an operator runs to answer "what is this deployment
// actually running, and why". Human text by default; `--json` emits the object
// section 5 of the deployment report embeds, so a console and a terminal agree
// by construction rather than by two renderers staying in step.
//
// This module is the I/O half. It resolves which configs to read (a workspace
// root reports every child; anything else reports itself), opens each one, reads
// the `.env` files it can see so an env value can say *which* file set it, and
// hands all of that to `computeEffectiveConfig` — the one owner of the shape
// (src/effective-config.ts). Nothing here decides a precedence question.
//
// Failure is per tenant, deliberately. A config that will not load is one
// tenant's `{ error, fields: null, env: null }` row and the rest of the fleet
// still reports; the exit code turns non-zero only when every tenant errored,
// because "one repo has a typo" and "this deployment is broken" are different
// news and an operator acts on them differently.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import { readConfigDir } from "../bootstrap/config-dir.ts";
import { TENANT_ENV_FILE } from "../bootstrap/tenants.ts";
import {
  EFFECTIVE_CONFIG_VERSION,
  type EffectiveFields,
  type EffectiveLeaf,
  type TenantEffectiveConfig,
} from "./contracts/effective-config.ts";
import { resolveConfig } from "./config-schema.ts";
import {
  computeEffectiveConfig,
  effectiveConfigError,
  isLeaf,
  type EnvLayers,
} from "./effective-config.ts";
import { matchConfigFlag } from "./cli-flags.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { resolveDataBase } from "./paths.ts";
import { enumerateDeclaredEnv } from "./pipeline-enumerate.ts";
import { enumerateWorkspaceTenants } from "./tenant-commands.ts";

/** What `--json` emits, and what the deployment report embeds one row of. */
export type EffectiveConfigReport = {
  version: number;
  tenants: TenantEffectiveConfig[];
};

export type ParsedConfigArgs = {
  help: boolean;
  json: boolean;
  configPath?: string;
};

export function parseConfigArgs(argv: readonly string[]): ParsedConfigArgs {
  let help = false;
  let json = false;
  let configPath: string | undefined;
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
    const config = matchConfigFlag(argv, i);
    if (config !== undefined) {
      configPath = config.value;
      i += config.consumed - 1;
      continue;
    }
    throw new Error(`Unknown flag \`${arg}\` for \`phoebe config\`. See \`phoebe config --help\`.`);
  }
  return { help, json, ...(configPath !== undefined ? { configPath } : {}) };
}

const CONFIG_HELP_TEXT = `phoebe config — print the effective config (read-only)

Usage:
  phoebe config [--config <path>]   Every setting, its value, and where it came from
  phoebe config --json              The same object the deployment report embeds
  phoebe config set <path> <value>  Change one field in place (\`set --help\`)

Run against a workspace root it reports every tenant; anywhere else it reports
the config it found. A tenant whose config will not load is one errored row —
the exit code is non-zero only when every tenant errored.

Each leaf says its source: default, file, alias (a permanent older name),
overlay (a PHOEBE_* variable), derived, or inherited from a shallower path.
The env section reports that a variable is set and where, never its value.
`;

/** Parse a `.env` file into a layer, or nothing when it is absent or unreadable. */
function readEnvFile(path: string): NodeJS.ProcessEnv | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A tenant's asset directory — where its `.env` lives. `configDir` relocates it
 * (a standalone deployment reusing its dotfolder), so the field is read off the
 * config rather than assumed beside it.
 */
function assetDirOf(configPath: string, user: Record<string, unknown>): string {
  try {
    return join(dirname(configPath), readConfigDir(user));
  } catch {
    return dirname(configPath);
  }
}

/**
 * The env keys this tenant's scheduled kinds declared. Best effort on purpose:
 * collecting them loads the tenant's kind modules, and a kind that will not load
 * is a real fault — but it is `phoebe doctor`'s fault to report, not a reason to
 * withhold every setting in the file.
 */
async function declaredEnvKeys(
  user: Record<string, unknown>,
  configPath: string,
  env: NodeJS.ProcessEnv,
  dataBase: string,
): Promise<string[]> {
  try {
    const config = resolveConfig(applyEnvOverlay(user as never, env), { dataBase });
    const declarations = await enumerateDeclaredEnv(config, dirname(configPath));
    return [...new Set(declarations.flatMap((declaration) => declaration.keys))];
  } catch {
    return [];
  }
}

/** One tenant's row: load its config, read what env it can see, annotate. */
async function effectiveConfigFor(opts: {
  configPath: string;
  dataBase: string;
  processEnv: NodeJS.ProcessEnv;
  rootEnv?: NodeJS.ProcessEnv;
  /** The tenant's own `.env`, when discovery already located it. */
  envPath?: string;
}): Promise<TenantEffectiveConfig> {
  const { configPath, dataBase, processEnv } = opts;
  try {
    const user = await loadUserConfig(configPath);
    const envPath = opts.envPath ?? join(assetDirOf(configPath, user), TENANT_ENV_FILE);
    const tenantEnv = readEnvFile(envPath);
    const layers: EnvLayers = {
      process: processEnv,
      ...(opts.rootEnv !== undefined ? { root: opts.rootEnv } : {}),
      ...(tenantEnv !== undefined ? { tenant: tenantEnv } : {}),
    };
    return computeEffectiveConfig({
      user,
      configPath,
      env: layers,
      dataBase,
      declaredEnv: await declaredEnvKeys(user, configPath, processEnv, dataBase),
    });
  } catch (error) {
    return effectiveConfigError(configPath, error);
  }
}

/**
 * Every tenant this deployment runs, annotated. A workspace root fans out to its
 * children — including the held ones, which report as errored rows, since a
 * tenant discovery could not read is precisely a tenant whose settings are
 * unknown. Anything else is one tenant: itself.
 */
export async function collectEffectiveConfig(opts: {
  configPath: string;
  dataBase: string;
  processEnv?: NodeJS.ProcessEnv;
}): Promise<EffectiveConfigReport> {
  const processEnv = opts.processEnv ?? process.env;
  const rootDir = dirname(opts.configPath);
  const rootEnv = readEnvFile(join(rootDir, TENANT_ENV_FILE));
  const enumeration = await enumerateWorkspaceTenants({ configDir: rootDir });
  if (enumeration === null) {
    return {
      version: EFFECTIVE_CONFIG_VERSION,
      tenants: [
        await effectiveConfigFor({
          configPath: opts.configPath,
          dataBase: opts.dataBase,
          processEnv,
        }),
      ],
    };
  }

  const tenants: TenantEffectiveConfig[] = [];
  for (const tenant of enumeration.tenants) {
    tenants.push(
      await effectiveConfigFor({
        configPath: tenant.configPath,
        dataBase: opts.dataBase,
        processEnv,
        ...(rootEnv !== undefined ? { rootEnv } : {}),
        envPath: tenant.envPath,
      }),
    );
  }
  for (const hold of enumeration.holds) {
    tenants.push(
      effectiveConfigError(
        relative(rootDir, hold.dir) || hold.dir,
        new Error(`held — ${hold.reason}`),
      ),
    );
  }
  return { version: EFFECTIVE_CONFIG_VERSION, tenants };
}

// --- human output -----------------------------------------------------------

/** A leaf's value as one line shows it. `null` is "nothing set it", not "null". */
function renderValue(leaf: EffectiveLeaf): string {
  if (leaf.opaque === true) return `${String(leaf.value)}  [opaque]`;
  if (leaf.value === null) return "(unset)";
  return JSON.stringify(leaf.value);
}

/** `(source via X from Y)` — the provenance half of a line. */
function renderSource(source: string, via?: string, from?: string): string {
  const parts = [source];
  if (via !== undefined) parts.push(`via ${via}`);
  if (from !== undefined) parts.push(`from ${from}`);
  return `(${parts.join(" ")})`;
}

/**
 * A `via` as a line shows it: a config path under the working directory loses
 * the prefix, because the absolute path is the same on every line of the report
 * and the interesting half is at the end. The JSON keeps it whole.
 */
function shorten(via: string | undefined, cwd: string): string | undefined {
  if (via === undefined || !via.startsWith(`${cwd}/`)) return via;
  return via.slice(cwd.length + 1);
}

/**
 * One branch: every leaf as `path = value  (source via X)`, then the
 * sub-branches a level deeper. The line carries its whole dotted path even
 * though the indentation already implies it — `phoebe config | grep model` is
 * how this output gets used, and a line that only makes sense in context is no
 * use to the person grepping it.
 */
function renderBranch(opts: {
  branch: EffectiveFields;
  path: string;
  depth: number;
  cwd: string;
  lines: string[];
}): void {
  const { branch, path, depth, cwd, lines } = opts;
  const indent = "  ".repeat(depth);
  const pathTo = (key: string): string => (path === "" ? key : `${path}.${key}`);
  for (const [key, leaf] of Object.entries(branch)) {
    if (!isLeaf(leaf)) continue;
    lines.push(
      `${indent}${pathTo(key)} = ${renderValue(leaf)}  ` +
        `${renderSource(leaf.source, shorten(leaf.via, cwd), leaf.from)}`,
    );
    for (const shadow of leaf.shadowed ?? []) {
      lines.push(
        `${indent}  shadowed: ${renderSource(shadow.source, shorten(shadow.via, cwd))} = ` +
          `${shadow.value === null ? "(unset)" : JSON.stringify(shadow.value)}`,
      );
    }
  }
  for (const [key, node] of Object.entries(branch)) {
    if (isLeaf(node)) continue;
    renderBranch({ branch: node, path: pathTo(key), depth: depth + 1, cwd, lines });
  }
}

function renderTenant(tenant: TenantEffectiveConfig, cwd: string): string[] {
  const lines = [tenant.tenant];
  if (tenant.error !== null || tenant.fields === null) {
    lines.push(`  error: ${tenant.error ?? "unknown"}`);
    return lines;
  }
  renderBranch({ branch: tenant.fields, path: "", depth: 1, cwd, lines });
  if (tenant.env !== null) {
    lines.push("  env");
    for (const [name, presence] of Object.entries(tenant.env)) {
      lines.push(
        `    ${name} — ${presence.present ? `present (${presence.from ?? "process"})` : "missing"}`,
      );
    }
  }
  if (tenant.warnings.length > 0) {
    lines.push("  warnings");
    for (const warning of tenant.warnings) {
      lines.push(`    ${warning.path}: ${warning.message}`);
    }
  }
  return lines;
}

/**
 * The whole report as `phoebe config` prints it: one line per leaf, everything
 * shown including the defaults, pipelines and kinds indented under their
 * section. `cwd` only shortens file paths — nothing is read.
 */
export function formatEffectiveConfig(report: EffectiveConfigReport, cwd = process.cwd()): string {
  return `${report.tenants.flatMap((tenant) => [...renderTenant(tenant, cwd), ""]).join("\n")}\n`;
}

/**
 * Whether the command failed, as opposed to having found a fault. One broken
 * tenant beside three working ones is news an operator reads off the report; a
 * deployment where nothing loaded is a command that did not work. Only the
 * second is an exit code.
 */
export function everyTenantErrored(report: EffectiveConfigReport): boolean {
  return report.tenants.length > 0 && report.tenants.every((tenant) => tenant.error !== null);
}

/** `phoebe config` entry. */
export async function runConfigCli(argv: readonly string[]): Promise<void> {
  // The write half is its own module (#536): this one opens files to print
  // them, that one opens one file to change it, and keeping the read verb free
  // of the writer is what makes "`phoebe config` never touches the disk" a
  // property of the import graph rather than a promise in a comment.
  if (argv[0] === "set") {
    const { runConfigSetCli } = await import("./config-set.ts");
    return await runConfigSetCli(argv.slice(1));
  }
  const parsed = parseConfigArgs(argv);
  if (parsed.help) {
    process.stdout.write(CONFIG_HELP_TEXT);
    return;
  }
  const configPath = resolveConfigPath(parsed.configPath, process.cwd());
  const report = await collectEffectiveConfig({
    configPath,
    dataBase: resolveDataBase(process.env),
  });
  process.stdout.write(parsed.json ? `${JSON.stringify(report)}\n` : formatEffectiveConfig(report));
  if (everyTenantErrored(report)) process.exitCode = 1;
}
