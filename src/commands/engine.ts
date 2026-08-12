// Engine bootstrapping — the table's unnamed default entry (#73). Not CLI
// glue: `resolveConfigPath` → `loadEngineConfiguration` → `runEngine`. Loads
// the consumer's `phoebe.config.ts`, overlays `PHOEBE_*` env vars, then hands
// the resolved config straight to `runEngine`.
//
// A direct engine run (`--run-once` / `--dry-run`) always loads the config at
// cwd (solo has no selector; a workspace child is cd'd into like any other
// solo deployment). A boot-spawned child runs with cwd = its tenant dir, so
// this only fires for a manual invocation from a deployment root or child
// dir — `phoebe boot` (the supervisor) never reaches here. It also consumes
// boot's BOOTSTRAP_RESOLVED_CONFIG_ENV snapshot when present, so a
// boot-spawned child gets its pre-resolved config atomically rather than
// re-reading mutable files.

import type { CliContext } from "../cli-context.ts";
import {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  loadConfiguration,
  loadUserConfig,
  parseResolvedConfigurationSnapshot,
  resolveConfigPath,
  type ResolvedConfiguration,
} from "../config/index.ts";
import { resolveDataBase } from "../paths.ts";
import { runEngine } from "../main.ts";
import { parseCliArgs } from "./cli-args.ts";
import { COMMAND_TABLE } from "./table.ts";
import type { Command } from "./types.ts";

export { BOOTSTRAP_RESOLVED_CONFIG_ENV };
export { parseCliArgs, type ParsedCliArgs } from "./cli-args.ts";

/**
 * Engine-mode resolution. A boot-supervised child consumes boot's immutable
 * snapshot; a directly-invoked engine resolves the authored files itself.
 */
export function loadEngineConfiguration(
  configPath: string,
  env: NodeJS.ProcessEnv,
  dataBase?: string,
): Promise<ResolvedConfiguration> {
  const snapshot = env[BOOTSTRAP_RESOLVED_CONFIG_ENV];
  return snapshot === undefined
    ? loadConfiguration({ repositoryPath: configPath, env, dataBase })
    : Promise.resolve(parseResolvedConfigurationSnapshot(snapshot));
}

// The engine command's `--help` prints the full root usage (every command's
// one-liner plus engine-mode options) — this is what `phoebe --help` with no
// subcommand has always shown, so it lives here rather than being duplicated
// in commands/index.ts.
//
// `buildHelpText` splits that usage block around the named-commands list so
// the bootstrapper (#75) can splice `boot`'s one-liner in without duplicating
// the rest of the text — `boot` is composed onto the table from outside
// `src/`, so `src/` itself never lists it (a standalone `node src/cli.ts` has
// no `boot`).
const HELP_BANNER = `phoebe — AFK coding agent

Usage:
`;

/**
 * Every table entry's `summary`, indented and newline-terminated, in table
 * order (#74) — the mechanical part of root usage. Adding a command to
 * `COMMAND_TABLE` (./table.ts) makes it appear here with no second edit; a
 * command whose usage needs more than one line (`init`'s profile flags,
 * `serve`'s `--state-dir`) embeds its own continuation lines in `summary`.
 */
function renderCommandLines(): string {
  return Object.values(COMMAND_TABLE)
    .map((command) => `  ${command.summary}\n`)
    .join("");
}

