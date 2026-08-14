// `phoebe migrate` contracts:
//   * parseMigrateArgs rejects --dir and --only; accepts --config and --help.
//   * runMigrate: not-applicable when detect returns null; applied when detect
//     returns non-null and apply + validation succeed; failed (no file written)
//     when apply throws; failed + reverted when post-apply validation fails;
//     a failed migration does not halt remaining migrations in the directory.
//   * idempotence: detect → apply (flush) → detect returns null, for every
//     registered migration.
//   * formatMigrateReport: applies listed individually, not-applicable collapsed
//     to trailing count, uncommitted listing only includes journal paths.
//   * Pre-existing dirt absent from uncommitted listing.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { researchPromptMigration } from "./migrations/m001-research-prompt.ts";
import {
  formatFleetMigrateReport,
  formatMigrateReport,
  parseMigrateArgs,
  runFleetMigrate,
  runMigrate,
  type FleetMigrateReport,
  type Migration,
  type MigrateReport,
} from "./migrate.ts";
import type { WorkspaceEnumeration } from "./tenant-commands.ts";

// ----------------------------------------------------------------- fixtures

const MINIMAL_CONFIG = `export const config = {
  repoSlug: "acme/test",
  repoUrl: "https://github.com/acme/test.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};
`;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "phoebe-migrate-test-"));
}

