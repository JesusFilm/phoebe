// `phoebe migrate` — apply structured, idempotent, per-directory migrations.
//
// The spine:
//   Migration interface  — detect (is this applicable?), describe, apply.
//   Staged writes        — apply returns a map; the runner flushes it after the
//                          call returns, so a throw in apply leaves nothing on
//                          disk. Per-migration atomicity.
//   Pre-image journal    — flush point captures { dir, migrationId, relPath,
//                          before } (before=null for new files). Held in memory.
//   Post-apply validation— runs after each flush; on failure, reverts all writes
//                          from that migration in-place on the same inode.
//   Report               — applied / not-applicable / failed / manual, with
//                          not-applicable collapsed to a trailing count.
//   Engine SHA           — from git HEAD on this checkout, not engine.ref.
//   Uncommitted listing  — only paths from the journal (pre-existing dirt excluded).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateUserConfig } from "./config-schema.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import { loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { MIGRATIONS } from "./migrations/index.ts";
import {
  enumerateWorkspaceTenants,
  type TenantDiscoverySeams,
  type WorkspaceEnumeration,
} from "./tenant-commands.ts";

// ----------------------------------------------------------------- types

export type MigrationRole = "solo-root" | "workspace-root" | "tenant";

/**
 * Per-directory migration unit. Migrations live one per file in
 * `src/migrations/`, registered hand-ordered in `src/migrations/index.ts`.
 *
 * Context is text and AST only — `readFile` returns raw strings, never a
 * validated config object. The config being migrated may not yet satisfy the
 * target schema; that is the point of the facility.
 */
export type Migration = {
  id: string;
  title: string;
  appliesTo: readonly MigrationRole[];
  /**
   * Return non-null data when this migration should run; null = not-applicable.
   * The value is passed verbatim to `describe` and `apply`.
   */
  detect: (dir: string, readFile: (relPath: string) => string | null) => unknown;
  /** One-line description of what this migration did (used in the report). */
  describe: (data: unknown) => string;
  /**
   * Return staged writes: relPath → content. The runner flushes them after
   * this returns; any throw here leaves no file written. Artifact migrations
   * never overwrite existing files (detect should have returned null in that
   * case, so this is a design invariant, not a runtime guard).
   */
  apply: (
    dir: string,
    data: unknown,
    readFile: (relPath: string) => string | null,
  ) => Record<string, string>;
};

export type MigrationState = "applied" | "not-applicable" | "failed" | "manual";

export type MigrationResult = {
  id: string;
  state: MigrationState;
  detail: string;
};

export type JournalEntry = {
  dir: string;
  migrationId: string;
  relPath: string;
  /** Content before the migration; null when the file did not exist. */
  before: string | null;
};

export type MigrateReport = {
  sha: string | null;
  dir: string;
  results: MigrationResult[];
  /**
   * Files written by applied + validated migrations only. Used for the
   * uncommitted listing; pre-existing dirt is never included.
   */
  journal: JournalEntry[];
  ok: boolean;
};

export type TenantVerdict =
  | "migrated"
  | "up-to-date"
  | "manual"
  | "failed"
  | "reverted"
  | "skipped"
  | "invalid";

export type TenantMigrateEntry = {
  dir: string;
  slug: string | null;
  verdict: TenantVerdict;
  /** Populated when verdict is "skipped". */
  reason?: string;
  /** The full migration report; absent when verdict is "skipped". */
  report?: MigrateReport;
};

export type FleetMigrateReport = {
  rootReport: MigrateReport;
  rootRole: "workspace-root" | "solo-root";
  tenantEntries: TenantMigrateEntry[];
};

export type RunFleetMigrateOptions = {
  configPath: string;
  git?: GitRunner;
  migrations?: readonly Migration[];
  validateFn?: (configPath: string, counter: number) => Promise<void>;
  /** TenantDiscoverySeams overrides for workspace enumeration. */
  discovery?: TenantDiscoverySeams;
  /** Override workspace enumeration entirely (test seam). */
  enumerateFn?: (
    opts: TenantDiscoverySeams & { configDir: string },
  ) => Promise<WorkspaceEnumeration | null>;
  /** Override dirty-tree detection (test seam). */
  isDirtyFn?: (dir: string) => boolean | Promise<boolean>;
};

// ----------------------------------------------------------------- helpers

