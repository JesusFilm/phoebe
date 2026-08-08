#!/usr/bin/env node

// `phoebe` bin — the packaged CLI consumers invoke via
// `npx phoebe-agent [flags]` (or a pinned `phoebe` script). Recognises two
// modes:
//
//   phoebe init [dir]   Scaffold a consumer-owned runtime (config, prompts,
//                       .env.example, container templates, gitignore).
//                       Skips existing files — safe to re-run.
//   phoebe [flags]      Run the engine. Loads the consumer's
//                       `phoebe.config.ts`, overlays `PHOEBE_*` env vars,
//                       installs the resolved config, then hands off to main.
//
// This is the only supported v1 programmatic surface: there is no exported
// `run(config)` — CLI-only. That keeps every consumer on the same load/resolve/
// install pipeline and leaves the door open to CLI-only concerns (init/pin
// scaffolding, log formatting) without breaking a library API.

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPOS_DIR } from "../bootstrap/tenants.ts";
import { resolveConfig } from "./config-schema.ts";
import {
  copyShippedPromptsInto,
  formatInitReport,
  initTenant,
  runInit,
  type InitProfile,
} from "./init.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { resolveDataBase } from "./paths.ts";
import { setResolvedConfig } from "./resolved-config.ts";
import {
  addRepo,
  isNested,
  LIST_HELD_LEGEND,
  listTenants,
  parseSlug,
  purgeTenant,
  readFlatRepoFields,
  removeRepo,
  TRUST_DOMAIN_NOTE,
  type TenantListing,
} from "./tenant-commands.ts";

type ParsedArgs = { configPath: string | undefined; help: boolean; forward: string[] };

/**
 * Extract `--config <path>` / `--config=<path>` / `-c <path>` and `--help`/`-h`
 * from argv, forwarding everything else to `runEngine`. A minimal parser is
 * enough — the engine handles its own boolean flags (`--run-once`, `--dry-run`)
 * from the forwarded array.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const forward: string[] = [];
  let configPath: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (next === undefined) {
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
    if (arg !== undefined) {
      forward.push(arg);
    }
  }
  return { configPath, help, forward };
}

export type ParsedInitArgs = {
  targetDir: string;
  help: boolean;
  /**
   * Scaffold profile. Default `flat` (today's single-tenant layout).
   * `--workspace` and `--tenant` are mutually exclusive (#93/#94).
   */
  profile: InitProfile;
  /** Tenant profile: explicit slug override (wins over origin prefill). */
  repoSlug?: string;
  /** Tenant profile: explicit url override (wins over origin prefill). */
  repoUrl?: string;
  /** Tenant profile: opt-in seed of shipped prompts. */
  withPrompts: boolean;
};

/**
 * Parse argv left after the leading `init` token has been consumed. Supports
 * an optional positional target directory (`phoebe init ./my-agent`), the
 * mutually exclusive profile flags `--workspace` / `--tenant`, tenant-only
 * overrides (`--slug`, `--url`, `--with-prompts`), and `--help`. Extra flags
 * are rejected loudly so a typo like `--forcee` fails fast instead of being
 * silently ignored.
 */
export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  let targetDir: string | undefined;
  let help = false;
  let profile: InitProfile = "flat";
  let profileFlag: string | undefined;
  let repoSlug: string | undefined;
  let repoUrl: string | undefined;
  let withPrompts = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--workspace" || arg === "--tenant") {
      if (profileFlag !== undefined) {
        throw new Error(
          `\`phoebe init\` flags \`--workspace\` and \`--tenant\` are mutually exclusive ` +
            `(got both \`${profileFlag}\` and \`${arg}\`).`,
        );
      }
      profileFlag = arg;
      profile = arg === "--workspace" ? "workspace" : "tenant";
      continue;
    }
    if (arg === "--with-prompts") {
      withPrompts = true;
      continue;
    }
    if (arg === "--slug" || arg.startsWith("--slug=")) {
      const value = arg === "--slug" ? argv[++i] : arg.slice("--slug=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new Error("`--slug` requires an `owner/repo` value.");
      }
      repoSlug = value;
      continue;
    }
    if (arg === "--url" || arg.startsWith("--url=")) {
      const value = arg === "--url" ? argv[++i] : arg.slice("--url=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new Error("`--url` requires a git remote URL value.");
      }
      repoUrl = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag \`${arg}\` for \`phoebe init\`. See \`phoebe init --help\`.`);
    }
    if (targetDir !== undefined) {
      throw new Error(
        `\`phoebe init\` takes at most one target directory (got \`${targetDir}\` and \`${arg}\`).`,
      );
    }
    targetDir = arg;
  }

  if ((repoSlug !== undefined || repoUrl !== undefined || withPrompts) && profile !== "tenant") {
    throw new Error(
      `\`--slug\`, \`--url\`, and \`--with-prompts\` are only valid with \`phoebe init --tenant\`.`,
    );
  }

  return {
    targetDir: targetDir ?? ".",
    help,
    profile,
    ...(repoSlug !== undefined ? { repoSlug } : {}),
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    withPrompts,
  };
}