function scaffoldDeployment(dir: string, extra?: Record<string, string>): string {
  const configPath = join(dir, "phoebe.config.ts");
  writeFileSync(configPath, MINIMAL_CONFIG);
  for (const [relPath, content] of Object.entries(extra ?? {})) {
    const abs = join(dir, relPath);
    mkdirSync(join(dir, relPath, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return configPath;
}

/** A migration that always applies, writing one file. */
function makeApplyingMigration(id: string, relPath: string, content: string): Migration {
  return {
    id,
    title: `Test migration ${id}`,
    appliesTo: ["solo-root"] as const,
    detect(_dir, readFile) {
      return readFile(relPath) === null ? true : null;
    },
    describe() {
      return `scaffold ${relPath}`;
    },
    apply() {
      return { [relPath]: content };
    },
  };
}

/** A migration that never applies. */
function makeNonApplyingMigration(id: string): Migration {
  return {
    id,
    title: `Never migration ${id}`,
    appliesTo: ["solo-root"] as const,
    detect() {
      return null;
    },
    describe() {
      return "";
    },
    apply() {
      return {};
    },
  };
}

/** A migration whose apply() always throws. */
function makeThrowingMigration(id: string): Migration {
  return {
    id,
    title: `Throwing migration ${id}`,
    appliesTo: ["solo-root"] as const,
    detect() {
      return true;
    },
    describe() {
      return "";
    },
    apply() {
      throw new Error("apply exploded");
    },
  };
}

// ----------------------------------------------------------------- parseMigrateArgs

describe("parseMigrateArgs", () => {
  test("empty argv produces defaults", () => {
    expect(parseMigrateArgs([])).toEqual({ configPath: undefined, help: false, check: false });
  });

  test("--help and -h set help", () => {
    expect(parseMigrateArgs(["--help"]).help).toBe(true);
    expect(parseMigrateArgs(["-h"]).help).toBe(true);
  });

  test("--check sets check", () => {
    expect(parseMigrateArgs(["--check"]).check).toBe(true);
  });

  test("--check and --config together", () => {
    const result = parseMigrateArgs(["--check", "--config", "my.config.ts"]);
    expect(result.check).toBe(true);
    expect(result.configPath).toBe("my.config.ts");
  });

  test("--config <path>", () => {
    expect(parseMigrateArgs(["--config", "my.config.ts"])).toEqual({
      configPath: "my.config.ts",
      help: false,
      check: false,
    });
  });

  test("-c <path>", () => {
    expect(parseMigrateArgs(["-c", "my.config.ts"]).configPath).toBe("my.config.ts");
  });

  test("--config=<path>", () => {
    expect(parseMigrateArgs(["--config=my.config.ts"]).configPath).toBe("my.config.ts");
  });

  test("--config without a value throws", () => {
    expect(() => parseMigrateArgs(["--config"])).toThrow(/requires a path/);
    expect(() => parseMigrateArgs(["-c"])).toThrow(/requires a path/);
  });

  test("rejects --dir", () => {
    expect(() => parseMigrateArgs(["--dir", "/tmp/foo"])).toThrow(/Unknown flag/);
  });

  test("rejects --only", () => {
    expect(() => parseMigrateArgs(["--only", "some-id"])).toThrow(/Unknown flag/);
  });

  test("rejects unknown flags", () => {
    expect(() => parseMigrateArgs(["--bogus"])).toThrow(/Unknown flag.*bogus/);
  });

  test("rejects bare positional arguments", () => {
    expect(() => parseMigrateArgs(["something"])).toThrow(/Unexpected argument/);
  });
});

// ----------------------------------------------------------------- runMigrate

describe("runMigrate", () => {
  test("no migrations → empty results, ok=true", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [],
      validateFn: async () => {},
    });
    expect(report.results).toHaveLength(0);
    expect(report.journal).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  test("migration not-applicable when detect returns null", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeNonApplyingMigration("test-skip")],
      validateFn: async () => {},
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.state).toBe("not-applicable");
    expect(report.journal).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  test("migration applied → file written and journaled", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeApplyingMigration("test-create", "prompts/test.md", "# Test\n")],
      validateFn: async () => {},
    });
    expect(report.results[0]!.state).toBe("applied");
    expect(report.journal).toHaveLength(1);
    expect(report.journal[0]!.relPath).toBe("prompts/test.md");
    expect(report.journal[0]!.before).toBeNull();
    expect(existsSync(join(dir, "prompts/test.md"))).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("second run: migration reports not-applicable (idempotent)", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const migration = makeApplyingMigration("test-idem", "prompts/idem.md", "# Idem\n");
    await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [migration],
      validateFn: async () => {},
    });
    const second = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [migration],
      validateFn: async () => {},
    });
    expect(second.results[0]!.state).toBe("not-applicable");
    expect(second.journal).toHaveLength(0);
  });

  test("apply throwing → failed, no file written, remaining migrations continue", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const afterMigration = makeApplyingMigration("after", "prompts/after.md", "# After\n");
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeThrowingMigration("exploder"), afterMigration],
      validateFn: async () => {},
    });
    const exploder = report.results.find((r) => r.id === "exploder")!;
    expect(exploder.state).toBe("failed");
    expect(exploder.detail).toMatch(/apply threw.*apply exploded/);
    // No file from the failing migration
    expect(report.journal.find((e) => e.migrationId === "exploder")).toBeUndefined();
    // Remaining migration still ran
    const after = report.results.find((r) => r.id === "after")!;
    expect(after.state).toBe("applied");
    expect(report.ok).toBe(false);
  });

  test("validation failure → failed, file reverted, does not halt remaining migrations", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    let calls = 0;
    const afterMigration = makeApplyingMigration("after2", "prompts/after2.md", "# After2\n");
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeApplyingMigration("bad-valid", "prompts/bad.md", "# Bad\n"), afterMigration],
      validateFn: async (_configPath, n) => {
        calls += 1;
        if (n === 1) throw new Error("config invalid after migration");
      },
    });
    // bad-valid migration was reverted
    expect(existsSync(join(dir, "prompts/bad.md"))).toBe(false);
    const badResult = report.results.find((r) => r.id === "bad-valid")!;
    expect(badResult.state).toBe("failed");
    expect(badResult.detail).toMatch(/validation failed \(reverted\)/);
    // Not in the journal
    expect(report.journal.find((e) => e.migrationId === "bad-valid")).toBeUndefined();
    // after2 still ran and was journaled
    const afterResult = report.results.find((r) => r.id === "after2")!;
    expect(afterResult.state).toBe("applied");
    expect(report.journal.find((e) => e.migrationId === "after2")).toBeDefined();
    expect(calls).toBe(2);
    expect(report.ok).toBe(false);
  });

  test("migration skipped when appliesTo does not include the role", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const workspaceMigration: Migration = {
      id: "workspace-only",
      title: "Workspace only",
      appliesTo: ["workspace-root"] as const,
      detect() {
        return true;
      },
      describe() {
        return "workspace only";
      },
      apply() {
        return { "some-file.txt": "content" };
      },
    };
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [workspaceMigration],
      validateFn: async () => {},
    });
    // The workspace migration produces no result entry (silently skipped)
    expect(report.results).toHaveLength(0);
    expect(existsSync(join(dir, "some-file.txt"))).toBe(false);
  });

  test("pre-existing dirty file not claimed by journal", async () => {
    const dir = makeTempDir();
    // Write a file that exists before migration runs
    const configPath = scaffoldDeployment(dir, { "prompts/pre-existing.md": "old content\n" });
    // Migration targets a different path
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeApplyingMigration("new-file", "prompts/new.md", "# New\n")],
      validateFn: async () => {},
    });
    const journalPaths = report.journal.map((e) => e.relPath);
    expect(journalPaths).not.toContain("prompts/pre-existing.md");
    expect(journalPaths).toContain("prompts/new.md");
  });

  test("existing file reverted to original content on validation failure", async () => {
    const dir = makeTempDir();
    const original = "original content\n";
    const configPath = scaffoldDeployment(dir, { "prompts/existing.md": original });
    const overwriteMigration: Migration = {
      id: "overwrite",
      title: "Overwrite existing file",
      appliesTo: ["solo-root"] as const,
      detect() {
        return true;
      },
      describe() {
        return "overwrite";
      },
      apply() {
        return { "prompts/existing.md": "new content\n" };
      },
    };
    await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [overwriteMigration],
      validateFn: async () => {
        throw new Error("invalid");
      },
    });
    expect(readFileSync(join(dir, "prompts/existing.md"), "utf8")).toBe(original);
  });

  test("engine SHA is read (may be null in test env) and placed in report", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [],
      validateFn: async () => {},
    });
    // sha is either a 40-char hex string or null — never undefined
    expect(report.sha === null || /^[0-9a-f]{40}$/.test(report.sha)).toBe(true);
  });
});