const HELP_FOOTER = `  phoebe [--config <path>] [flags] Run the engine

Options (engine mode):
  --config, -c <path>   Path to phoebe.config.ts (default: ./phoebe.config.ts)
  --run-once            Work one unit of the first one-shot-eligible kind, then exit
  --dry-run             Print the selected unit without executing it
  --help, -h            Show this message

Environment overlays (each replaces the corresponding config field):
  PHOEBE_REPO_SLUG, PHOEBE_REPO_URL, PHOEBE_DEFAULT_BRANCH, PHOEBE_BRANCH_PREFIX,
  PHOEBE_READY_LABEL, PHOEBE_RESEARCH_LABEL, PHOEBE_PROCESSING_LABEL, PHOEBE_PR_OPT_OUT_LABEL,
  PHOEBE_INSTALL_COMMAND, PHOEBE_CHECK_COMMAND, PHOEBE_TEST_COMMAND,
  PHOEBE_READY_COMMAND, PHOEBE_BLOCKED_BY_PATTERN, PHOEBE_REVIEWS_SUCCESS_HEADING,
  PHOEBE_PR_SCOPE, PHOEBE_PR_BASE_SCOPE, PHOEBE_DRAFT_PRS, PHOEBE_BLOCKER_SOURCE,
  PHOEBE_STACK_MODE, PHOEBE_DEFAULT_PROVIDER

Runtime toggles (read directly by the engine, not overlaid onto the config):
  PHOEBE_BASE_CONFIG     Absolute path to a versioned generated base config
  PHOEBE_AGENT           Provider name to use for this run (cursor|claude|codex)
  PHOEBE_MODEL           Model to use for this run
  PHOEBE_EFFORT          Effort level to use for this run (claude only)
  PHOEBE_RUNTIME_ID      Stable identity for a new state volume
  PHOEBE_POLL_INTERVAL_MS Persistent-mode poll interval (default 300000)
`;

/**
 * Build the root usage text, optionally splicing extra named-command
 * one-liners (each already newline-terminated) in just before the engine's
 * own unnamed-default line. With no argument this is byte-for-byte the
 * `phoebe --help` text the engine table alone has always shown.
 */
export function buildHelpText(extraCommandLines = ""): string {
  return HELP_BANNER + renderCommandLines() + extraCommandLines + HELP_FOOTER;
}

export const HELP_TEXT = buildHelpText();

/**
 * Refuse to run the engine on a workspace-root config. Presence of the
 * `workspace` block is what selects workspace mode (#83/#91); the engine runs
 * one tenant at a time, so a root config on the engine-run path can only fall
 * through to `resolveConfig` and die with a "missing required field(s)" error
 * about tenant fields the root never carries — the same misleading-error
 * landmine `RemovedReposLayoutError` guards against on the boot path.
 */
export function assertNotWorkspaceRoot(
  userConfig: { workspace?: unknown },
  configPath: string,
): void {
  if (userConfig.workspace === undefined) return;
  throw new Error(
    `${configPath} is a workspace root (it carries a \`workspace\` block). The engine runs one ` +
      `tenant at a time: run \`phoebe\` from a tenant directory, or \`phoebe boot\` here to ` +
      `supervise the fleet.`,
  );
}

/** Engine-mode run body, parametrized on which root usage `--help` prints —
 *  the table's own default (`HELP_TEXT`) or the bootstrapper's extended text
 *  (`buildHelpText` plus `boot`'s line, #75). */
export async function runEngineMode(
  argv: readonly string[],
  ctx: CliContext,
  helpText: string,
): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    ctx.stdout.write(helpText);
    return 0;
  }

  const dataBase = resolveDataBase(ctx.env);
  const usesBootSnapshot = ctx.env[BOOTSTRAP_RESOLVED_CONFIG_ENV] !== undefined;
  const configPath = usesBootSnapshot
    ? (parsed.configPath ?? "phoebe.config.ts")
    : resolveConfigPath(parsed.configPath, ctx.cwd);
  if (!usesBootSnapshot) {
    const userConfig = await loadUserConfig(configPath);
    assertNotWorkspaceRoot(userConfig, configPath);
  }
  const resolved = await loadEngineConfiguration(configPath, ctx.env, dataBase);
  await runEngine({ config: resolved.config, argv: parsed.forward });
  return 0;
}

export const engineCommand: Command = {
  name: "",
  summary: "phoebe [--config <path>] [flags] Run the engine",
  help: HELP_TEXT,
  run: (argv, ctx) => runEngineMode(argv, ctx, HELP_TEXT),
};