const HELP_TEXT = `phoebe — AFK coding agent

Usage:
  phoebe init [dir]                Scaffold a flat single-tenant deployment
  phoebe init --workspace [dir]    Scaffold a workspace root (multi-child)
  phoebe init --tenant [dir]       Scaffold a workspace child in-tree install
  phoebe add-repo <owner/repo>     Add a tenant (→ nested multi-tenant)
  phoebe remove-repo <owner/repo>  Remove a tenant's config (data retained)
  phoebe list [--json] [--check]    List tenants + health (in-container)
  phoebe purge <owner/repo> --yes  Wipe a removed tenant's data (in-container)
  phoebe [--config <path>] [flags] Run the engine

Options (engine mode):
  --config, -c <path>   Path to phoebe.config.ts (default: ./phoebe.config.ts)
  --run-once            Work one unit of the first one-shot-eligible kind, then exit
  --dry-run             Print the selected unit without executing it
  --help, -h            Show this message

Environment overlays (each replaces the corresponding config field):
  PHOEBE_REPO_SLUG, PHOEBE_REPO_URL, PHOEBE_DEFAULT_BRANCH, PHOEBE_BRANCH_PREFIX,
  PHOEBE_READY_LABEL, PHOEBE_PROCESSING_LABEL, PHOEBE_PR_OPT_OUT_LABEL,
  PHOEBE_INSTALL_COMMAND, PHOEBE_CHECK_COMMAND, PHOEBE_TEST_COMMAND,
  PHOEBE_READY_COMMAND, PHOEBE_BLOCKED_BY_PATTERN, PHOEBE_REVIEWS_SUCCESS_HEADING,
  PHOEBE_PR_SCOPE, PHOEBE_DRAFT_PRS, PHOEBE_DEFAULT_PROVIDER

Runtime toggles (read directly by the engine, not overlaid onto the config):
  PHOEBE_AGENT           Provider name to use for this run (cursor|claude|codex)
  PHOEBE_MODEL           Model to use for this run
  PHOEBE_POLL_INTERVAL_MS Persistent-mode poll interval (default 300000)
`;

const INIT_HELP_TEXT = `phoebe init — scaffold a consumer-owned runtime

Usage:
  phoebe init [dir]                 Flat single-tenant deployment (default)
  phoebe init --workspace [dir]     Workspace root (engine + workspace block)
  phoebe init --tenant [dir]        Workspace child in-tree install
                                    [--slug owner/repo] [--url <git-url>] [--with-prompts]

Profiles (mutually exclusive; default is flat):

  flat (default) writes into [dir]:
    phoebe.config.ts             Consumer config starter (five required fields + engine)
    prompts/                     Copies of the shipped agent prompts (edit to override)
    .env.example                 Documented environment variables to copy to .env
    .gitignore                   Additive — .env, repos/**/.env, node_modules/
    container/Dockerfile         Runtime image (Node 24 + git + gh, entrypoint: phoebe boot)
    container/compose.yml        Compose config for the long-lived boot container
    container/compose.local.yml  Dev overlay to run an engine checkout from your host

  --workspace writes into [dir]:
    phoebe.config.ts             engine + workspace: { depth: 1 } only (no per-repo fields)
    .env.example                 Deployment secrets (GH_TOKEN, provider keys) — no tenant secrets
    .gitignore                   Additive — .env, node_modules/
    container/                   Same #57 templates as flat, plus README.md mount docs
    (no prompts/, no child files — link children then run init --tenant)

  --tenant writes a child's in-tree install (after \`git submodule add\`):
    phoebe.config.ts             Per-tenant config (no engine; repoSlug authoritative)
    .env.example                 Per-tenant secrets template (copy to .env)
    .gitignore                   Additive — .env
    prompts/                     Only with --with-prompts
    (no container/ — deployment-level, owned by the workspace root)

    Prefills repoSlug/repoUrl from the child's \`origin\` remote; --slug/--url win.
    Absent origin → placeholder slug/url the operator fills. Re-run refuses if config exists.

Flat/workspace: existing files are left untouched. Tenant: refuses to overwrite.
`;