// ----------------------------------------------------------------- runMigrate check mode

describe("runMigrate check mode", () => {
  test("applicable migration reports 'applicable' state and writes nothing", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeApplyingMigration("test-check", "prompts/check.md", "# Check\n")],
      validateFn: async () => {},
      check: true,
    });
    expect(report.results[0]!.state).toBe("applicable");
    expect(report.journal).toHaveLength(0);
    expect(existsSync(join(dir, "prompts/check.md"))).toBe(false);
    expect(report.ok).toBe(true);
  });

  test("non-applicable migration still reports 'not-applicable' in check mode", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeNonApplyingMigration("never-check")],
      validateFn: async () => {},
      check: true,
    });
    expect(report.results[0]!.state).toBe("not-applicable");
    expect(report.journal).toHaveLength(0);
  });

  test("check mode does not call apply or validate", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    let applyCalled = false;
    let validateCalled = false;
    const m: Migration = {
      id: "spy",
      title: "Spy",
      appliesTo: ["solo-root"] as const,
      detect() {
        return true;
      },
      describe() {
        return "would scaffold";
      },
      apply() {
        applyCalled = true;
        return {};
      },
    };
    await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [m],
      validateFn: async () => {
        validateCalled = true;
      },
      check: true,
    });
    expect(applyCalled).toBe(false);
    expect(validateCalled).toBe(false);
  });

  test("check mode: applicable detail comes from describe()", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeApplyingMigration("test-detail", "prompts/detail.md", "# Detail\n")],
      validateFn: async () => {},
      check: true,
    });
    expect(report.results[0]!.detail).toBe("scaffold prompts/detail.md");
  });
});

// ----------------------------------------------------------------- formatMigrateReport

