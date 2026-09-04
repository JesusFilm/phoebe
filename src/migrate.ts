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

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchConfigFlag } from "./cli-flags.ts";
import { validateUserConfig, type PhoebeUserConfig } from "./config-schema.ts";
import { ConfigRefusal, isConfigRefusal } from "./config-handle.ts";
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
  /**
   * Optional check of this migration's own making, run after the generic
   * post-apply validation has passed. Throwing reverts the migration's writes
   * exactly as a validation failure does, and the report says `failed`.
   *
   * This is where a migration that reshapes rather than adds proves the
   * reshape was faithful — that the config still resolves to what it resolved
   * to before — which the schema check cannot see.
   */
  verify?: (ctx: MigrationVerifyContext) => Promise<void>;
};

/**
 * What a migration's own post-apply check is handed. `loadConfig` is the only
 * way in: a migration that wants to compare the migrated config against the
 * one it replaced cannot read the pre-image off disk, because it has already
 * been overwritten.
 */
export type MigrationVerifyContext = {
  dir: string;
  configPath: string;
  /** The value `detect` returned, verbatim. */
  data: unknown;
  /**
   * Load a config the way the engine does: the file at `configPath` when
   * `source` is omitted, or `source` written to a throwaway sibling of it —
   * so relative imports resolve identically — when it is passed. The sibling
   * is removed before this resolves.
   */
  loadConfig: (source?: string) => Promise<PhoebeUserConfig>;
};

export type MigrationState = "applied" | "not-applicable" | "failed" | "manual" | "applicable";

