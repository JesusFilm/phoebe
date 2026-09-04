// The `pipelines` subcommand (#417): the one question the bootstrapper asks a
// materialized engine checkout about a tenant's config.
//
// The supervisor spawns one child per (tenant × pipeline), so it needs the row
// names before it can spawn anything — but it must not learn to read the
// `pipelines` block itself. `bootstrap/boot.ts` imports `loadUserConfig` from
// the *npm package*, so everything the bootstrapper understands about a config
// is pinned to the installed launcher version; parsing rows there would mean an
// npm release per pipeline knob, which is exactly what the engine-source design
// exists to avoid (#401). So the engine answers instead, and the supervisor
// diffs opaque strings.
//
// One row of the answer is `{ name, disabled, priority, concurrency,
// needsClone, fingerprint }` — everything the supervisor needs to spawn, order,
// throttle and relaunch a row, and nothing about what the row does. The shape
// is an object per row so the per-row `env` of #410 lands as a field rather
// than a new command.

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { resolveConfig, type PhoebeConfig, type ResolvedPipeline } from "./config-schema.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { resolveDataBase } from "./paths.ts";
import { rowOwnedKinds, selectPipelineRow } from "./pipeline-row.ts";
import { setResolvedConfig } from "./resolved-config.ts";
import { createWorkKindRegistry } from "./work-kinds/load-custom.ts";
import type { WorkspaceMode } from "./work-kinds/definition.ts";

/**
 * The output contract's version. Bumped when a field changes meaning; new
 * fields are additive and do not move it, since a supervisor reads the fields
 * it knows and ignores the rest.
 */
export const PIPELINE_ENUMERATION_VERSION = 1;

/** One row as the supervisor sees it: how to run it, and when to relaunch it. */
export type EnumeratedRow = {
  name: string;
  /** Hot: the operator's off-switch, acted on without relaunching the row. */
  disabled: boolean;
  /** Hot: tenant-local priority for a contended concurrency slot. */
  priority: number;
  /** Units this row may hold in flight. */
  concurrency: number;
  /**
   * Whether this row's work needs the tenant's git clone — true when any kind
   * it owns declares a `worktree` or `readonly` workspace (#403).
   */
  needsClone: boolean;
  /** Opaque digest of the row's cold config; a move means relaunch this row. */
  fingerprint: string;
};

/** What the subcommand prints on stdout: one JSON object, last line. */
export type PipelineEnumeration = {
  version: number;
  rows: EnumeratedRow[];
};

/** What the subcommand prints for `--probe`: capability, not a tenant's rows. */
export type PipelineProbe = { version: number; supported: true };

/** The workspace modes that mean "this row wants the tenant's clone". */
const CLONE_WORKSPACE_MODES: ReadonlySet<WorkspaceMode> = new Set(["worktree", "readonly"]);

/**
 * The two knobs that are hot at every scope (#402/#407): the supervisor acts on
 * a change to either without relaunching the row, so a fingerprint that moved
 * with them would relaunch it anyway and make the hotness a lie. Stripped at
 * every nesting level because `disabled` is declarable on the row *and* on each
 * of its kinds.
 */
const HOT_KEYS: ReadonlySet<string> = new Set(["disabled", "priority"]);

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, hot keys
 * stripped wherever they appear. Stable across processes, which is what lets
 * two boots of the same config produce the same fingerprint.
 *
 * Functions serialize as their source. A config may declare a work kind inline,
 * definition members and all, and an edited `run` body is a genuine change to
 * what the row does — hashing the shape around it and calling that "unchanged"
 * would leave the edit running until something else moved.
 */