describe("formatMigrateReport", () => {
  const BASE: MigrateReport = {
    sha: "abc123def456789012345678901234567890abcd",
    dir: "/deployments/acme",
    results: [],
    journal: [],
    ok: true,
  };

  test("header contains short SHA", () => {
    const out = formatMigrateReport(BASE);
    expect(out).toContain("abc123def456");
    expect(out).toContain("[phoebe] migrate");
  });

  test("null SHA renders as non-repo placeholder", () => {
    const out = formatMigrateReport({ ...BASE, sha: null });
    expect(out).toContain("(non-repo checkout)");
  });

  test("applied result shows mark and detail", () => {
    const report: MigrateReport = {
      ...BASE,
      results: [
        {
          id: "add-research-prompt",
          state: "applied",
          detail: "scaffold prompts/research-prompt.md",
        },
      ],
    };
    const out = formatMigrateReport(report);
    expect(out).toContain("✓");
    expect(out).toContain("add-research-prompt");
    expect(out).toContain("scaffold prompts/research-prompt.md");
    expect(out).toContain("1 applied");
  });

  test("failed result shows mark", () => {
    const report: MigrateReport = {
      ...BASE,
      results: [{ id: "bad", state: "failed", detail: "something went wrong" }],
      ok: false,
    };
    const out = formatMigrateReport(report);
    expect(out).toContain("✗");
    expect(out).toContain("1 failed");
  });

  test("not-applicable results are collapsed to trailing count only", () => {
    const report: MigrateReport = {
      ...BASE,
      results: [
        { id: "a", state: "not-applicable", detail: "" },
        { id: "b", state: "not-applicable", detail: "" },
        { id: "c", state: "applied", detail: "did something" },
      ],
    };
    const out = formatMigrateReport(report);
    expect(out).toContain("1 applied, 2 not applicable");
    expect(out).not.toContain("not-applicable");
    // Individual not-applicable rows should not appear
    expect(out).not.toMatch(/✓ a\b/);
    expect(out).not.toMatch(/✓ b\b/);
  });

  test("uncommitted listing shows journal paths and review command", () => {
    const report: MigrateReport = {
      ...BASE,
      results: [{ id: "add-research-prompt", state: "applied", detail: "scaffold" }],
      journal: [
        {
          dir: "/deployments/acme",
          migrationId: "add-research-prompt",
          relPath: "prompts/research-prompt.md",
          before: null,
        },
      ],
    };
    const out = formatMigrateReport(report);
    expect(out).toContain("uncommitted paths Phoebe wrote:");
    expect(out).toContain("prompts/research-prompt.md");
    expect(out).toContain("git -C /deployments/acme diff -- prompts/research-prompt.md");
    expect(out).toContain("Phoebe never commits");
  });

  test("no uncommitted listing when journal is empty", () => {
    const out = formatMigrateReport(BASE);
    expect(out).not.toContain("uncommitted");
    expect(out).not.toContain("Phoebe never commits");
  });

  test("applicable result shows ~ mark, 'applicable' count, and dependent caveat", () => {
    const report: MigrateReport = {
      ...BASE,
      results: [{ id: "would-fire", state: "applicable", detail: "scaffold prompts/foo.md" }],
    };
    const out = formatMigrateReport(report);
    expect(out).toContain("~");
    expect(out).toContain("would-fire");
    expect(out).toContain("scaffold prompts/foo.md");
    expect(out).toContain("1 applicable");
    expect(out).toContain("Note:");
  });

  test("dependent caveat absent when no applicable migrations", () => {
    const out = formatMigrateReport(BASE);
    expect(out).not.toContain("Note:");
  });

  test("dependent caveat absent when all migrations applied (apply mode)", () => {
    const report: MigrateReport = {
      ...BASE,
      results: [{ id: "m1", state: "applied", detail: "did it" }],
    };
    const out = formatMigrateReport(report);
    expect(out).not.toContain("Note:");
  });
});

// ----------------------------------------------------------------- m001 idempotence

