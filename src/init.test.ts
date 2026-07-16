// Init scaffolder contract:
//   * plan enumerates every consumer-owned file (prompts derived from
//     `CONFIG_DEFAULTS.promptFiles` so drift is impossible),
//   * template rendering substitutes every `{{TOKEN}}` and throws on unknowns,
//   * `.gitignore` merges are additive (no dedup gap, no clobber),
//   * `runInit` never overwrites an existing file (the guarded-re-run
//     acceptance criterion).

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { CONFIG_DEFAULTS } from "./config-schema.ts";
import {
  DEFAULT_TEMPLATE_PARAMS,
  formatInitReport,
  mergeGitignore,
  planInitOutputs,
  renderTemplate,
  runInit,
} from "./init.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "phoebe-init-test-"));
}

describe("planInitOutputs", () => {
  test("scaffolds config, env example, four container files, four prompts, gitignore", () => {
    const plan = planInitOutputs();
    const dests = plan.map((p) => p.destRelPath);
    expect(dests).toContain("phoebe.config.ts");
    expect(dests).toContain(".env.example");
    expect(dests).toContain("container/Dockerfile");
    expect(dests).toContain("container/compose.yml");
    expect(dests).toContain("container/compose.daemon.yml");
    expect(dests).toContain("container/supervisor.sh");
    expect(dests).toContain(".gitignore");
    for (const promptPath of Object.values(CONFIG_DEFAULTS.promptFiles)) {
      expect(dests).toContain(promptPath);
    }
  });

  test("supervisor.sh is marked executable", () => {
    const supervisor = planInitOutputs().find((p) => p.destRelPath === "container/supervisor.sh");
    expect(supervisor?.source.kind).toBe("template");
    if (supervisor?.source.kind === "template") {
      expect(supervisor.source.executable).toBe(true);
    }
  });
});

describe("renderTemplate", () => {
  test("substitutes {{INSTALL_COMMAND}} and {{CLI_BIN}}", () => {
    const out = renderTemplate("run {{INSTALL_COMMAND}} then {{CLI_BIN}}", {
      installCommand: "pnpm i",
      cliBin: "phoebe-agent",
    });
    expect(out).toBe("run pnpm i then phoebe-agent");
  });

  test("throws on an unknown {{TOKEN}}", () => {
    expect(() => renderTemplate("hello {{UNKNOWN}}", DEFAULT_TEMPLATE_PARAMS)).toThrow(/UNKNOWN/);
  });

  test("substitutes all occurrences of a token", () => {
    const out = renderTemplate("{{CLI_BIN}} and {{CLI_BIN}}", DEFAULT_TEMPLATE_PARAMS);
    expect(out).toBe("phoebe-agent and phoebe-agent");
  });
});

describe("mergeGitignore", () => {
  test("creates a bare list when no existing content", () => {
    const merged = mergeGitignore("", [".env", "node_modules/"]);
    expect(merged).toBe(".env\nnode_modules/\n");
  });

  test("appends missing entries under a Phoebe header when the file has content", () => {
    const merged = mergeGitignore("dist/\n", [".env", "node_modules/"]);
    expect(merged).toBe("dist/\n\n# Phoebe\n.env\nnode_modules/\n");
  });

  test("does not duplicate entries that already exist elsewhere", () => {
    const merged = mergeGitignore("dist/\nnode_modules/\n", [".env", "node_modules/"]);
    expect(merged).toBe("dist/\nnode_modules/\n\n# Phoebe\n.env\n");
  });

  test("returns input unchanged when every entry already present", () => {
    const existing = ".env\nnode_modules/\n";
    expect(mergeGitignore(existing, [".env", "node_modules/"])).toBe(existing);
  });

  test("handles a missing trailing newline on existing content", () => {
    const merged = mergeGitignore("dist/", [".env"]);
    expect(merged).toBe("dist/\n\n# Phoebe\n.env\n");
  });
});