/** The engine directory: one level up from `src/`. */
function engineDir(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

/** Read the engine checkout's HEAD SHA. Null for non-repo or local mount. */
export function readEngineSha(git: GitRunner = defaultGit): string | null {
  try {
    return git(["-C", engineDir(), "rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

function makeReadFile(dir: string): (relPath: string) => string | null {
  return (relPath) => {
    try {
      return readFileSync(join(dir, relPath), "utf8");
    } catch {
      return null;
    }
  };
}

/** Write `content` to `abs` in-place (same inode, no rename-over). */
function writeInPlace(abs: string, content: string): void {
  writeFileSync(abs, content);
}

// ----------------------------------------------------------------- runner

export type RunMigrateOptions = {
  dir: string;
  role: MigrationRole;
  configPath: string;
  git?: GitRunner;
  /** Override the migration registry (test seam). */
  migrations?: readonly Migration[];
  /** Override post-apply validation (test seam). */
  validateFn?: (configPath: string, counter: number) => Promise<void>;
};

export async function runMigrate(opts: RunMigrateOptions): Promise<MigrateReport> {
  const git = opts.git ?? defaultGit;
  const migrations = opts.migrations ?? MIGRATIONS;
  const sha = readEngineSha(git);
  const journal: JournalEntry[] = [];
  const results: MigrationResult[] = [];
  const readFile = makeReadFile(opts.dir);
  let counter = 0;

  const validate =
    opts.validateFn ??
    (async (configPath: string, n: number) => {
      const userConfig = await loadUserConfig(configPath, {
        reloadKey: `migrate-validate-${String(n)}`,
      });
      validateUserConfig(userConfig);
    });

  for (const migration of migrations) {
    if (!(migration.appliesTo as readonly string[]).includes(opts.role)) {
      continue;
    }

    // detect
    let data: unknown;
    try {
      data = migration.detect(opts.dir, readFile);
    } catch (err) {
      results.push({
        id: migration.id,
        state: "failed",
        detail: `detect threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (data === null) {
      results.push({ id: migration.id, state: "not-applicable", detail: "" });
      continue;
    }

    // stage writes (may throw — nothing flushed yet)
    let staged: Record<string, string>;
    try {
      staged = migration.apply(opts.dir, data, readFile);
    } catch (err) {
      results.push({
        id: migration.id,
        state: "failed",
        detail: `apply threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // flush: capture pre-images, then write all
    const entries: JournalEntry[] = [];
    for (const [relPath, content] of Object.entries(staged)) {
      const abs = join(opts.dir, relPath);
      const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      mkdirSync(dirname(abs), { recursive: true });
      writeInPlace(abs, content);
      entries.push({ dir: opts.dir, migrationId: migration.id, relPath, before });
    }

    // post-apply validation — only a validation failure triggers revert
    counter += 1;
    try {
      await validate(opts.configPath, counter);
    } catch (err) {
      // Revert all writes from this migration in-place
      for (const entry of entries) {
        const abs = join(entry.dir, entry.relPath);
        if (entry.before === null) {
          try {
            unlinkSync(abs);
          } catch {
            // best-effort
          }
        } else {
          writeInPlace(abs, entry.before);
        }
      }
      results.push({
        id: migration.id,
        state: "failed",
        detail: `validation failed (reverted): ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    journal.push(...entries);
    results.push({
      id: migration.id,
      state: "applied",
      detail: migration.describe(data),
    });
  }

  const ok = results.every((r) => r.state !== "failed");
  return { sha, dir: opts.dir, results, journal, ok };
}

// ----------------------------------------------------------------- fleet walk

function isTreeDirty(dir: string, git: GitRunner): boolean {
  try {
    return git(["status", "--porcelain"], { cwd: dir }).trim().length > 0;
  } catch {
    return false;
  }
}

function makeDefaultValidate(
  validateFn?: (configPath: string, counter: number) => Promise<void>,
): (configPath: string, counter: number) => Promise<void> {
  return (
    validateFn ??
    (async (configPath: string, n: number) => {
      const userConfig = await loadUserConfig(configPath, {
        reloadKey: `migrate-validate-${String(n)}`,
      });
      validateUserConfig(userConfig);
    })
  );
}

function computeTenantVerdict(report: MigrateReport, preexistingInvalid: boolean): TenantVerdict {
  if (report.results.some((r) => r.state === "manual")) return "manual";
  if (
    report.results.some(
      (r) => r.state === "failed" && r.detail.startsWith("validation failed (reverted)"),
    )
  ) {
    return "reverted";
  }
  if (report.results.some((r) => r.state === "failed")) return "failed";
  if (report.results.some((r) => r.state === "applied")) return "migrated";
  if (preexistingInvalid) return "invalid";
  return "up-to-date";
}

export async function runFleetMigrate(opts: RunFleetMigrateOptions): Promise<FleetMigrateReport> {
  const git = opts.git ?? defaultGit;
  const configPath = opts.configPath;
  const dir = dirname(configPath);
  const validate = makeDefaultValidate(opts.validateFn);
  const isDirty = opts.isDirtyFn ?? ((d: string) => isTreeDirty(d, git));

  const userConfig = await loadUserConfig(configPath);
  const rootRole: "workspace-root" | "solo-root" =
    userConfig.workspace !== undefined ? "workspace-root" : "solo-root";

  // Migrate root first — no dirty-tree gate for root
  const rootReport = await runMigrate({
    dir,
    role: rootRole,
    configPath,
    git,
    migrations: opts.migrations,
    validateFn: opts.validateFn,
  });

  if (rootRole === "solo-root") {
    return { rootReport, rootRole, tenantEntries: [] };
  }

  const enumerate = opts.enumerateFn ?? enumerateWorkspaceTenants;
  const enumeration = await enumerate({ configDir: dir, ...opts.discovery });
  const tenantEntries: TenantMigrateEntry[] = [];

  if (enumeration !== null) {
    for (const hold of enumeration.holds) {
      tenantEntries.push({
        dir: hold.dir,
        slug: hold.slug,
        verdict: "skipped",
        reason: hold.reason,
      });
    }

    for (const tenant of enumeration.tenants) {
      if (await isDirty(tenant.dir)) {
        tenantEntries.push({
          dir: tenant.dir,
          slug: tenant.slug,
          verdict: "skipped",
          reason: "uncommitted changes — commit or stash, then re-run",
        });
        continue;
      }

      const report = await runMigrate({
        dir: tenant.dir,
        role: "tenant",
        configPath: tenant.configPath,
        git,
        migrations: opts.migrations,
        validateFn: opts.validateFn,
      });

      // When no migrations applied, check whether the config was already broken
      let preexistingInvalid = false;
      const nothingApplied = report.results.every((r) => r.state === "not-applicable");
      if (nothingApplied) {
        try {
          await validate(tenant.configPath, 0);
        } catch {
          preexistingInvalid = true;
        }
      }

      tenantEntries.push({
        dir: tenant.dir,
        slug: tenant.slug,
        verdict: computeTenantVerdict(report, preexistingInvalid),
        report,
      });
    }
  }

  return { rootReport, rootRole, tenantEntries };
}

// ----------------------------------------------------------------- formatter

const STATE_MARK: Record<Exclude<MigrationState, "not-applicable">, string> = {
  applied: "✓",
  failed: "✗",
  manual: "!",
};

export function formatMigrateReport(report: MigrateReport): string {
  const shaLabel = report.sha !== null ? report.sha.slice(0, 12) : "(non-repo checkout)";
  const lines: string[] = [`[phoebe] migrate — ${shaLabel}`];

  let applied = 0;
  let failed = 0;
  let manual = 0;
  let notApplicable = 0;

  for (const result of report.results) {
    if (result.state === "not-applicable") {
      notApplicable++;
      continue;
    }
    if (result.state === "applied") applied++;
    else if (result.state === "failed") failed++;
    else if (result.state === "manual") manual++;
    lines.push(`  ${STATE_MARK[result.state]} ${result.id.padEnd(28)} ${result.detail}`);
  }

  // Summary line collapsing not-applicable
  const parts: string[] = [];
  if (applied > 0) parts.push(`${String(applied)} applied`);
  if (failed > 0) parts.push(`${String(failed)} failed`);
  if (manual > 0) parts.push(`${String(manual)} manual`);
  if (notApplicable > 0) parts.push(`${String(notApplicable)} not applicable`);
  if (parts.length > 0) lines.push(parts.join(", "));

  // Uncommitted listing — only paths from the journal (pre-existing dirt excluded)
  if (report.journal.length > 0) {
    const paths = report.journal.map((e) => e.relPath);
    lines.push("");
    lines.push("uncommitted paths Phoebe wrote:");
    for (const p of paths) {
      lines.push(`  ${p}`);
    }
    lines.push(`review: git -C ${report.dir} diff -- ${paths.join(" ")}`);
    lines.push("Phoebe never commits in operator repos — review before committing.");
  }

  return lines.join("\n");
}

const VERDICT_MARK: Record<TenantVerdict, string> = {
  migrated: "✓",
  "up-to-date": "✓",
  manual: "!",
  failed: "✗",
  reverted: "✗",
  skipped: "—",
  invalid: "⚠",
};

export function formatFleetMigrateReport(report: FleetMigrateReport): string {
  const sha = report.rootReport.sha;
  const shaLabel = sha !== null ? sha.slice(0, 12) : "(non-repo checkout)";
  const lines: string[] = [`[phoebe] migrate — ${shaLabel}`];

  // Root section
  lines.push("");
  lines.push(`root (${report.rootReport.dir}):`);
  let applied = 0,
    failed = 0,
    manual = 0,
    notApplicable = 0;
  for (const result of report.rootReport.results) {
    if (result.state === "not-applicable") {
      notApplicable++;
      continue;
    }
    if (result.state === "applied") applied++;
    else if (result.state === "failed") failed++;
    else if (result.state === "manual") manual++;
    lines.push(`  ${STATE_MARK[result.state]} ${result.id.padEnd(28)} ${result.detail}`);
  }
  const rootParts: string[] = [];
  if (applied > 0) rootParts.push(`${String(applied)} applied`);
  if (failed > 0) rootParts.push(`${String(failed)} failed`);
  if (manual > 0) rootParts.push(`${String(manual)} manual`);
  if (notApplicable > 0) rootParts.push(`${String(notApplicable)} not applicable`);
  if (rootParts.length > 0) lines.push(`  ${rootParts.join(", ")}`);

  // Tenant section
  if (report.tenantEntries.length > 0) {
    lines.push("");
    lines.push("tenants:");
    for (const entry of report.tenantEntries) {
      const label = entry.slug ?? entry.dir;
      const mark = VERDICT_MARK[entry.verdict];
      if (entry.verdict === "skipped") {
        lines.push(`  ${mark} skipped      ${label} — ${entry.reason ?? ""}`);
      } else {
        lines.push(`  ${mark} ${entry.verdict.padEnd(12)} ${label} (${entry.dir})`);
        if (entry.report) {
          for (const result of entry.report.results) {
            if (result.state === "not-applicable") continue;
            lines.push(
              `      ${STATE_MARK[result.state]} ${result.id.padEnd(28)} ${result.detail}`,
            );
          }
        }
      }
    }
  }

  // Uncommitted listing — grouped by repository directory
  const allEntries: JournalEntry[] = [
    ...report.rootReport.journal,
    ...report.tenantEntries.flatMap((e) => e.report?.journal ?? []),
  ];

  if (allEntries.length > 0) {
    const byDir = new Map<string, JournalEntry[]>();
    for (const entry of allEntries) {
      const group = byDir.get(entry.dir) ?? [];
      group.push(entry);
      byDir.set(entry.dir, group);
    }

    lines.push("");
    lines.push("uncommitted paths Phoebe wrote:");
    for (const [entryDir, entries] of byDir) {
      const paths = entries.map((e) => e.relPath);
      lines.push("");
      lines.push(`  ${entryDir}:`);
      for (const p of paths) lines.push(`    ${p}`);
      lines.push(`  review: git -C ${entryDir} diff -- ${paths.join(" ")}`);
    }
    lines.push("Phoebe never commits in operator repos — review before committing.");
  }

  return lines.join("\n");
}

// ----------------------------------------------------------------- CLI

export type ParsedMigrateArgs = {
  configPath: string | undefined;
  help: boolean;
};

export function parseMigrateArgs(argv: readonly string[]): ParsedMigrateArgs {
  let configPath: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
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
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    // --dir and --only are intentionally not accepted (see #179)
    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown flag \`${arg}\` for \`phoebe migrate\`. See \`phoebe migrate --help\`.`,
      );
    }
    throw new Error(
      `Unexpected argument \`${arg}\` for \`phoebe migrate\`. See \`phoebe migrate --help\`.`,
    );
  }

  return { configPath, help };
}

const MIGRATE_HELP_TEXT = `phoebe migrate — apply deployment migrations

Usage:
  phoebe migrate [--config <path>]

Runs every registered migration against the deployment root in order. Each
migration detects whether it applies, stages writes, flushes them atomically,
validates the config under the current engine schema, and reverts on failure.

Artifact migrations are create-if-absent: they never overwrite operator files.
Running migrate twice is safe — a second run reports every migration as
not-applicable (idempotent by construction).

After a run, any paths Phoebe wrote are listed with a review command.
Phoebe never commits: review and commit the changes yourself.

Options:
  --config, -c <path>   Path to phoebe.config.ts (default: ./phoebe.config.ts)
  --help, -h            Show this message

Exit code: 0 when the root migrated and validated; 1 when any migration failed.
`;

export async function runMigrateCli(argv: readonly string[]): Promise<void> {
  const parsed = parseMigrateArgs(argv);
  if (parsed.help) {
    process.stdout.write(MIGRATE_HELP_TEXT);
    return;
  }

  const configPath = resolveConfigPath(parsed.configPath, process.cwd());
  const fleet = await runFleetMigrate({ configPath });

  if (fleet.rootRole === "solo-root") {
    process.stdout.write(`${formatMigrateReport(fleet.rootReport)}\n`);
  } else {
    process.stdout.write(`${formatFleetMigrateReport(fleet)}\n`);
  }

  // Exit code reflects the root alone
  if (!fleet.rootReport.ok) {
    process.exitCode = 1;
  }
}
