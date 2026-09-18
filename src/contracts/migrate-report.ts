// What `phoebe migrate` found and did, per directory and across a fleet. Lives
// here rather than in src/migrate.ts so a console can render a migration run
// without loading the registry of migrations, which reads and rewrites configs
// on disk (#527 §4).
//
// The `Migration` interface itself stays in src/migrate.ts: it is behaviour —
// detect, describe, apply — not a report, and it names a git runner.

export type MigrationRole = "solo-root" | "workspace-root" | "tenant";

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

/** One directory's migration run. */
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

/**
 * The migrate verb's outcome: the root's run plus one entry per workspace
 * child. A solo root carries an empty `tenantEntries`.
 */
export type FleetMigrateReport = {
  rootReport: MigrateReport;
  rootRole: "workspace-root" | "solo-root";
  rootSlug?: string | null;
  /**
   * Set when nothing applied to root: false = validated OK, true = preexisting
   * invalid. Absent when migrations applied (validation ran post-apply inside
   * the per-directory runner).
   */
  rootPreexistingInvalid?: boolean;
  tenantEntries: TenantMigrateEntry[];
};