describe("runInit", () => {
  test("writes every planned file into an empty directory", () => {
    const target = makeTempDir();
    const report = runInit({ targetDir: target });

    for (const output of planInitOutputs()) {
      const abs = join(target, output.destRelPath);
      expect(statSync(abs).isFile()).toBe(true);
    }
    expect(report.skipped).toEqual([]);
    // .gitignore is "created" (empty existing) rather than "updated".
    expect(report.created).toContain(".gitignore");
    expect(report.created).toContain("phoebe.config.ts");
    expect(report.created).toContain("container/Dockerfile");
    expect(report.updated).toEqual([]);
  });

  test("supervisor.sh is written with the executable bit set", () => {
    const target = makeTempDir();
    runInit({ targetDir: target });
    const mode = statSync(join(target, "container/supervisor.sh")).mode & 0o777;
    expect(mode & 0o100).toBe(0o100); // owner-executable
  });

  test("Dockerfile pins the supervisor into ENTRYPOINT so compose command: overrides append flags", () => {
    // Compose's `command:` replaces `CMD` outright. If the Dockerfile split
    // the supervisor across ENTRYPOINT + CMD, `command: ["--run-once"]` in
    // compose.yml would exec `tini -- --run-once` (no valid child program)
    // and the container would fail to boot. Lock the invariant.
    const target = makeTempDir();
    runInit({ targetDir: target });
    const dockerfile = readFileSync(join(target, "container/Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/phoebe-supervisor"]',
    );
    expect(dockerfile).toContain("CMD []");
  });

  test("renders {{INSTALL_COMMAND}} and {{CLI_BIN}} into scaffolded files", () => {
    const target = makeTempDir();
    runInit({
      targetDir: target,
      params: { installCommand: "pnpm i", cliBin: "phoebe-agent" },
    });
    const dockerfile = readFileSync(join(target, "container/Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).toContain(`installCommand: "pnpm i"`);
    expect(config).toContain(`from "phoebe-agent"`);
  });

  test("does not overwrite existing files on re-run", () => {
    const target = makeTempDir();
    runInit({ targetDir: target });

    // Simulate consumer edits to two scaffolded files.
    const editedConfigContents = "// EDITED BY CONSUMER\nexport default {};\n";
    writeFileSync(join(target, "phoebe.config.ts"), editedConfigContents);
    const editedSupervisor = "#!/usr/bin/env bash\necho hi\n";
    writeFileSync(join(target, "container/supervisor.sh"), editedSupervisor);

    const report = runInit({ targetDir: target });

    expect(readFileSync(join(target, "phoebe.config.ts"), "utf8")).toBe(editedConfigContents);
    expect(readFileSync(join(target, "container/supervisor.sh"), "utf8")).toBe(editedSupervisor);
    expect(report.skipped).toContain("phoebe.config.ts");
    expect(report.skipped).toContain("container/supervisor.sh");
    expect(report.created).toEqual([]);
  });

  test("appends new gitignore entries without touching existing ones", () => {
    const target = makeTempDir();
    writeFileSync(join(target, ".gitignore"), "dist/\n");
    const report = runInit({ targetDir: target });
    const gitignore = readFileSync(join(target, ".gitignore"), "utf8");
    expect(gitignore.startsWith("dist/\n")).toBe(true);
    expect(gitignore).toContain(".env");
    expect(report.updated).toContain(".gitignore");
    expect(report.created).not.toContain(".gitignore");
  });

  test("creates the target directory when it does not exist", () => {
    const parent = makeTempDir();
    const target = join(parent, "nested/deeper");
    runInit({ targetDir: target });
    expect(statSync(join(target, "phoebe.config.ts")).isFile()).toBe(true);
  });

  test("scaffolded prompt files match the shipped templates verbatim", () => {
    const target = makeTempDir();
    runInit({ targetDir: target });
    // If this test needs a fixture package root someday, plumb `packageRoot`.
    // For now the walk-up finds the repo's own prompts/ from src/.
    const scaffolded = readFileSync(join(target, "prompts/prompt.md"), "utf8");
    expect(scaffolded).toContain("{{ISSUE_NUMBER}}");
    expect(scaffolded).toContain("Phoebe");
  });
});

describe("formatInitReport", () => {
  test("lists created / updated / skipped sections and a re-run hint", () => {
    const rendered = formatInitReport({ created: ["a"], updated: ["b"], skipped: ["c"] }, "/tmp/x");
    expect(rendered).toContain("/tmp/x");
    expect(rendered).toContain("created");
    expect(rendered).toContain("updated");
    expect(rendered).toContain("skipped");
    expect(rendered).toContain("Delete them");
  });

  test("omits sections with no entries", () => {
    const rendered = formatInitReport({ created: ["a"], updated: [], skipped: [] }, "/tmp/x");
    expect(rendered).toContain("created");
    expect(rendered).not.toContain("updated:");
    expect(rendered).not.toContain("skipped");
  });
});