export type MigrationResult = {
  id: string;
  title?: string;
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
  | "invalid"
  | "pending";

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
  rootSlug?: string | null;
  /** Set when nothing applied to root: false = validated OK, true = preexisting invalid. Absent when migrations applied (validation ran post-apply inside runMigrate). */
  rootPreexistingInvalid?: boolean;
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
  /** Preview mode: detect only, never write. */
  check?: boolean;
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

/**
 * Create `abs` and write `content`, failing with EEXIST if the path already
 * exists. Used for create-if-absent entries (before=null) so that a file
 * appearing after detect but before the flush is not silently overwritten.
 */
function writeNoClobber(abs: string, content: string): void {
  const fd = openSync(abs, "wx");
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/**
 * The `loadConfig` a migration's {@link Migration.verify} is handed. Source
 * text that is not on disk — the pre-migration config, say — is loaded through
 * a throwaway sibling of the real config so its relative imports resolve the
 * same way, created no-clobber and removed again whatever happens.
 */
function makeVerifyLoader(
  configPath: string,
  counter: number,
): (source?: string) => Promise<PhoebeUserConfig> {
  let scratch = 0;
  return async (source?: string) => {
    if (source === undefined) {
      return loadUserConfig(configPath, { reloadKey: `migrate-verify-${String(counter)}` });
    }
    scratch += 1;
    const suffix = `${String(counter)}-${String(scratch)}`;
    const abs = join(dirname(configPath), `.phoebe-migrate-verify-${suffix}.ts`);
    writeNoClobber(abs, source);
    try {
      return await loadUserConfig(abs, { reloadKey: `migrate-verify-scratch-${suffix}` });
    } finally {
      try {
        unlinkSync(abs);
      } catch {
        // best-effort: a scratch file we cannot remove is not worth failing over
      }
    }
  };
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
  /** Preview mode: detect only, never write. Applicable migrations emit state "applicable". */
  check?: boolean;
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
        title: migration.title,
        state: "failed",
        detail: `detect threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (data === null) {
      results.push({
        id: migration.id,
        title: migration.title,
        state: "not-applicable",
        detail: "",
      });
      continue;
    }

    // check mode: report applicable and skip all writes
    if (opts.check) {
      results.push({
        id: migration.id,
        title: migration.title,
        state: "applicable",
        detail: migration.describe(data),
      });
      continue;
    }

    // stage writes (may throw — nothing flushed yet)
    let staged: Record<string, string> | ConfigRefusal;
    try {
      staged = migration.apply(opts.dir, data, readFile);
    } catch (err) {
      results.push({
        id: migration.id,
        title: migration.title,
        state: "failed",
        detail: `apply threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Config migrations return a ConfigRefusal when the config is too dynamic
    // to rewrite safely. Report manual and leave the deployment unmodified.
    if (isConfigRefusal(staged)) {
      results.push({
        id: migration.id,
        title: migration.title,
        state: "manual",
        detail: staged.instruction,
      });
      continue;
    }

    // flush: capture pre-images, then write all
    const entries: JournalEntry[] = [];
    try {
      for (const [relPath, content] of Object.entries(staged)) {
        const abs = join(opts.dir, relPath);
        const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
        mkdirSync(dirname(abs), { recursive: true });
        // Use no-clobber create for new files so that a file appearing after
        // detect (TOCTOU) fails with EEXIST rather than silently overwriting.
        if (before === null) {
          writeNoClobber(abs, content);
        } else {
          writeInPlace(abs, content);
        }
        entries.push({ dir: opts.dir, migrationId: migration.id, relPath, before });
      }
    } catch (err) {
      // Revert entries written so far and record the failure.
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
        title: migration.title,
        state: "failed",
        detail: `flush failed (reverted): ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // post-apply validation — only a validation failure triggers revert
    counter += 1;
    let failureLabel = "validation";
    try {
      await validate(opts.configPath, counter);
      if (migration.verify !== undefined) {
        failureLabel = "verification";
        await migration.verify({
          dir: opts.dir,
          configPath: opts.configPath,
          data,
          loadConfig: makeVerifyLoader(opts.configPath, counter),
        });
      }
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
        title: migration.title,
        state: "failed",
        detail: `${failureLabel} failed (reverted): ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    journal.push(...entries);
    results.push({
      id: migration.id,
      title: migration.title,
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

export function computeTenantVerdict(
  report: MigrateReport,
  preexistingInvalid: boolean,
  check = false,
): TenantVerdict {
  if (check) {
    if (report.results.some((r) => r.state === "failed")) return "failed";
    if (report.results.some((r) => r.state === "applicable")) return "pending";
    if (preexistingInvalid) return "invalid";
    return "up-to-date";
  }
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
  const check = opts.check ?? false;

  const userConfig = await loadUserConfig(configPath);
  const rootRole: "workspace-root" | "solo-root" =
    userConfig.workspace !== undefined ? "workspace-root" : "solo-root";
  const rootSlug: string | null = userConfig.repoSlug ?? null;

  // Migrate root first — no dirty-tree gate for root
  const rootReport = await runMigrate({
    dir,
    role: rootRole,
    configPath,
    git,
    migrations: opts.migrations,
    validateFn: opts.validateFn,
    check,
  });

  // Mirror the tenant preexisting-invalid check for the root
  const rootNothingApplied = rootReport.results.every((r) => r.state === "not-applicable");
  let rootPreexistingInvalid: boolean | undefined;
  if (rootNothingApplied) {
    try {
      await validate(configPath, 0);
      rootPreexistingInvalid = false;
    } catch {
      rootPreexistingInvalid = true;
    }
  }

  if (rootRole === "solo-root") {
    return { rootReport, rootRole, rootSlug, rootPreexistingInvalid, tenantEntries: [] };
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
        check,
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
        verdict: computeTenantVerdict(report, preexistingInvalid, check),
        report,
      });
    }
  }

  return { rootReport, rootRole, rootSlug, rootPreexistingInvalid, tenantEntries };
}

// ----------------------------------------------------------------- formatter

const STATE_MARK: Record<Exclude<MigrationState, "not-applicable">, string> = {
  applied: "✓",
  failed: "✗",
  manual: "!",
  applicable: "~",
};

export function formatMigrateReport(report: MigrateReport): string {
  const shaLabel = report.sha !== null ? report.sha.slice(0, 12) : "(non-repo checkout)";
  const lines: string[] = [`[phoebe] migrate — ${shaLabel}`];

  let applicable = 0;
  let applied = 0;
  let failed = 0;
  let manual = 0;
  let notApplicable = 0;

  for (const result of report.results) {
    if (result.state === "not-applicable") {
      notApplicable++;
      continue;
    }
    if (result.state === "applicable") applicable++;
    else if (result.state === "applied") applied++;
    else if (result.state === "failed") failed++;
    else if (result.state === "manual") manual++;
    lines.push(`  ${STATE_MARK[result.state]} ${result.id.padEnd(28)} ${result.detail}`);
  }

  // Summary line collapsing not-applicable
  const parts: string[] = [];
  if (applicable > 0) parts.push(`${String(applicable)} applicable`);
  if (applied > 0) parts.push(`${String(applied)} applied`);
  if (failed > 0) parts.push(`${String(failed)} failed`);
  if (manual > 0) parts.push(`${String(manual)} manual`);
  if (notApplicable > 0) parts.push(`${String(notApplicable)} not applicable`);
  if (parts.length > 0) lines.push(parts.join(", "));

  // Dependent-migration caveat — only when ≥1 migration is applicable (check mode)
  if (applicable > 0) {
    lines.push(
      "Note: a migration depending on an earlier applicable one may appear not-applicable here.",
    );
  }

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
  pending: "~",
};

export function formatFleetMigrateReport(report: FleetMigrateReport): string {
  const sha = report.rootReport.sha;
  const shaLabel = sha !== null ? sha.slice(0, 12) : "(non-repo checkout)";
  const lines: string[] = [`[phoebe] migrate — ${shaLabel}`];

  // Root section
  lines.push("");
  lines.push(`root (${report.rootReport.dir}):`);
  let applicable = 0,
    applied = 0,
    failed = 0,
    manual = 0,
    notApplicable = 0;
  for (const result of report.rootReport.results) {
    if (result.state === "not-applicable") {
      notApplicable++;
      continue;
    }
    if (result.state === "applicable") applicable++;
    else if (result.state === "applied") applied++;
    else if (result.state === "failed") failed++;
    else if (result.state === "manual") manual++;
    lines.push(`  ${STATE_MARK[result.state]} ${result.id.padEnd(28)} ${result.detail}`);
  }
  const rootParts: string[] = [];
  if (applicable > 0) rootParts.push(`${String(applicable)} applicable`);
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

  // Dependent-migration caveat — only when ≥1 migration is applicable (check mode)
  const anyApplicable =
    report.rootReport.results.some((r) => r.state === "applicable") ||
    report.tenantEntries.some((e) => e.report?.results.some((r) => r.state === "applicable"));
  if (anyApplicable) {
    lines.push("");
    lines.push(
      "Note: a migration depending on an earlier applicable one may appear not-applicable here.",
    );
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

// ----------------------------------------------------------------- JSON envelope

export type MigrateJsonMigration = {
  id: string;
  title: string;
  status: MigrationState;
  detail: string;
  paths: string[];
};

export type MigrateJsonEntry = {
  dir: string;
  slug: string | null;
  role: "solo-root" | "workspace-root" | "tenant";
  verdict: TenantVerdict;
  reason?: string;
  validation: boolean | null;
  migrations: MigrateJsonMigration[];
};

export type MigrateJsonCounts = {
  migrations: {
    applied: number;
    applicable: number;
    failed: number;
    manual: number;
    notApplicable: number;
  };
  tenants: {
    migrated: number;
    pending: number;
    upToDate: number;
    invalid: number;
    failed: number;
    reverted: number;
    manual: number;
    skipped: number;
  };
};

export type MigrateJson = {
  mode: "apply" | "check";
  report: 1;
  engine: {
    dir: string;
    sha: string | null;
    source: "git" | "local";
  };
  root: MigrateJsonEntry;
  tenants: MigrateJsonEntry[];
  counts: MigrateJsonCounts;
  ok: boolean;
};

// Maps a verdict to the tri-state `validation` field. `up-to-date` reads as
// `true` only because the caller confirmed the config validates — runFleetMigrate
// probes a tenant with nothing applicable before settling on that verdict. Callers
// that cannot make that claim must not route through here (see the root below).
function entryValidation(verdict: TenantVerdict): boolean | null {
  if (verdict === "migrated" || verdict === "up-to-date") return true;
  if (verdict === "invalid") return false;
  return null;
}

function buildJsonMigrations(report: MigrateReport): MigrateJsonMigration[] {
  return report.results.map((result) => ({
    id: result.id,
    title: result.title ?? result.id,
    status: result.state,
    detail: result.detail,
    paths: report.journal.filter((e) => e.migrationId === result.id).map((e) => e.relPath),
  }));
}

export function buildMigrateJson(
  fleet: FleetMigrateReport,
  opts: { mode: "apply" | "check" },
): MigrateJson {
  const check = opts.mode === "check";
  const sha = fleet.rootReport.sha;
  const rootPreexistingInvalid = fleet.rootPreexistingInvalid;
  const rootVerdict = computeTenantVerdict(
    fleet.rootReport,
    rootPreexistingInvalid ?? false,
    check,
  );

  const root: MigrateJsonEntry = {
    dir: fleet.rootReport.dir,
    slug: fleet.rootSlug ?? null,
    role: fleet.rootRole,
    verdict: rootVerdict,
    // migrated → post-apply validation passed; preexisting check performed → use normal logic;
    // up-to-date without preexisting check → emit null (validation was not performed)
    validation:
      rootVerdict === "migrated"
        ? true
        : rootPreexistingInvalid !== undefined
          ? entryValidation(rootVerdict)
          : null,
    migrations: buildJsonMigrations(fleet.rootReport),
  };

  const tenants: MigrateJsonEntry[] = fleet.tenantEntries.map((entry) => {
    if (entry.verdict === "skipped") {
      return {
        dir: entry.dir,
        slug: entry.slug,
        role: "tenant" as const,
        verdict: "skipped" as const,
        reason: entry.reason,
        validation: null,
        migrations: [],
      };
    }
    return {
      dir: entry.dir,
      slug: entry.slug,
      role: "tenant" as const,
      verdict: entry.verdict,
      validation: entryValidation(entry.verdict),
      migrations: buildJsonMigrations(entry.report!),
    };
  });

  const allMigrations = [root, ...tenants].flatMap((e) => e.migrations);
  const counts: MigrateJsonCounts = {
    migrations: {
      applied: allMigrations.filter((m) => m.status === "applied").length,
      applicable: allMigrations.filter((m) => m.status === "applicable").length,
      failed: allMigrations.filter((m) => m.status === "failed").length,
      manual: allMigrations.filter((m) => m.status === "manual").length,
      notApplicable: allMigrations.filter((m) => m.status === "not-applicable").length,
    },
    tenants: {
      migrated: tenants.filter((e) => e.verdict === "migrated").length,
      pending: tenants.filter((e) => e.verdict === "pending").length,
      upToDate: tenants.filter((e) => e.verdict === "up-to-date").length,
      invalid: tenants.filter((e) => e.verdict === "invalid").length,
      failed: tenants.filter((e) => e.verdict === "failed").length,
      reverted: tenants.filter((e) => e.verdict === "reverted").length,
      manual: tenants.filter((e) => e.verdict === "manual").length,
      skipped: tenants.filter((e) => e.verdict === "skipped").length,
    },
  };

  const anyApplicable =
    fleet.rootReport.results.some((r) => r.state === "applicable") ||
    fleet.tenantEntries.some((e) => e.report?.results.some((r) => r.state === "applicable"));
  const ok = check ? !anyApplicable : fleet.rootReport.ok;

  return {
    mode: opts.mode,
    report: 1,
    engine: { dir: engineDir(), sha, source: sha !== null ? "git" : "local" },
    root,
    tenants,
    counts,
    ok,
  };
}

// ----------------------------------------------------------------- CLI

export type ParsedMigrateArgs = {
  configPath: string | undefined;
  help: boolean;
  check: boolean;
  json: boolean;
};

export function parseMigrateArgs(argv: readonly string[]): ParsedMigrateArgs {
  let configPath: string | undefined;
  let help = false;
  let check = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--check") {
      check = true;
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

  return { configPath, help, check, json };
}

const MIGRATE_HELP_TEXT = `phoebe migrate — apply deployment migrations

Usage:
  phoebe migrate [--config <path>]
  phoebe migrate --check [--config <path>]

Runs every registered migration against the deployment root in order. Each
migration detects whether it applies, stages writes, flushes them atomically,
validates the config under the current engine schema, and reverts on failure.

Artifact migrations are create-if-absent: they never overwrite operator files.
Running migrate twice is safe — a second run reports every migration as
not-applicable (idempotent by construction).

After a run, any paths Phoebe wrote are listed with a review command.
Phoebe never commits: review and commit the changes yourself.

Options:
  --check               Preview mode — detect only, nothing written. Exit 1
                        when ≥1 migration is applicable, 0 when none.
  --json                Emit a machine-readable JSON envelope to stdout instead
                        of the human-readable report.
  --config, -c <path>   Path to phoebe.config.ts (default: ./phoebe.config.ts)
  --help, -h            Show this message

Exit code: 0 when the root migrated and validated; 1 when any migration failed.
  With --check: 1 when ≥1 migration is applicable, 0 when none.
`;

export async function runMigrateCli(argv: readonly string[]): Promise<void> {
  const parsed = parseMigrateArgs(argv);
  if (parsed.help) {
    process.stdout.write(MIGRATE_HELP_TEXT);
    return;
  }

  const configPath = resolveConfigPath(parsed.configPath, process.cwd());
  const fleet = await runFleetMigrate({ configPath, check: parsed.check });

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(buildMigrateJson(fleet, { mode: parsed.check ? "check" : "apply" }))}\n`,
    );
  } else if (fleet.rootRole === "solo-root") {
    process.stdout.write(`${formatMigrateReport(fleet.rootReport)}\n`);
  } else {
    process.stdout.write(`${formatFleetMigrateReport(fleet)}\n`);
  }

  if (parsed.check) {
    // Exit 1 when ≥1 migration is applicable across the entire fleet
    const anyApplicable =
      fleet.rootReport.results.some((r) => r.state === "applicable") ||
      fleet.tenantEntries.some((e) => e.report?.results.some((r) => r.state === "applicable"));
    if (anyApplicable) process.exitCode = 1;
  } else {
    // Exit code reflects the root alone
    if (!fleet.rootReport.ok) {
      process.exitCode = 1;
    }
  }
}
