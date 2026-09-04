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

import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { matchConfigFlag, matchPipelineFlag } from "./cli-flags.ts";
import {
  deprecatedPipelineAliases,
  resolveConfig,
  type PhoebeUserConfig,
} from "./config-schema.ts";
import { createWorkKindRegistry } from "./work-kinds/load-custom.ts";
import {
  copyShippedPromptsInto,
  formatInitReport,
  initTenant,
  runInit,
  type InitProfile,
} from "./init.ts";
import { formatInitTenantRegistrationAdviceForRoot } from "./init-tenant-advice.ts";
import { applyEnvOverlay, loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { parsePipelineName, selectPipeline } from "./pipeline.ts";
import { runEngine } from "./main.ts";
import { resolveDataBase } from "./paths.ts";
import { setResolvedConfig } from "./resolved-config.ts";
import { formatAge, oldestUnitAgeMs, type PipelineListing } from "./pipeline-listing.ts";
import {
  LIST_HELD_LEGEND,
  LIST_STALE_LEGEND,
  LIST_UNDECLARED_LEGEND,
  listTenants,
  purgeTenant,
  TRUST_DOMAIN_NOTE,
  type ListTenantsResult,
  type TenantListing,
} from "./tenant-commands.ts";

type ParsedArgs = { configPath: string | undefined; help: boolean; forward: string[] };

/** The boolean flags `runEngine` reads out of the forwarded array. */
const ENGINE_FLAGS = new Set(["--run-once", "--dry-run"]);

/**
 * Extract `--config <path>` / `--config=<path>` / `-c <path>` and `--help`/`-h`
 * from argv, forwarding the engine's own boolean flags (`--run-once`,
 * `--dry-run`) on to `runEngine`.
 *
 * An unrecognised flag is rejected rather than forwarded, matching
 * {@link parseInitArgs}: the engine reads its flags with `argv.includes(...)`, so
 * anything it does not know is silently dropped — a typo like `--dry-runn`, or a
 * flag that used to exist, would otherwise run the *opposite* of what was asked
 * with no diagnostic. `--repo <owner/repo>` is the reason this matters now: it
 * selected a nested tenant's config until 0.4.0, and must fail loudly rather
 * than survive as a no-op alias (#169).
 */
/**
 * This package's own version, for self-diagnosing error messages. Best-effort:
 * unreadable/odd packaging yields null rather than masking the error being
 * reported.
 */
function installedVersion(): string | null {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

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
    const config = matchConfigFlag(argv, i);
    if (config !== undefined) {
      configPath = config.value;
      i += config.consumed - 1;
      continue;
    }
    // `--pipeline <name>` selects which pipeline of this tenant's work to run (#415).
    // Forwarded rather than consumed: `runEngine` reads the same flag back for
    // the pipeline's poll cadence and its log line.
    const pipeline = matchPipelineFlag(argv, i);
    if (pipeline !== undefined) {
      forward.push(...argv.slice(i, i + pipeline.consumed));
      i += pipeline.consumed - 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("-") && !ENGINE_FLAGS.has(arg)) {
      throw new Error(`Unknown flag \`${arg}\` for \`phoebe\`. See \`phoebe --help\`.`);
    }
    if (arg === "boot") {
      // `boot` is real but lives a layer up: bootstrap/cli.ts dispatches it to
      // `runBoot` before delegating here, so through the packaged bin this
      // branch is unreachable. It exists for a *direct* engine invocation
      // (`node src/cli.ts boot`), where the generic unknown-command error
      // below would absurdly list `boot` among the known commands.
      throw new Error(
        "`boot` is a bootstrapper command — run it via the packaged `phoebe` bin, which " +
          "supervises the engine as a child. The engine CLI cannot boot itself.",
      );
    }
    if (arg !== undefined && !arg.startsWith("-")) {
      // A bare word is an intended subcommand, never an engine flag — every
      // dispatchable verb was consumed before this parser ran. Forwarding it
      // used to fall through to the engine-run path, so a verb this version
      // does not know (or a typo) died deep in config validation with an error
      // about tenant fields instead of naming the actual problem.
      const version = installedVersion();
      throw new Error(
        `Unknown command \`${arg}\` for \`phoebe\`${version === null ? "" : ` (phoebe-agent v${version})`}. ` +
          `Known commands: boot, init, list, purge, upgrade, doctor, migrate, stop, start, pipelines, sweep-state. If \`${arg}\` was added in a newer ` +
          `release, upgrade first: \`pnpm dlx phoebe-agent@latest upgrade\`. See \`phoebe --help\`.`,
      );
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
   * Scaffold profile. Default `solo` (the single-tenant layout).
   * `--solo`, `--workspace`, and `--tenant` are mutually exclusive (#93/#94).
   */
  profile: InitProfile;
  /** Tenant profile: explicit slug override (wins over origin prefill). */
  repoSlug?: string;
  /** Tenant profile: explicit url override (wins over origin prefill). */
  repoUrl?: string;
  /** Tenant profile: opt-in seed of shipped prompts. */
  withPrompts: boolean;
  /** Tenant profile: deployment root for workspace registration advice (default cwd). */
  rootDir?: string;
};

/**
 * Parse argv left after the leading `init` token has been consumed. Supports
 * an optional positional target directory (`phoebe init ./my-agent`), the
 * mutually exclusive profile flags `--solo` / `--workspace` / `--tenant`,
 * tenant-only overrides (`--slug`, `--url`, `--with-prompts`, `--root`), and
 * `--help`. Extra flags are rejected loudly so a typo like `--forcee` fails fast
 * instead of being silently ignored.
 *
 * `--solo` names the default rather than changing it: bare `phoebe init` and
 * `phoebe init --solo` scaffold the same tree. It exists so neither supported
 * layout is nameless on the CLI (#169).
 */
export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  let targetDir: string | undefined;
  let help = false;
  let profile: InitProfile = "solo";
  let profileFlag: string | undefined;
  let repoSlug: string | undefined;
  let repoUrl: string | undefined;
  let withPrompts = false;
  let rootDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--solo" || arg === "--workspace" || arg === "--tenant") {
      if (profileFlag !== undefined) {
        throw new Error(
          `\`phoebe init\` flags \`--solo\`, \`--workspace\`, and \`--tenant\` are mutually ` +
            `exclusive (got both \`${profileFlag}\` and \`${arg}\`).`,
        );
      }
      profileFlag = arg;
      profile = arg === "--solo" ? "solo" : arg === "--workspace" ? "workspace" : "tenant";
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
    if (arg === "--root" || arg.startsWith("--root=")) {
      const value = arg === "--root" ? argv[++i] : arg.slice("--root=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new Error("`--root` requires a directory path.");
      }
      rootDir = value;
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

  if (
    (repoSlug !== undefined || repoUrl !== undefined || withPrompts || rootDir !== undefined) &&
    profile !== "tenant"
  ) {
    throw new Error(
      `\`--slug\`, \`--url\`, \`--with-prompts\`, and \`--root\` are only valid with \`phoebe init --tenant\`.`,
    );
  }

  return {
    targetDir: targetDir ?? ".",
    help,
    profile,
    ...(repoSlug !== undefined ? { repoSlug } : {}),
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    withPrompts,
    ...(rootDir !== undefined ? { rootDir } : {}),
  };
}

const HELP_TEXT = `phoebe — AFK coding agent

Usage:
  phoebe init [--solo] [dir]       Scaffold a solo single-tenant deployment
  phoebe init --workspace [dir]    Scaffold a workspace root (multi-child)
  phoebe init --tenant [dir]       Scaffold a workspace child in-tree install
  phoebe list [--json] [--check]   List tenants + health (in-container)
  phoebe purge <owner/repo> --yes  Wipe a removed tenant's data (in-container)
  phoebe upgrade [ref] [--engine|--cli|--both]
                                   Advance the pinned engine ref and/or the npm CLI
  phoebe upgrade --check [--json]  Report current vs latest; exit 1 when behind
  phoebe doctor [--json]           Deployment + tenant health checks (report-only)
  phoebe migrate [--config <path>] Apply deployment migrations (idempotent)
  phoebe pipelines [--config <path>]
                                   Print this tenant's pipelines as JSON (for the supervisor)
  phoebe sweep-state [--config <path>]
                                   Delete tenant state no pipeline owns
  phoebe stop [--now]              Drain and stop the deployment container (host-side)
  phoebe start [--build]           Bring the deployment container up detached (host-side)
  phoebe [--config <path>] [flags] Run the engine

Options (engine mode):
  --config, -c <path>   Path to phoebe.config.ts (default: ./phoebe.config.ts)
  --run-once            Work one unit of the first one-shot-eligible kind, then exit
  --dry-run             Print the selected unit without executing it
  --pipeline <name>     Which pipeline to run (default: work)
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
  PHOEBE_EFFORT          Reasoning effort for this run (claude: low|medium|high|xhigh|max)
  PHOEBE_<KIND>_AGENT    Per-work-kind variants of the trio above, where <KIND> is
  PHOEBE_<KIND>_MODEL    one of CONFLICTS|CHECKS|REVIEWS|ISSUES|RESEARCH
  PHOEBE_<KIND>_EFFORT   (e.g. PHOEBE_REVIEWS_MODEL); outrank the workKinds config block
  PHOEBE_POLL_INTERVAL_MS Persistent-mode poll interval (default 300000)
`;

const INIT_HELP_TEXT = `phoebe init — scaffold a consumer-owned runtime

Usage:
  phoebe init [--solo] [dir]        Solo single-tenant deployment (default)
  phoebe init --workspace [dir]     Workspace root (engine + workspace block)
  phoebe init --tenant [dir]        Workspace child in-tree install
                                    [--slug owner/repo] [--url <git-url>]
                                    [--root <workspace-root>] [--with-prompts]

Profiles (mutually exclusive; default is solo):

  --solo (default) writes into [dir]:
    phoebe.config.ts             Consumer config starter (five required fields + engine)
    prompts/                     Copies of the shipped agent prompts (edit to override)
    .env.example                 Documented environment variables to copy to .env
    .gitignore                   Additive — .env, node_modules/
    container/Dockerfile         Runtime image (Node 24 + git + gh, entrypoint: phoebe boot)
    container/compose.yml        Compose config for the long-lived boot container
    container/compose.local.yml  Dev overlay to run an engine checkout from your host

  --workspace writes into [dir]:
    phoebe.config.ts             engine + workspace: { depth: 1 } only (no per-repo fields)
    .env.example                 Deployment secrets (GH_TOKEN, provider keys) — no tenant secrets
    .gitignore                   Additive — .env, node_modules/
    container/                   Same #57 templates as solo, plus README.md mount docs
    (no prompts/, no child files — link children then run init --tenant)

  --tenant writes a child's in-tree install (after \`git submodule add\`):
    phoebe.config.ts             Per-tenant config (no engine; repoSlug authoritative)
    .env.example                 Per-tenant secrets template (copy to .env)
    .gitignore                   Additive — .env
    prompts/                     Only with --with-prompts
    (no container/ — deployment-level, owned by the workspace root)

    Prefills repoSlug/repoUrl from the child's \`origin\` remote; --slug/--url win.
    Absent origin → placeholder slug/url the operator fills. Re-run refuses if config exists.

Solo/workspace: existing files are left untouched. Tenant: refuses to overwrite.
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

/**
 * The tenant's own columns. The engine-state column that used to sit here moved
 * to the pipeline lines below (#427): a tenant is several pipelines now, and one
 * state word for all of them could only ever be one pipeline's.
 */
function formatHealthColumns(listing: TenantListing): string {
  const flag = (label: string, on: boolean): string => `${on ? "✓" : "✗"} ${label}`;
  return (
    `${flag("config", listing.configValid)}  ${flag("env", listing.envPresent)}  ` +
    `${flag("data", listing.retainedData)}  arm: ${listing.arm}`
  );
}

/** Where the line came from, or that the pipeline is switched off. */
function formatPipelineMark(pipeline: PipelineListing): string {
  if (pipeline.source === "stale") return "  (stale)";
  if (pipeline.source === "disk") return "  (from disk)";
  return pipeline.disabled ? "  (disabled)" : "";
}

/**
 * One pipeline's state column. `working` carries `k/N` — what is in flight
 * against what the pipeline declared — and the refs themselves, so an operator can
 * go find the unit. `wedged?` rides along rather than replacing it: the pipeline is
 * still working as far as anything on disk knows, and the age is the reason to
 * doubt it.
 */
function formatPipelineState(pipeline: PipelineListing, now: number): string {
  if (pipeline.state !== "working") return pipeline.state;
  const refs = pipeline.units.map((current) => `${current.unit.kind} ${current.unit.id}`);
  const capacity =
    pipeline.concurrency !== null
      ? `${pipeline.units.length}/${pipeline.concurrency}`
      : String(pipeline.units.length);
  const age = oldestUnitAgeMs(pipeline.units, now);
  const wedged = pipeline.wedged && age !== null ? `  wedged? ${formatAge(age)}` : "";
  return `working ${capacity} ${refs.join(", ")}${wedged}`;
}

/** One indented line per pipeline, names padded into a column. */
function formatPipelineLines(listing: TenantListing, now: number): string[] {
  const width = Math.max(0, ...listing.pipelines.map((pipeline) => pipeline.name.length));
  return listing.pipelines.map(
    (pipeline) =>
      `        ${pipeline.name.padEnd(width)}  ${formatPipelineState(pipeline, now)}` +
      formatPipelineMark(pipeline),
  );
}

function formatTenantListing(listing: TenantListing, now: number): string {
  const slugSuffix = listing.slug !== null ? `  (${listing.slug})` : "";
  const disabledSuffix = listing.disabled ? "  (disabled)" : "";
  const header = `  ${listing.path}${slugSuffix}${disabledSuffix}`;
  const held = `held — ${listing.reason ?? "held"}`;
  const detail = !listing.held
    ? formatHealthColumns(listing)
    : listing.slug !== null
      ? `${held}  ${formatHealthColumns(listing)}`
      : held;
  return [`${header}\n      ${detail}`, ...formatPipelineLines(listing, now)].join("\n");
}

/**
 * The machine-readable report. Each tenant carries its pipeline lines; the
 * tenant-level `status` field is gone with the column it fed (#427) — a reader
 * that wants one pipeline's snapshot names the pipeline.
 */
export function formatListJson(result: ListTenantsResult): string {
  return JSON.stringify({
    declared: result.declared,
    live: result.live,
    solo: result.solo,
    tenants: result.listings.map((listing) => ({
      path: listing.path,
      slug: listing.slug,
      held: listing.held,
      reason: listing.reason,
      arm: listing.arm,
      configValid: listing.configValid,
      envPresent: listing.envPresent,
      retainedData: listing.retainedData,
      disabled: listing.disabled,
      pipelines: listing.pipelines.map((pipeline) => ({
        name: pipeline.name,
        disabled: pipeline.disabled,
        source: pipeline.source,
        state: pipeline.state,
        units: pipeline.units,
        updatedAt: pipeline.updatedAt,
        wedged: pipeline.wedged,
      })),
    })),
    undeclared: result.undeclared,
  });
}

/** The human report: tenant pipelines, their pipeline lines, and the legends. */
export function formatListReport(result: ListTenantsResult, now: number): string {
  if (result.listings.length === 0 && result.undeclared.length === 0) {
    return "[phoebe] No tenants (nothing declared here — no workspace children, no root config).";
  }
  const header = result.solo
    ? "[phoebe] 1 tenant (solo):"
    : result.explicit && result.declared > 0
      ? `[phoebe] ${result.live} of ${result.declared} declared tenant(s):`
      : result.listings.length > 0
        ? `[phoebe] ${result.listings.length} tenant(s):`
        : "[phoebe] 0 declared tenant(s):";
  const body = result.listings.map((listing) => formatTenantListing(listing, now)).join("\n");
  const undeclaredSection =
    result.undeclared.length > 0
      ? `\n\nundeclared:\n${result.undeclared.map((path) => `  ${path}`).join("\n")}`
      : "";
  const legendParts: string[] = [];
  if (result.listings.some((listing) => listing.held)) legendParts.push(LIST_HELD_LEGEND);
  if (result.listings.some((listing) => listing.pipelines.some((p) => p.source === "stale"))) {
    legendParts.push(LIST_STALE_LEGEND);
  }
  if (result.undeclared.length > 0) legendParts.push(LIST_UNDECLARED_LEGEND);
  const legend = legendParts.length > 0 ? `\n${legendParts.join("\n")}` : "";
  const main = body.length > 0 ? `${header}\n${body}` : header;
  return `${main}${undeclaredSection}${legend}`;
}

/**
 * `phoebe list` — every tenant, its health columns, and one line per pipeline.
 *
 * `--check` stays structural: it exits 1 when the fleet declaration is not
 * honoured, and nothing a pipeline line says moves it. A wedged pipeline is a
 * question for an operator, not a failed assertion about the declaration.
 */
async function runListCli(argv: readonly string[]): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const result = await listTenants({
    configDir: process.cwd(),
    dataBase: resolveDataBase(process.env),
  });

  process.stdout.write(
    flags["json"] === true
      ? `${formatListJson(result)}\n`
      : `${formatListReport(result, Date.now())}\n`,
  );

  if (flags["check"] === true && result.explicit && result.listings.some((l) => l.held)) {
    process.exitCode = 1;
  }
}

/** `phoebe purge <owner/repo> --yes` — wipe a removed tenant's retained data. */
async function runPurgeCli(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseCommandArgs(argv);
  const slug = positionals[0];
  if (slug === undefined) throw new Error("Usage: phoebe purge <owner/repo> --yes");
  const { purged } = await purgeTenant({
    configDir: process.cwd(),
    dataBase: resolveDataBase(process.env),
    slug,
    confirm: flags["yes"] === true,
  });
  process.stdout.write(`[phoebe] purge ${slug} → wiped ${purged}\n`);
}

/**
 * One deprecation notice per load, naming every superseded top-level field this
 * config still uses (#415). Emitted here rather than inside `resolveConfig`
 * because the resolver runs per tenant inside the supervisor's reconcile loop
 * too, and a warning that repeats every few seconds trains operators to ignore
 * warnings.
 */
export function warnDeprecatedPipelineAliases(user: PhoebeUserConfig): void {
  const aliases = deprecatedPipelineAliases(user);
  if (aliases.length === 0) return;
  console.warn(
    `[phoebe] phoebe.config.ts uses deprecated field(s): ${aliases.join(", ")}. ` +
      `They now resolve as \`pipelines.work.*\` and keep working; \`phoebe migrate\` will ` +
      `move them. See docs/configuration.md → Pipelines.`,
  );
}

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
      const rootDir = parsed.rootDir ?? process.cwd();
      const registrationAdvice = await formatInitTenantRegistrationAdviceForRoot({
        rootDir,
        tenantDir: result.tenantDir,
      });
      process.stdout.write(
        formatInitReport(result, parsed.targetDir) +
          `  repoSlug: ${result.repoSlug}\n` +
          `  repoUrl:  ${result.repoUrl}\n` +
          `\nFill in ${result.tenantDir}/.env (copy .env.example).\n` +
          registrationAdvice,
      );
      // Trust-domain note on every run — fires exactly when co-tenancy matters
      // (#61): a second tenant is being added to one container.
      process.stderr.write(`\n${TRUST_DOMAIN_NOTE}\n`);
      return;
    }
    const report = runInit({ targetDir: parsed.targetDir, profile: parsed.profile });
    process.stdout.write(formatInitReport(report, parsed.targetDir));
    return;
  }

  // In-container fleet commands (#95): list / purge act on the data volume.
  // Neither loads the engine config.
  if (args[0] === "list") return await runListCli(args.slice(1));
  if (args[0] === "purge") return await runPurgeCli(args.slice(1));

  // Operator commands: upgrade moves the deployment between versions; doctor
  // reports whether the version it is on works; stop / start drive the Compose
  // container from the host (#186 / #187). Lazy imports keep the plain
  // engine-run path from loading their bootstrap / Docker dependencies.
  if (args[0] === "upgrade") {
    const { runUpgradeCli } = await import("./upgrade.ts");
    return await runUpgradeCli(args.slice(1));
  }
  if (args[0] === "doctor") {
    const { runDoctorCli } = await import("./doctor.ts");
    return await runDoctorCli(args.slice(1));
  }
  // The supervisor's one question about a tenant's config (#417): which pipelines it
  // declares, and their fingerprints. Lazy like its neighbours — the
  // engine-run path never loads it.
  if (args[0] === "pipelines") {
    const { runPipelinesCli } = await import("./pipeline-enumerate.ts");
    return await runPipelinesCli(args.slice(1));
  }
  // Reclaiming disk no pipeline owns (#426): the supervisor's pre-spawn and
  // post-drain sweep, and an operator's hand run. Lazy for the same reason as
  // its neighbours.
  if (args[0] === "sweep-state") {
    const { runSweepStateCli } = await import("./stale-state.ts");
    return await runSweepStateCli(args.slice(1));
  }
  if (args[0] === "migrate") {
    const { runMigrateCli } = await import("./migrate.ts");
    return await runMigrateCli(args.slice(1));
  }
  if (args[0] === "stop") {
    const { runStopCli } = await import("./stop.ts");
    return await runStopCli(args.slice(1));
  }
  if (args[0] === "start") {
    const { runStartCli } = await import("./start.ts");
    return await runStartCli(args.slice(1));
  }

  const parsed = parseCliArgs(args);
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  // A direct engine run (`--run-once` / `--dry-run`) has no tenant selector:
  // it loads the config under cwd (or `--config`). A boot-spawned child runs
  // with cwd = its tenant dir, so a workspace child is reached by running from
  // that child's directory. `phoebe boot` (the supervisor) never gets here.
  const configPath = resolveConfigPath(parsed.configPath, process.cwd());
  const userConfig = await loadUserConfig(configPath);
  assertNotWorkspaceRoot(userConfig, configPath);
  const overlaid = applyEnvOverlay(userConfig, process.env);
  const tenant = resolveConfig(overlaid, { dataBase: resolveDataBase(process.env) });
  warnDeprecatedPipelineAliases(overlaid);
  // Flatten the selected pipeline onto the tenant config (#415): `workOrder`,
  // `workKinds` and `promptFiles` now describe this pipeline, so the registry
  // loader, the orchestrator and the prompt check all keep reading the fields
  // they always read. An unknown `--pipeline` throws here, before any GitHub
  // call. Absent the flag, the pipeline is `work`.
  const resolved = selectPipeline(tenant, parsePipelineName(parsed.forward));
  // The engine takes the config as an argument (#280); the holder is still
  // installed because `orchestrator.ts` — which the engine and the `gh` client
  // both call into — still reads its fields through the Proxy.
  setResolvedConfig(resolved);
  // Assemble the work-kind registry (#303): built-ins plus this tenant's
  // custom kinds, whose module paths resolve against the config's directory.
  // Installed after the config holder — kind modules may not import it, but
  // built-in factories read pure orchestrator helpers that do.
  const registry = await createWorkKindRegistry(resolved, dirname(configPath));
  await runEngine(resolved, parsed.forward, registry);
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
