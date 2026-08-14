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
import { ConfigRefusal, isConfigRefusal } from "./config-handle.ts";
import { researchPromptMigration } from "./migrations/m001-research-prompt.ts";
import { addResearchToWorkOrderMigration } from "./migrations/m002-add-research-to-workorder.ts";
import {
  formatMigrateReport,
  parseMigrateArgs,
  runMigrate,
  type Migration,
  type MigrateReport,
} from "./migrate.ts";

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
    expect(parseMigrateArgs([])).toEqual({ configPath: undefined, help: false });
  });

  test("--help and -h set help", () => {
    expect(parseMigrateArgs(["--help"]).help).toBe(true);
    expect(parseMigrateArgs(["-h"]).help).toBe(true);
  });

  test("--config <path>", () => {
    expect(parseMigrateArgs(["--config", "my.config.ts"])).toEqual({
      configPath: "my.config.ts",
      help: false,
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
    const staged = researchPromptMigration.apply(dir, data, readFile) as Record<string, string>;
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
    const staged = researchPromptMigration.apply("", true, () => null) as Record<string, string>;
    const content = staged["prompts/research-prompt.md"]!;
    expect(content.length).toBeGreaterThan(10);
  });
});

// ----------------------------------------------------------------- ConfigRefusal → manual state

/** A migration whose apply() returns a ConfigRefusal. */
function makeRefusingMigration(id: string): Migration {
  return {
    id,
    title: `Refusing migration ${id}`,
    appliesTo: ["solo-root"] as const,
    detect() {
      return true;
    },
    describe() {
      return "do something";
    },
    apply() {
      return new ConfigRefusal("add the field manually in phoebe.config.ts");
    },
  };
}