/** Pull `--flag value` / `--flag=value` / bare `--flag` and positionals apart. */
function parseCommandArgs(argv: readonly string[]): {
  positionals: string[];
  flags: Record<string, string | true>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    // `--url X` takes a value; `--with-prompts` / `--yes` / `--from-config` are boolean.
    if (name === "url" && next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}

/** `phoebe add-repo <owner/repo> [--url] [--with-prompts] [--from-config]`. */
function runAddRepoCli(argv: readonly string[]): void {
  const { positionals, flags } = parseCommandArgs(argv);
  const slug = positionals[0];
  if (slug === undefined) {
    throw new Error(
      "Usage: phoebe add-repo <owner/repo> [--url <git-url>] [--with-prompts] [--from-config]",
    );
  }
  const configDir = process.cwd();
  const fromConfig = flags["from-config"] === true ? readFlatRepoFields(configDir) : {};
  const withPrompts = flags["with-prompts"] === true;
  const result = addRepo({
    configDir,
    slug,
    ...(typeof flags["url"] === "string" ? { repoUrl: flags["url"] } : {}),
    ...fromConfig,
    withPrompts,
    ...(withPrompts ? { seedPrompt: (dir: string) => copyShippedPromptsInto(dir) } : {}),
  });
  process.stdout.write(
    `[phoebe] add-repo ${slug} → ${result.tenantDir}\n` +
      result.created.map((p) => `    created ${p}`).join("\n") +
      `\n\nFill in ${result.tenantDir}/.env (copy .env.example). ` +
      `The running deployment picks it up on the next poll.\n`,
  );
  // Trust-domain note on every run — fires exactly when co-tenancy matters (#61/#63).
  process.stderr.write(`\n${TRUST_DOMAIN_NOTE}\n`);
}

/** `phoebe remove-repo <owner/repo>`. */
function runRemoveRepoCli(argv: readonly string[]): void {
  const { positionals } = parseCommandArgs(argv);
  const slug = positionals[0];
  if (slug === undefined) throw new Error("Usage: phoebe remove-repo <owner/repo>");
  const { removed } = removeRepo({ configDir: process.cwd(), slug });
  process.stdout.write(
    `[phoebe] remove-repo ${slug} → deleted ${removed}\n` +
      `Its /data is retained (reversible). \`phoebe purge ${slug} --yes\` reclaims it.\n`,
  );
}

function formatHealthColumns(listing: TenantListing): string {
  const flag = (label: string, on: boolean): string => `${on ? "✓" : "✗"} ${label}`;
  const unit = listing.status?.currentUnit;
  const state = unit ? `working ${unit.kind} #${unit.id}` : listing.status ? "idle" : "no status";
  return (
    `${flag("config", listing.configValid)}  ${flag("env", listing.envPresent)}  ` +
    `${flag("data", listing.retainedData)}  ${state}`
  );
}

function formatTenantListing(listing: TenantListing): string {
  const header =
    listing.slug !== null ? `  ${listing.path}  (${listing.slug})` : `  ${listing.path}`;
  if (listing.held) {
    const held = `held — ${listing.reason ?? "held"}`;
    const detail = listing.slug !== null ? `${held}  ${formatHealthColumns(listing)}` : held;
    return `${header}\n      ${detail}`;
  }
  return `${header}\n      ${formatHealthColumns(listing)}`;
}

/** `phoebe list` — enumerate tenants + health (reads status.json). */
async function runListCli(argv: readonly string[]): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const result = await listTenants({
    configDir: process.cwd(),
    dataBase: resolveDataBase(process.env),
  });

  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify({
        declared: result.declared,
        live: result.live,
        tenants: result.listings.map((listing) => ({
          path: listing.path,
          slug: listing.slug,
          held: listing.held,
          reason: listing.reason,
          configValid: listing.configValid,
          envPresent: listing.envPresent,
          retainedData: listing.retainedData,
          status: listing.status,
        })),
      })}\n`,
    );
    if (flags["check"] === true && result.explicit && result.listings.some((l) => l.held)) {
      process.exitCode = 1;
    }
    return;
  }

  if (result.listings.length === 0) {
    process.stdout.write(
      "[phoebe] No tenants (flat single-tenant deployment, or none added yet).\n",
    );
    return;
  }

  const header = result.explicit
    ? `[phoebe] ${result.live} of ${result.declared} declared tenant(s):`
    : `[phoebe] ${result.listings.length} tenant(s):`;
  const body = result.listings.map(formatTenantListing).join("\n");
  const legend = result.listings.some((listing) => listing.held) ? `\n${LIST_HELD_LEGEND}` : "";
  process.stdout.write(`${header}\n${body}${legend}\n`);

  if (flags["check"] === true && result.explicit && result.listings.some((l) => l.held)) {
    process.exitCode = 1;
  }
}

/** `phoebe purge <owner/repo> --yes` — wipe a removed tenant's retained data. */
function runPurgeCli(argv: readonly string[]): void {
  const { positionals, flags } = parseCommandArgs(argv);
  const slug = positionals[0];
  if (slug === undefined) throw new Error("Usage: phoebe purge <owner/repo> --yes");
  const { purged } = purgeTenant({
    configDir: process.cwd(),
    dataBase: resolveDataBase(process.env),
    slug,
    confirm: flags["yes"] === true,
  });
  process.stdout.write(`[phoebe] purge ${slug} → wiped ${purged}\n`);
}

/**
 * Engine-CLI entry point. Loads the consumer's config, overlays env, installs
 * the resolved config, then runs the engine (or scaffolds via `init`). The
 * bootstrapper (bootstrap/cli.ts) delegates here so the engine keeps a single
 * load/resolve/install pipeline and stays directly runnable. The published bin
 * is a JS launcher (bootstrap/bin.mjs) that materializes the package outside
 * node_modules and execs bootstrap/cli.ts there.
 */
export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "init") {
    const parsed = parseInitArgs(args.slice(1));
    if (parsed.help) {
      process.stdout.write(INIT_HELP_TEXT);
      return;
    }
    if (parsed.profile === "tenant") {
      const result = initTenant({
        targetDir: parsed.targetDir,
        ...(parsed.repoSlug !== undefined ? { repoSlug: parsed.repoSlug } : {}),
        ...(parsed.repoUrl !== undefined ? { repoUrl: parsed.repoUrl } : {}),
        withPrompts: parsed.withPrompts,
        ...(parsed.withPrompts ? { seedPrompt: (dir: string) => copyShippedPromptsInto(dir) } : {}),
      });
      process.stdout.write(
        formatInitReport(result, parsed.targetDir) +
          `  repoSlug: ${result.repoSlug}\n` +
          `  repoUrl:  ${result.repoUrl}\n` +
          `\nFill in ${result.tenantDir}/.env (copy .env.example). ` +
          `Workspace discovery picks this child up on the next boot poll.\n`,
      );
      return;
    }
    const report = runInit({ targetDir: parsed.targetDir, profile: parsed.profile });
    process.stdout.write(formatInitReport(report, parsed.targetDir));
    return;
  }

  // Multi-tenant lifecycle commands (#63). Host-side: add-repo / remove-repo
  // scaffold the bind-mounted config tree. In-container: list / purge act on the
  // data volume. None load the engine config.
  if (args[0] === "add-repo") return runAddRepoCli(args.slice(1));
  if (args[0] === "remove-repo") return runRemoveRepoCli(args.slice(1));
  if (args[0] === "list") return await runListCli(args.slice(1));
  if (args[0] === "purge") return runPurgeCli(args.slice(1));

  const parsed = parseCliArgs(args);
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  // A direct engine run (`--run-once` / `--dry-run`) selects its tenant (#63):
  // flat has no selector; nested requires `--repo <owner/repo>`, loading only
  // that tenant's config. A boot-spawned child runs with cwd = its tenant dir
  // (flat from there), so this only fires for a manual invocation from the
  // deployment root. `phoebe boot` (the supervisor) never reaches here.
  const { slug: repoSlug, forward } = extractRepoFlag(parsed.forward);
  const configPath = resolveEngineConfigPath(parsed.configPath, repoSlug);
  const userConfig = await loadUserConfig(configPath);
  const overlaid = applyEnvOverlay(userConfig, process.env);
  setResolvedConfig(resolveConfig(overlaid, { dataBase: resolveDataBase(process.env) }));

  // Import after the config is installed — main.ts's module-level constants
  // read `config` at import time via the Proxy in resolved-config.ts.
  const { runEngine } = await import("./main.ts");
  await runEngine(forward);
}

/** Pull an optional `--repo <owner/repo>` (or `--repo=…`) out of the engine argv. */
function extractRepoFlag(argv: readonly string[]): { slug: string | undefined; forward: string[] } {
  const forward: string[] = [];
  let slug: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--repo") {
      // Only consume the next token as the slug if it is a value, not another
      // flag (mirrors the `--url` guard in parseCommandArgs). Otherwise a
      // malformed `--repo --dry-run` would swallow `--dry-run` as the slug and
      // silently execute instead of doing a dry run.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        slug = next;
        i += 1;
      }
    } else if (arg.startsWith("--repo=")) {
      slug = arg.slice("--repo=".length);
    } else {
      forward.push(arg);
    }
  }
  return { slug, forward };
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
): string {
  const cwd = process.cwd();
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

// Run the engine only when this module is invoked directly (`node …/src/cli.ts`)
// — how the engine runs standalone. The bootstrapper reaches it by importing
// `runCli` (bootstrap/cli.ts), so this guard stays dormant there; tests import
// `parseCliArgs` without triggering the pipeline for the same reason. `argv[1]`
// is realpath'd so a symlinked entry still matches `import.meta.url`, which Node
// resolves through symlinks.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[phoebe] ${message}`);
    process.exit(1);
  });
}