describe("m001 researchPromptMigration: detect → apply → detect returns null", () => {
  test("detect returns non-null when file absent, null after apply writes it", () => {
    const dir = makeTempDir();
    const readFile = (relPath: string): string | null => {
      try {
        return readFileSync(join(dir, relPath), "utf8");
      } catch {
        return null;
      }
    };

    // 1. detect: file absent → applicable
    const data = researchPromptMigration.detect(dir, readFile);
    expect(data).not.toBeNull();

    // 2. apply: get staged writes
    const staged = researchPromptMigration.apply(dir, data, readFile);
    expect(staged).toHaveProperty("prompts/research-prompt.md");
    const content = staged["prompts/research-prompt.md"]!;
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);

    // flush the staged write
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts/research-prompt.md"), content);

    // 3. detect again → not-applicable (null)
    const dataAfter = researchPromptMigration.detect(dir, readFile);
    expect(dataAfter).toBeNull();
  });

  test("detect returns null when file already present", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts/research-prompt.md"), "# existing\n");
    const readFile = (relPath: string): string | null => {
      try {
        return readFileSync(join(dir, relPath), "utf8");
      } catch {
        return null;
      }
    };
    expect(researchPromptMigration.detect(dir, readFile)).toBeNull();
  });

  test("appliesTo includes solo-root only", () => {
    expect(researchPromptMigration.appliesTo).toContain("solo-root");
    expect(researchPromptMigration.appliesTo).not.toContain("workspace-root");
    expect(researchPromptMigration.appliesTo).not.toContain("tenant");
  });

  test("shipped content is a non-empty string", () => {
    const staged = researchPromptMigration.apply("", true, () => null);
    const content = staged["prompts/research-prompt.md"]!;
    expect(content.length).toBeGreaterThan(10);
  });
});

// ----------------------------------------------------------------- fleet walk helpers

const WORKSPACE_CONFIG = `export const config = {
  repoSlug: "acme/root",
  repoUrl: "https://github.com/acme/root.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  workspace: { depth: 1 },
};
`;

function scaffoldWorkspaceRoot(dir: string): string {
  const configPath = join(dir, "phoebe.config.ts");
  writeFileSync(configPath, WORKSPACE_CONFIG);
  return configPath;
}

function makeTenant(
  dir: string,
  slug: string | null = "acme/child",
): WorkspaceEnumeration["tenants"][number] {
  const configPath = join(dir, "phoebe.config.ts");
  return {
    id: dir,
    slug,
    dir,
    configPath,
    envPath: join(dir, ".env"),
  };
}

function fakeEnumerate(
  tenants: WorkspaceEnumeration["tenants"],
  holds: WorkspaceEnumeration["holds"] = [],
): NonNullable<Parameters<typeof runFleetMigrate>[0]["enumerateFn"]> {
  return async () => ({
    workspace: { depth: 1 } as WorkspaceEnumeration["workspace"],
    explicit: false,
    tenants,
    holds,
  });
}

/** Migration that only applies when role is "tenant". */
function makeTenantMigration(id: string, relPath: string, content: string): Migration {
  return {
    id,
    title: `Tenant migration ${id}`,
    appliesTo: ["tenant"] as const,
    detect(_dir, readFile) {
      return readFile(relPath) === null ? true : null;
    },
    describe() {
      return `scaffold ${relPath}`;
    },
    apply() {
      return { [relPath]: content };
    },
  };
}

/** Migration that only applies when role is "workspace-root". */
function makeWorkspaceRootMigration(id: string, relPath: string, content: string): Migration {
  return {
    id,
    title: `Workspace-root migration ${id}`,
    appliesTo: ["workspace-root"] as const,
    detect(_dir, readFile) {
      return readFile(relPath) === null ? true : null;
    },
    describe() {
      return `scaffold ${relPath}`;
    },
    apply() {
      return { [relPath]: content };
    },
  };
}

// ----------------------------------------------------------------- runFleetMigrate

describe("runFleetMigrate: solo-root", () => {
  test("returns empty tenantEntries for a solo deployment", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const fleet = await runFleetMigrate({
      configPath,
      migrations: [],
      validateFn: async () => {},
    });
    expect(fleet.rootRole).toBe("solo-root");
    expect(fleet.tenantEntries).toHaveLength(0);
    expect(fleet.rootReport.ok).toBe(true);
  });
});