describe("runMigrate — ConfigRefusal", () => {
  test("ConfigRefusal from apply → manual state, no file written, ok=true", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeRefusingMigration("config-refusal")],
      validateFn: async () => {},
    });
    const result = report.results[0]!;
    expect(result.state).toBe("manual");
    expect(result.detail).toContain("add the field manually");
    // The journal is empty — no files were written
    expect(report.journal).toHaveLength(0);
    // ok=true: manual is not a failure
    expect(report.ok).toBe(true);
  });

  test("manual result does not halt remaining migrations", async () => {
    const dir = makeTempDir();
    const configPath = scaffoldDeployment(dir);
    const afterMigration: Migration = {
      id: "after-refusal",
      title: "After",
      appliesTo: ["solo-root"] as const,
      detect() {
        return true;
      },
      describe() {
        return "scaffold after.md";
      },
      apply() {
        return { "after.md": "# After\n" };
      },
    };
    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [makeRefusingMigration("first"), afterMigration],
      validateFn: async () => {},
    });
    expect(report.results).toHaveLength(2);
    expect(report.results[0]!.state).toBe("manual");
    expect(report.results[1]!.state).toBe("applied");
    expect(report.ok).toBe(true);
  });

  test("manual result shows ! mark in formatted report", () => {
    const report: MigrateReport = {
      sha: null,
      dir: "/tmp/x",
      results: [{ id: "cfg-refusal", state: "manual", detail: "add it by hand" }],
      journal: [],
      ok: true,
    };
    const out = formatMigrateReport(report);
    expect(out).toContain("!");
    expect(out).toContain("cfg-refusal");
    expect(out).toContain("add it by hand");
    expect(out).toContain("1 manual");
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

// ----------------------------------------------------------------- m002 idempotence

const CONFIG_WITH_EXPLICIT_WORK_ORDER = `export const config = {
  repoSlug: "acme/test",
  repoUrl: "https://github.com/acme/test.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  workOrder: ["conflicts", "checks", "reviews", "issues"],
};
`;

describe("m002 addResearchToWorkOrderMigration: detect → apply → detect returns null", () => {
  test("detect returns non-null when workOrder lacks research, null after apply writes it", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "phoebe.config.ts"), CONFIG_WITH_EXPLICIT_WORK_ORDER);

    const readFile = (relPath: string): string | null => {
      try {
        return readFileSync(join(dir, relPath), "utf8");
      } catch {
        return null;
      }
    };

    // 1. detect: applicable
    const data = addResearchToWorkOrderMigration.detect(dir, readFile);
    expect(data).not.toBeNull();

    // 2. apply: get staged writes (not a refusal)
    const result = addResearchToWorkOrderMigration.apply(dir, data, readFile);
    expect(isConfigRefusal(result)).toBe(false);
    const staged = result as Record<string, string>;
    expect(staged).toHaveProperty("phoebe.config.ts");
    const newContent = staged["phoebe.config.ts"]!;
    expect(newContent).toContain('"research"');
    // Surrounding content is preserved
    expect(newContent).toContain("repoSlug");
    expect(newContent).toContain('"conflicts"');

    // flush
    writeFileSync(join(dir, "phoebe.config.ts"), newContent);

    // 3. detect again → null (not-applicable)
    expect(addResearchToWorkOrderMigration.detect(dir, readFile)).toBeNull();
  });

  test("detect returns null when no explicit workOrder (default includes research)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "phoebe.config.ts"), MINIMAL_CONFIG);

    const readFile = (relPath: string): string | null => {
      try {
        return readFileSync(join(dir, relPath), "utf8");
      } catch {
        return null;
      }
    };
    expect(addResearchToWorkOrderMigration.detect(dir, readFile)).toBeNull();
  });

  test("detect returns null when workOrder already contains research", () => {
    const dir = makeTempDir();
    const content = MINIMAL_CONFIG.replace("};", '  workOrder: ["conflicts", "research"],\n};');
    writeFileSync(join(dir, "phoebe.config.ts"), content);

    const readFile = (relPath: string): string | null => {
      try {
        return readFileSync(join(dir, relPath), "utf8");
      } catch {
        return null;
      }
    };
    expect(addResearchToWorkOrderMigration.detect(dir, readFile)).toBeNull();
  });

  test("detect returns null when config file absent", () => {
    const dir = makeTempDir();
    const readFile = (): null => null;
    expect(addResearchToWorkOrderMigration.detect(dir, readFile)).toBeNull();
  });

  test("apply returns ConfigRefusal for dynamic workOrder", () => {
    // Config with a computed workOrder (spread) — cannot be rewritten automatically
    const dynamicContent = MINIMAL_CONFIG.replace(
      "};",
      '  workOrder: [...BASE_ORDER, "checks"],\n};',
    );
    const result = addResearchToWorkOrderMigration.apply("", dynamicContent, () => null);
    expect(isConfigRefusal(result)).toBe(true);
    const refusal = result as import("./config-handle.ts").ConfigRefusal;
    expect(refusal.instruction).toContain("research");
    expect(refusal.instruction).toContain("phoebe.config.ts");
  });

  test("appliesTo includes all three deployment roles", () => {
    expect(addResearchToWorkOrderMigration.appliesTo).toContain("solo-root");
    expect(addResearchToWorkOrderMigration.appliesTo).toContain("workspace-root");
    expect(addResearchToWorkOrderMigration.appliesTo).toContain("tenant");
  });

  test("runMigrate applies m002 and journals phoebe.config.ts", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "phoebe.config.ts"), CONFIG_WITH_EXPLICIT_WORK_ORDER);

    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath: join(dir, "phoebe.config.ts"),
      migrations: [addResearchToWorkOrderMigration],
      validateFn: async () => {},
    });

    expect(report.results[0]!.state).toBe("applied");
    expect(report.journal[0]!.relPath).toBe("phoebe.config.ts");
    expect(report.journal[0]!.before).toBe(CONFIG_WITH_EXPLICIT_WORK_ORDER);
    const written = readFileSync(join(dir, "phoebe.config.ts"), "utf8");
    expect(written).toContain('"research"');
    expect(report.ok).toBe(true);
  });

  test("runMigrate: m002 not-applicable on second run (idempotent)", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "phoebe.config.ts"), CONFIG_WITH_EXPLICIT_WORK_ORDER);
    const configPath = join(dir, "phoebe.config.ts");

    await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [addResearchToWorkOrderMigration],
      validateFn: async () => {},
    });

    const second = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [addResearchToWorkOrderMigration],
      validateFn: async () => {},
    });

    expect(second.results[0]!.state).toBe("not-applicable");
    expect(second.journal).toHaveLength(0);
  });

  test("runMigrate: m002 reports manual when workOrder is dynamic, config unchanged", async () => {
    const dynamicContent = MINIMAL_CONFIG.replace(
      "};",
      '  workOrder: [...BASE_ORDER, "checks"],\n};',
    );
    const dir = makeTempDir();
    writeFileSync(join(dir, "phoebe.config.ts"), dynamicContent);
    const configPath = join(dir, "phoebe.config.ts");

    const report = await runMigrate({
      dir,
      role: "solo-root",
      configPath,
      migrations: [addResearchToWorkOrderMigration],
      validateFn: async () => {},
    });

    expect(report.results[0]!.state).toBe("manual");
    expect(report.results[0]!.detail).toContain("research");
    // Config is left unmodified on disk
    expect(readFileSync(configPath, "utf8")).toBe(dynamicContent);
    expect(report.journal).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});
