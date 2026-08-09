// Engine bootstrapping — the table's unnamed default entry (#73). Not CLI
// glue: `extractRepoFlag` → `resolveEngineConfigPath` → `loadEngineConfiguration`
// → `runEngine`. Loads the consumer's `phoebe.config.ts`, overlays `PHOEBE_*`
// env vars, then hands the resolved config straight to `runEngine`.
//
// A direct engine run (`--run-once` / `--dry-run`) selects its tenant (#63):
// flat has no selector; nested requires `--repo <owner/repo>`, loading only
// that tenant's config. A boot-spawned child runs with cwd = its tenant dir
// (flat from there), so this only fires for a manual invocation from the
// deployment root. `phoebe boot` (the supervisor) never reaches here. It also
// consumes boot's BOOTSTRAP_RESOLVED_CONFIG_ENV snapshot when present, so a
// boot-spawned child gets its pre-resolved config atomically rather than
// re-reading mutable files.

import { join } from "node:path";
import { REPOS_DIR } from "../../bootstrap/tenants.ts";
import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import type { CliContext } from "../cli-context.ts";
import {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  loadConfiguration,
  parseResolvedConfigurationSnapshot,
  resolveConfigPath,
  type ResolvedConfiguration,
} from "../config/index.ts";
import { resolveDataBase } from "../paths.ts";
import { runEngine } from "../main.ts";
import { isNested, parseSlug } from "../tenant-commands.ts";
import { parseCliArgs } from "./cli-args.ts";
import { COMMAND_TABLE } from "./table.ts";
import type { Command } from "./types.ts";

export { BOOTSTRAP_RESOLVED_CONFIG_ENV };
export { parseCliArgs, type ParsedCliArgs } from "./cli-args.ts";

const REPO_FLAG_SPEC: ArgSpec = {
  guardedValueFlags: ["repo"],
  onUnknownFlag: "forward",
};

/** Pull an optional `--repo <owner/repo>` (or `--repo=…`) out of the engine argv. */
function extractRepoFlag(argv: readonly string[]): { slug: string | undefined; forward: string[] } {
  const parsed = parseArgs(argv, REPO_FLAG_SPEC);
  const slug = parsed.flags["repo"];
  return { slug: typeof slug === "string" ? slug : undefined, forward: parsed.positionals };
}

/**
 * Resolve which `phoebe.config.ts` a direct engine run loads. An explicit
 * `--config` always wins. Otherwise: nested (a `repos/` dir under cwd) requires
 * `--repo <owner/repo>` and loads `repos/<owner>/<repo>/phoebe.config.ts`; flat
 * loads the top config and ignores `--repo`.
 */
function resolveEngineConfigPath(
  configArg: string | undefined,
  repoSlug: string | undefined,
  cwd: string,
): string {
  if (configArg !== undefined) return resolveConfigPath(configArg, cwd);
  if (isNested(cwd)) {
    if (repoSlug === undefined) {
      throw new Error(
        "This is a nested (multi-tenant) deployment — specify --repo <owner/repo> " +
          "(see `phoebe list`), or run `phoebe boot` to supervise every tenant.",
      );
    }
    const { owner, repo } = parseSlug(repoSlug);
    return resolveConfigPath(join(REPOS_DIR, owner, repo, "phoebe.config.ts"), cwd);
  }
  return resolveConfigPath(undefined, cwd);
}

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
    : Promise.resolve(parseResolvedConfigurationSnapshot(snapshot, { dataBase }));
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

  const { slug: repoSlug, forward } = extractRepoFlag(parsed.forward);
  const dataBase = resolveDataBase(ctx.env);
  const configPath =
    ctx.env[BOOTSTRAP_RESOLVED_CONFIG_ENV] === undefined
      ? resolveEngineConfigPath(parsed.configPath, repoSlug, ctx.cwd)
      : (parsed.configPath ?? "phoebe.config.ts");
  const resolved = await loadEngineConfiguration(configPath, ctx.env, dataBase);
  await runEngine({ config: resolved.config, argv: forward });
  return 0;
}

export const engineCommand: Command = {
  name: "",
  summary: "phoebe [--config <path>] [flags] Run the engine",
  help: HELP_TEXT,
  run: (argv, ctx) => runEngineMode(argv, ctx, HELP_TEXT),
};