describe("runFleetMigrate: workspace-root fleet walk", () => {
  test("clean tenant with applicable migration → migrated verdict", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const migration = makeTenantMigration("t001", "prompts/tenant.md", "# Tenant\n");
    const fleet = await runFleetMigrate({
      configPath,
      migrations: [migration],
      validateFn: async () => {},
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
    });

    expect(fleet.rootRole).toBe("workspace-root");
    expect(fleet.tenantEntries).toHaveLength(1);
    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("migrated");
    expect(entry.report?.results[0]?.state).toBe("applied");
    expect(entry.report?.journal[0]?.relPath).toBe("prompts/tenant.md");
    expect(existsSync(join(childDir, "prompts/tenant.md"))).toBe(true);
  });

  test("dirty tenant → skipped verdict with commit-or-stash reason", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const migration = makeTenantMigration("t001", "prompts/tenant.md", "# Tenant\n");
    const fleet = await runFleetMigrate({
      configPath,
      migrations: [migration],
      validateFn: async () => {},
      isDirtyFn: (d) => d === childDir,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
    });

    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("skipped");
    expect(entry.reason).toMatch(/commit or stash/);
    expect(entry.report).toBeUndefined();
    expect(existsSync(join(childDir, "prompts/tenant.md"))).toBe(false);
  });

  test("held tenant → skipped verdict with hold reason", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();

    const fleet = await runFleetMigrate({
      configPath,
      migrations: [],
      validateFn: async () => {},
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate(
        [],
        [{ dir: childDir, slug: "acme/held", reason: "origin mismatch" }],
      ),
    });

    expect(fleet.tenantEntries).toHaveLength(1);
    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("skipped");
    expect(entry.reason).toBe("origin mismatch");
  });

  test("workspace-root migration never runs against tenant", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const rootOnlyMigration = makeWorkspaceRootMigration("r001", "root-only.md", "# Root\n");
    const fleet = await runFleetMigrate({
      configPath,
      migrations: [rootOnlyMigration],
      validateFn: async () => {},
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
    });

    // Root gets the migration
    expect(fleet.rootReport.results.find((r) => r.id === "r001")?.state).toBe("applied");
    // Tenant has empty results (role filter skips it entirely)
    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("up-to-date");
    expect(entry.report?.results).toHaveLength(0);
  });

  test("tenant with no applicable migrations, valid config → up-to-date", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const fleet = await runFleetMigrate({
      configPath,
      migrations: [],
      validateFn: async () => {},
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
    });

    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("up-to-date");
  });

  test("tenant with no applicable migrations, broken config → invalid verdict", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const fleet = await runFleetMigrate({
      configPath,
      migrations: [],
      validateFn: async (cp) => {
        if (cp !== configPath) throw new Error("tenant config broken");
      },
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
    });

    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("invalid");
    expect(entry.report?.ok).toBe(true);
  });

  test("tenant migration apply failure → failed verdict, root ok unaffected", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const throwingTenantMigration: Migration = {
      id: "t-throw",
      title: "Throwing tenant migration",
      appliesTo: ["tenant"] as const,
      detect() {
        return true;
      },
      describe() {
        return "";
      },
      apply() {
        throw new Error("tenant apply exploded");
      },
    };

    const fleet = await runFleetMigrate({
      configPath,
      migrations: [throwingTenantMigration],
      validateFn: async () => {},
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
    });

    // Root is fine
    expect(fleet.rootReport.ok).toBe(true);
    // Tenant has failed verdict
    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("failed");
    expect(entry.report?.ok).toBe(false);
  });

  test("tenant validation failure → reverted verdict", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const migration = makeTenantMigration("t-revert", "prompts/revert-me.md", "# Rev\n");
    const fleet = await runFleetMigrate({
      configPath,
      migrations: [migration],
      validateFn: async (cp, n) => {
        // Fail the first validation call against the tenant's configPath
        if (cp !== configPath && n === 1) throw new Error("tenant validation broken");
      },
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
    });

    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("reverted");
    // File should be reverted (deleted since it didn't exist before)
    expect(existsSync(join(childDir, "prompts/revert-me.md"))).toBe(false);
  });

  test("multiple tenants: some skipped, some migrated, all processed", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const cleanDir = makeTempDir();
    const dirtyDir = makeTempDir();
    scaffoldDeployment(cleanDir);
    scaffoldDeployment(dirtyDir);

    const migration = makeTenantMigration("t-multi", "prompts/multi.md", "# Multi\n");
    const fleet = await runFleetMigrate({
      configPath,
      migrations: [migration],
      validateFn: async () => {},
      isDirtyFn: (d) => d === dirtyDir,
      enumerateFn: fakeEnumerate([
        makeTenant(cleanDir, "acme/clean"),
        makeTenant(dirtyDir, "acme/dirty"),
      ]),
    });

    expect(fleet.tenantEntries).toHaveLength(2);
    const cleanEntry = fleet.tenantEntries.find((e) => e.slug === "acme/clean")!;
    const dirtyEntry = fleet.tenantEntries.find((e) => e.slug === "acme/dirty")!;
    expect(cleanEntry.verdict).toBe("migrated");
    expect(dirtyEntry.verdict).toBe("skipped");
  });

  test("null enumeration (workspace block missing despite role detection) → empty tenants", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);

    const fleet = await runFleetMigrate({
      configPath,
      migrations: [],
      validateFn: async () => {},
      isDirtyFn: () => false,
      enumerateFn: async () => null,
    });

    expect(fleet.tenantEntries).toHaveLength(0);
  });
});