function canonicalJson(value: unknown): string {
  if (typeof value === "function") return JSON.stringify(String(value));
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const members = Object.entries(value as Record<string, unknown>)
    .filter(([key, member]) => member !== undefined && !HOT_KEYS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${members.join(",")}}`;
}

/**
 * The row's fingerprint: its own resolved config, minus the hot knobs, hashed.
 * The name is part of it so two rows tuned identically still differ — a rename
 * is a delete plus a create (#411), never a silent hand-over.
 *
 * Deliberately not covering tenant-wide fields (`repoSlug`, `gitIdentity`, the
 * deprecated top-level `promptFiles`): a change there is not attributable to
 * one row, and the supervisor fans those out to every row of the tenant.
 */
export function rowFingerprint(name: string, row: ResolvedPipeline): string {
  return createHash("sha256").update(canonicalJson({ name, row })).digest("hex").slice(0, 16);
}

/**
 * Enumerate the tenant's rows. Every row's work-kind registry is assembled on
 * the way past, which is what makes `needsClone` derivable — and what makes a
 * factory kind that self-checks its prompt files (#408) fail *here*, at
 * enumeration, where the supervisor reads it as a tenant-level fault rather
 * than discovering it one spawn later.
 *
 * The resolved row config is installed before each registry is assembled, the
 * same ordering the engine-run path uses (src/cli.ts), so a custom kind's
 * factory sees the config it would see at run time.
 */
export async function enumeratePipelineRows(
  config: PhoebeConfig,
  configDir: string,
): Promise<EnumeratedRow[]> {
  const rows: EnumeratedRow[] = [];
  for (const [name, row] of Object.entries(config.pipelines)) {
    const rowConfig = selectPipelineRow(config, name);
    setResolvedConfig(rowConfig);
    const registry = await createWorkKindRegistry(rowConfig, configDir);
    // Every kind the row owns, disabled ones included: `disabled` is hot, and a
    // hot knob must not flip a fact the supervisor provisions against. A row
    // that switches its last worktree kind off keeps its clone until something
    // cold moves.
    const owned = rowOwnedKinds({ pipelines: config.pipelines, pipeline: name, row });
    rows.push({
      name,
      disabled: row.disabled,
      priority: row.priority,
      concurrency: row.concurrency,
      needsClone: owned.some((kind) => {
        const mode = registry.get(kind)?.definition.workspace;
        return mode !== undefined && CLONE_WORKSPACE_MODES.has(mode);
      }),
      fingerprint: rowFingerprint(name, row),
    });
  }
  return rows;
}

export type ParsedPipelinesArgs = {
  configPath: string | undefined;
  probe: boolean;
  help: boolean;
};

/**
 * Parse the subcommand's argv. `--probe` asks the checkout whether it supports
 * enumeration at all and reads no config: capability is a property of the
 * engine, validity a property of the tenant, and a supervisor that could not
 * tell them apart would spawn a `work` row against a config it already knows is
 * broken (#401).
 */
export function parsePipelinesArgs(argv: readonly string[]): ParsedPipelinesArgs {
  let configPath: string | undefined;
  let probe = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--probe") {
      probe = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`${arg} requires a path argument (e.g. --config phoebe.config.ts).`);
      }
      configPath = next;
      i += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    throw new Error(
      `Unknown argument \`${String(arg)}\` for \`phoebe pipelines\`. ` +
        `See \`phoebe pipelines --help\`.`,
    );
  }
  return { configPath, probe, help };
}

const PIPELINES_HELP_TEXT = `phoebe pipelines — print this tenant's pipeline rows as JSON

Usage:
  phoebe pipelines [--config <path>]   One JSON object: { version, rows[] }
  phoebe pipelines --probe             Report that this engine supports enumeration

Each row carries its name, the hot knobs (disabled, priority), its concurrency,
whether it needs the tenant's git clone, and an opaque fingerprint that moves
when the row's cold config does. The supervisor reads it; nothing else does.
`;

/**
 * Refuse to enumerate a workspace root. Rows live inside a tenant, so a root
 * carries no `pipelines` block by construction — enumerating one would report
 * a single default `work` row for a config that runs no work at all.
 */
function assertTenantConfig(userConfig: { workspace?: unknown }, configPath: string): void {
  if (userConfig.workspace === undefined) return;
  throw new Error(
    `${configPath} is a workspace root (it carries a \`workspace\` block). Pipelines are rows ` +
      `of work inside one tenant — enumerate a tenant's config instead.`,
  );
}

/**
 * `phoebe pipelines [--config <path>]`. Prints one JSON object as the final
 * line of stdout — final, not only, so a chatty custom kind module loading
 * during enumeration cannot corrupt the answer.
 */
export async function runPipelinesCli(argv: readonly string[]): Promise<void> {
  const parsed = parsePipelinesArgs(argv);
  if (parsed.help) {
    process.stdout.write(PIPELINES_HELP_TEXT);
    return;
  }
  if (parsed.probe) {
    const probe: PipelineProbe = { version: PIPELINE_ENUMERATION_VERSION, supported: true };
    process.stdout.write(`${JSON.stringify(probe)}\n`);
    return;
  }
  const configPath = resolveConfigPath(parsed.configPath, process.cwd());
  const userConfig = await loadUserConfig(configPath);
  assertTenantConfig(userConfig, configPath);
  const overlaid = applyEnvOverlay(userConfig, process.env);
  const config = resolveConfig(overlaid, { dataBase: resolveDataBase(process.env) });
  const enumeration: PipelineEnumeration = {
    version: PIPELINE_ENUMERATION_VERSION,
    rows: await enumeratePipelineRows(config, dirname(configPath)),
  };
  process.stdout.write(`${JSON.stringify(enumeration)}\n`);
}
