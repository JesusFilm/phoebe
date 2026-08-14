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
import { ConfigRefusal, isConfigRefusal } from "./config-handle.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import { loadUserConfig, resolveConfigPath } from "./load-config.ts";
import { MIGRATIONS } from "./migrations/index.ts";

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
   *
   * Config migrations may instead return a `ConfigRefusal` when the config is
   * too dynamic to rewrite safely. The runner reports the migration as `manual`
   * and prints the refusal instruction so the operator can make the edit by hand.
   * The deployment is left unmodified on disk — a refusal is not a failure.
   */
  apply: (
    dir: string,
    data: unknown,
    readFile: (relPath: string) => string | null,
  ) => Record<string, string> | ConfigRefusal;
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
    let staged: Record<string, string> | ConfigRefusal;
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

    // Config migrations return a ConfigRefusal when the config is too dynamic
    // to rewrite safely. Report manual and leave the deployment unmodified.
    if (isConfigRefusal(staged)) {
      results.push({ id: migration.id, state: "manual", detail: staged.instruction });
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
          try {
            writeInPlace(abs, entry.before);
          } catch {
            // best-effort
          }
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
  const dir = dirname(configPath);

  // Role is derived from the config, never guessed from cwd
  const userConfig = await loadUserConfig(configPath);
  const role: MigrationRole = userConfig.workspace !== undefined ? "workspace-root" : "solo-root";

  const report = await runMigrate({ dir, role, configPath });
  process.stdout.write(`${formatMigrateReport(report)}\n`);

  if (!report.ok) {
    process.exitCode = 1;
  }
}