// ----------------------------------------------------------------- formatFleetMigrateReport

describe("formatFleetMigrateReport", () => {
  function makeFleetReport(overrides?: Partial<FleetMigrateReport>): FleetMigrateReport {
    return {
      rootReport: {
        sha: "abc123def456789",
        dir: "/deployments/root",
        results: [],
        journal: [],
        ok: true,
      },
      rootRole: "workspace-root",
      tenantEntries: [],
      ...overrides,
    };
  }

  test("header contains sha slice", () => {
    const out = formatFleetMigrateReport(makeFleetReport());
    expect(out).toContain("[phoebe] migrate — abc123def456");
  });

  test("root section shows directory", () => {
    const out = formatFleetMigrateReport(makeFleetReport());
    expect(out).toContain("root (/deployments/root):");
  });

  test("tenant section shows verdicts with correct marks", () => {
    const out = formatFleetMigrateReport(
      makeFleetReport({
        tenantEntries: [
          {
            dir: "/d/c1",
            slug: "acme/c1",
            verdict: "migrated",
            report: { sha: null, dir: "/d/c1", results: [], journal: [], ok: true },
          },
          {
            dir: "/d/c2",
            slug: "acme/c2",
            verdict: "up-to-date",
            report: { sha: null, dir: "/d/c2", results: [], journal: [], ok: true },
          },
          {
            dir: "/d/c3",
            slug: "acme/c3",
            verdict: "skipped",
            reason: "commit or stash, then re-run",
          },
          {
            dir: "/d/c4",
            slug: "acme/c4",
            verdict: "failed",
            report: {
              sha: null,
              dir: "/d/c4",
              results: [{ id: "x", state: "failed", detail: "boom" }],
              journal: [],
              ok: false,
            },
          },
          {
            dir: "/d/c5",
            slug: "acme/c5",
            verdict: "invalid",
            report: { sha: null, dir: "/d/c5", results: [], journal: [], ok: true },
          },
        ],
      }),
    );
    expect(out).toContain("✓ migrated");
    expect(out).toContain("✓ up-to-date");
    expect(out).toContain("— skipped");
    expect(out).toContain("✗ failed");
    expect(out).toContain("⚠ invalid");
    expect(out).toContain("commit or stash, then re-run");
  });

  test("uncommitted listing grouped by dir with per-dir review command", () => {
    const out = formatFleetMigrateReport(
      makeFleetReport({
        rootReport: {
          sha: "abc",
          dir: "/root",
          results: [],
          journal: [{ dir: "/root", migrationId: "r1", relPath: "root-file.md", before: null }],
          ok: true,
        },
        tenantEntries: [
          {
            dir: "/child",
            slug: "acme/child",
            verdict: "migrated",
            report: {
              sha: null,
              dir: "/child",
              results: [],
              journal: [
                { dir: "/child", migrationId: "t1", relPath: "child-file.md", before: null },
              ],
              ok: true,
            },
          },
        ],
      }),
    );
    expect(out).toContain("uncommitted paths Phoebe wrote:");
    expect(out).toContain("/root:");
    expect(out).toContain("    root-file.md");
    expect(out).toContain("review: git -C /root diff -- root-file.md");
    expect(out).toContain("/child:");
    expect(out).toContain("    child-file.md");
    expect(out).toContain("review: git -C /child diff -- child-file.md");
    expect(out).toContain("Phoebe never commits");
  });

  test("no uncommitted section when no journal entries", () => {
    const out = formatFleetMigrateReport(makeFleetReport());
    expect(out).not.toContain("uncommitted");
    expect(out).not.toContain("Phoebe never commits");
  });

  test("pending verdict shows ~ mark", () => {
    const out = formatFleetMigrateReport(
      makeFleetReport({
        tenantEntries: [
          {
            dir: "/d/c1",
            slug: "acme/c1",
            verdict: "pending",
            report: {
              sha: null,
              dir: "/d/c1",
              results: [{ id: "m1", state: "applicable", detail: "would scaffold" }],
              journal: [],
              ok: true,
            },
          },
        ],
      }),
    );
    expect(out).toContain("~ pending");
    expect(out).toContain("Note:");
  });

  test("dependent caveat absent when no applicable migrations in fleet", () => {
    const out = formatFleetMigrateReport(makeFleetReport());
    expect(out).not.toContain("Note:");
  });

  test("dependent caveat present when root has applicable migrations", () => {
    const out = formatFleetMigrateReport(
      makeFleetReport({
        rootReport: {
          sha: null,
          dir: "/root",
          results: [{ id: "r1", state: "applicable", detail: "would do something" }],
          journal: [],
          ok: true,
        },
      }),
    );
    expect(out).toContain("Note:");
    expect(out).toContain("1 applicable");
  });
});

// ----------------------------------------------------------------- runFleetMigrate check mode

describe("runFleetMigrate check mode", () => {
  test("solo-root check: applicable migration reports applicable, nothing written", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const migration = makeApplyingMigration("chk-solo", "prompts/chk.md", "# Chk\n");
    const fleet = await runFleetMigrate({
      configPath,
      migrations: [migration],
      validateFn: async () => {},
      check: true,
    });
    expect(fleet.rootRole).toBe("solo-root");
    expect(fleet.rootReport.results[0]!.state).toBe("applicable");
    expect(fleet.rootReport.journal).toHaveLength(0);
    expect(existsSync(join(dir, "prompts/chk.md"))).toBe(false);
  });

  test("workspace check: tenant with applicable migration gets 'pending' verdict", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const migration = makeTenantMigration("t-chk", "prompts/t.md", "# T\n");
    const fleet = await runFleetMigrate({
      configPath,
      migrations: [migration],
      validateFn: async () => {},
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
      check: true,
    });

    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("pending");
    expect(entry.report?.results[0]?.state).toBe("applicable");
    expect(entry.report?.journal).toHaveLength(0);
    expect(existsSync(join(childDir, "prompts/t.md"))).toBe(false);
  });

  test("workspace check: tenant with no applicable migrations gets 'up-to-date' verdict", async () => {
    const rootDir = makeTempDir();
    const configPath = scaffoldWorkspaceRoot(rootDir);
    const childDir = makeTempDir();
    scaffoldDeployment(childDir);

    const fleet = await runFleetMigrate({
      configPath,
      migrations: [],
      validateFn: async () => {},
      isDirtyFn: () => false,
      enumerateFn: fakeEnumerate([makeTenant(childDir)]),
      check: true,
    });

    const entry = fleet.tenantEntries[0]!;
    expect(entry.verdict).toBe("up-to-date");
  });
});

// ----------------------------------------------------------------- full-stack integration

describe("runMigrate with real research prompt migration", () => {
  test("solo deployment missing research-prompt.md gets it scaffolded", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    // prompts/ directory exists but research-prompt.md does not
    mkdirSync(join(dir, "prompts"), { recursive: true });

    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [researchPromptMigration],
    });

    expect(report.results[0]!.state).toBe("applied");
    expect(existsSync(join(dir, "prompts/research-prompt.md"))).toBe(true);
    expect(report.journal[0]!.relPath).toBe("prompts/research-prompt.md");
    expect(report.ok).toBe(true);
  });

  test("re-run is idempotent: not-applicable, nothing written", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    mkdirSync(join(dir, "prompts"), { recursive: true });

    await runMigrate({ dir, role: "solo-root", configPath, migrations: [researchPromptMigration] });

    const second = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [researchPromptMigration],
    });

    expect(second.results[0]!.state).toBe("not-applicable");
    expect(second.journal).toHaveLength(0);
    expect(second.ok).toBe(true);
  });
});
