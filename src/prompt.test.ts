import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeUserConfig } from "./config-schema.ts";
import { buildRegistry } from "./work-kinds/registry.ts";
import {
  assertPromptFilesExist as assertPromptFilesExistRaw,
  buildDefaultPromptArgs,
  loadPromptTemplate,
  renderPrompt,
  resolvePromptFile,
  substitutePromptArgs,
} from "./prompt.ts";

function minimalUser(): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    readyCommand: "npm run ready",
  };
}

function fixtureConfig(): ReturnType<typeof resolveConfig> {
  return resolveConfig(minimalUser());
}

/**
 * The engine's boot check, driven the way `runEngine` drives it: the scheduled
 * kinds paired with their definition-owned prompt paths — which for built-ins
 * come from the tenant's `promptFiles` keys.
 */
function assertPromptFilesExist(
  config: ReturnType<typeof resolveConfig>,
  runtimeRoot: string,
): void {
  const registry = buildRegistry(config);
  assertPromptFilesExistRaw({
    repoSlug: config.repoSlug,
    runtimeRoot,
    kinds: config.workOrder.map((kind) => ({
      name: kind,
      promptFile: registry.get(kind)!.definition.promptFile,
    })),
  });
}

describe("substitutePromptArgs", () => {
  test("replaces {{KEY}} placeholders, with or without inner spaces", () => {
    const out = substitutePromptArgs("issue {{ISSUE_NUMBER}} / {{ ISSUE_NUMBER }}", {
      ISSUE_NUMBER: "7",
    });
    expect(out).toContain("issue 7 / 7");
  });

  test("throws on a placeholder with no value", () => {
    expect(() => substitutePromptArgs("{{MISSING}}", {})).toThrow(/MISSING/);
  });
});

describe("renderPrompt", () => {
  test("executes template shell blocks and splices trimmed stdout", () => {
    const executed: string[] = [];
    const out = renderPrompt("Context:\n\n!`gh issue view {{N}}`\n\nDone.", { N: "12" }, (cmd) => {
      executed.push(cmd);
      return "issue body\n";
    });
    expect(executed).toEqual(["gh issue view 12"]);
    expect(out).toBe("Context:\n\nissue body\n\nDone.");
  });

  test("shell patterns arriving via substituted values are data, not commands", () => {
    const executed: string[] = [];
    const out = renderPrompt("Body: {{BODY}}", { BODY: "try !`rm -rf /` ok" }, (cmd) => {
      executed.push(cmd);
      return "ran";
    });
    expect(executed).toEqual([]);
    expect(out).toBe("Body: try !`rm -rf /` ok");
  });
});

describe("buildDefaultPromptArgs", () => {
  test("derives every toolchain/label placeholder from the resolved config", () => {
    const args = buildDefaultPromptArgs(fixtureConfig());
    expect(args).toMatchObject({
      INSTALL_COMMAND: "npm ci",
      CHECK_COMMAND: "npm run check",
      TEST_COMMAND: "npm test",
      READY_COMMAND: "npm run ready",
      DEFAULT_BRANCH: "main",
      // The base of the PR under work. Defaults to the default branch so an
      // override written before #392 still renders; conflicts overrides it.
      BASE_BRANCH: "main",
      BRANCH_PREFIX: "phoebe/",
      READY_LABEL: "ready-for-agent",
      PROCESSING_LABEL: "processing",
      REVIEWS_SUCCESS_HEADING: "## Review feedback addressed",
    });
  });
});

describe("shipped default prompts", () => {
  const promptsDir = join(import.meta.dirname, "..", "prompts");

  const cases = [
    { file: "issues-prompt.md", extra: { ISSUE_NUMBER: "42", PR_BASE: "main" } },
    {
      file: "conflict-prompt.md",
      extra: { PR_NUMBER: "12", PR_BRANCH: "phoebe/issue-42", BLOCKER_PR_NUMBERS: "" },
    },
    {
      file: "checks-prompt.md",
      extra: { PR_NUMBER: "12", PR_BRANCH: "phoebe/issue-42", FAILING_CHECKS: "- ci: FAILURE" },
    },
    { file: "reviews-prompt.md", extra: { PR_NUMBER: "12", PR_BRANCH: "phoebe/issue-42" } },
  ] as const;

  test.each(cases)(
    "$file renders end-to-end with default args + per-callsite args",
    ({ file, extra }) => {
      const template = readFileSync(join(promptsDir, file), "utf8");
      const args = { ...buildDefaultPromptArgs(fixtureConfig()), ...extra };
      // execShell is a stub — no shell blocks should reach the real shell during
      // this render, so returning empty text is fine.
      const out = renderPrompt(template, args, () => "");
      expect(out, `${file} left an unsubstituted placeholder`).not.toMatch(/\{\{[A-Za-z_]/);
    },
  );

  test("issues-prompt.md references the toolchain via placeholders, not literals", () => {
    const template = readFileSync(join(promptsDir, "issues-prompt.md"), "utf8");
    expect(template).toContain("{{READY_COMMAND}}");
    expect(template).toContain("{{CHECK_COMMAND}}");
    expect(template).toContain("{{TEST_COMMAND}}");
    // The PR base is per-callsite, not the default branch literal: stacked work
    // targets the blocker's branch (#311).
    expect(template).toContain("{{PR_BASE}}");
  });

  test("checks + conflict prompts document the baseline-breakage branch", () => {
    // Each prompt names the branch its own work reconciles against: `checks`
    // reasons about breakage on the default branch, `conflicts` about the PR's
    // own base, which for a feature member is the feature branch (#392).
    for (const [file, branchPlaceholder] of [
      ["checks-prompt.md", "{{DEFAULT_BRANCH}}"],
      ["conflict-prompt.md", "{{BASE_BRANCH}}"],
    ]) {
      const template = readFileSync(join(promptsDir, file), "utf8");
      // A baseline check against a clean checkout of that branch.
      expect(template, `${file} should describe a baseline check`).toMatch(/baseline/i);
      expect(template).toContain(branchPlaceholder);
      // The reconciliation rule: a green check gate does not clear a red test
      // suite unless every red test is baseline-only.
      expect(template).toContain("{{CHECK_COMMAND}}");
      expect(template).toContain("{{TEST_COMMAND}}");
      expect(template, `${file} should carry the reconciliation rule`).toMatch(/baseline-only/);
      // Guidance to open/link a tracking issue rather than silently proceeding.
      expect(template, `${file} should point at a tracking issue`).toMatch(/gh issue create/);
    }
  });

  test("the conflict prompt names the PR base, never the default branch", () => {
    // Every merge instruction in this prompt is against the PR's own base. A
    // stray {{DEFAULT_BRANCH}} would tell a feature member's agent to merge
    // `main` — the merge GitHub never reported a conflict against (#392).
    const template = readFileSync(join(promptsDir, "conflict-prompt.md"), "utf8");
    expect(template).not.toContain("{{DEFAULT_BRANCH}}");
  });

  test("reviews prompt is self-contained (no external skill dependency)", () => {
    const template = readFileSync(join(promptsDir, "reviews-prompt.md"), "utf8");
    expect(template).not.toMatch(/handle-pr-review/);
    expect(template).not.toMatch(/\.claude\/skills\//);
    // The prompt should carry its own workflow, so a few landmark steps live
    // inline rather than being delegated.
    expect(template).toMatch(/reviewThreads/);
    expect(template).toMatch(/resolveReviewThread/);
    expect(template).toContain("{{REVIEWS_SUCCESS_HEADING}}");
  });
});

describe("resolvePromptFile / loadPromptTemplate", () => {
  test("resolves a consumer override from the runtime root, not the installed package", () => {
    // Consumer-style layout: runtime root has an override path; a same-named
    // file also exists under a fake node_modules package tree. Resolution must
    // use the runtime-root copy (compose mounts prompts at /etc/phoebe, while
    // the engine package lives elsewhere under node_modules).
    const runtimeRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-runtime-"));
    const packageRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-pkg-"));
    mkdirSync(join(runtimeRoot, "prompts"), { recursive: true });
    mkdirSync(join(packageRoot, "node_modules", "phoebe-agent", "prompts"), { recursive: true });
    writeFileSync(join(runtimeRoot, "prompts", "issues-prompt.md"), "runtime-root override\n");
    writeFileSync(
      join(packageRoot, "node_modules", "phoebe-agent", "prompts", "issues-prompt.md"),
      "packaged default — must not win\n",
    );

    const resolved = resolvePromptFile("prompts/issues-prompt.md", runtimeRoot);
    expect(resolved).toBe(resolve(runtimeRoot, "prompts/issues-prompt.md"));
    expect(loadPromptTemplate("prompts/issues-prompt.md", runtimeRoot)).toBe(
      "runtime-root override\n",
    );
  });

  test("loads a custom promptFiles override path under the runtime root", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-override-"));
    mkdirSync(join(runtimeRoot, "custom"), { recursive: true });
    writeFileSync(join(runtimeRoot, "custom", "issue.md"), "custom issue prompt\n");

    expect(loadPromptTemplate("custom/issue.md", runtimeRoot)).toBe("custom issue prompt\n");
  });

  test("throws when the path is missing from the runtime root", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-missing-"));
    expect(() => resolvePromptFile("prompts/missing.md", runtimeRoot)).toThrow(
      /Could not find prompt file prompts\/missing\.md/,
    );
  });

  test("rejects a directory at the prompt path, rather than reading it", () => {
    // A directory satisfies "exists" but not "can be loaded" — `readFileSync`
    // would throw EISDIR at dispatch, which is the fail-at-use mode the startup
    // check exists to remove.
    const runtimeRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-dir-"));
    mkdirSync(join(runtimeRoot, "prompts", "issues-prompt.md"), { recursive: true });

    expect(() => resolvePromptFile("prompts/issues-prompt.md", runtimeRoot)).toThrow(
      /Could not find prompt file prompts\/issues-prompt\.md/,
    );
  });
});

describe("assertPromptFilesExist", () => {
  /** A runtime root holding `prompts/<name>` for each name given. */
  function runtimeRootWith(names: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), "phoebe-prompt-assert-"));
    mkdirSync(join(root, "prompts"), { recursive: true });
    for (const name of names) writeFileSync(join(root, "prompts", name), `# ${name}\n`);
    return root;
  }

  const ALL_PROMPTS = [
    "issues-prompt.md",
    "conflict-prompt.md",
    "checks-prompt.md",
    "reviews-prompt.md",
    "research-prompt.md",
  ];

  test("passes when every promptFiles entry resolves", () => {
    const runtimeRoot = runtimeRootWith(ALL_PROMPTS);
    expect(() => assertPromptFilesExist(fixtureConfig(), runtimeRoot)).not.toThrow();
  });

  test("only checks the kinds this tenant's workOrder actually runs", () => {
    // A tenant that dropped `research` from `workOrder` never dispatches a
    // research unit, so it has no research prompt to be missing — refusing to
    // boot over one would be a new failure, not a caught one.
    const runtimeRoot = runtimeRootWith(ALL_PROMPTS.filter((n) => n !== "research-prompt.md"));
    const config = resolveConfig({
      ...minimalUser(),
      workOrder: ["conflicts", "checks", "reviews", "issues"],
    });

    expect(() => assertPromptFilesExist(config, runtimeRoot)).not.toThrow();
    // …and the same runtime root still fails for a tenant that does run it.
    expect(() => assertPromptFilesExist(fixtureConfig(), runtimeRoot)).toThrow(/research/);
  });

  test("names the tenant, every missing kind, and each resolved path", () => {
    // The #164 shape: a hand-copied asset dir that never got the prompt kinds
    // added after it was copied. All of them are reported in one throw, so one
    // boot tells you the whole list instead of one kind per re-run.
    const runtimeRoot = runtimeRootWith(["issues-prompt.md", "conflict-prompt.md"]);

    let message = "";
    try {
      assertPromptFilesExist(fixtureConfig(), runtimeRoot);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("acme/widget");
    expect(message).toContain("checks");
    expect(message).toContain("reviews");
    expect(message).toContain("research");
    expect(message).toContain(resolve(runtimeRoot, "prompts/research-prompt.md"));
    expect(message).not.toContain("issues-prompt.md");
  });

  test("accepts an entry that escapes the runtime root, as long as it exists", () => {
    // What `configDir` deployments need (#98/#164): the engine child's cwd is
    // `<repo>/.phoebe`, and its prompts are the repo's own `prompts/` one level
    // up. Existence is the rule, not containment.
    const repo = runtimeRootWith(ALL_PROMPTS);
    const runtimeRoot = join(repo, ".phoebe");
    mkdirSync(runtimeRoot, { recursive: true });
    const config = resolveConfig({
      ...minimalUser(),
      promptFiles: {
        issue: "../prompts/issues-prompt.md",
        conflict: "../prompts/conflict-prompt.md",
        checks: "../prompts/checks-prompt.md",
        reviews: "../prompts/reviews-prompt.md",
        research: "../prompts/research-prompt.md",
      },
    });

    expect(() => assertPromptFilesExist(config, runtimeRoot)).not.toThrow();
  });

  test("counts a directory at a prompt path as missing", () => {
    const runtimeRoot = runtimeRootWith(ALL_PROMPTS.filter((n) => n !== "checks-prompt.md"));
    mkdirSync(join(runtimeRoot, "prompts", "checks-prompt.md"), { recursive: true });

    expect(() => assertPromptFilesExist(fixtureConfig(), runtimeRoot)).toThrow(/checks/);
  });

  test("checks absolute entries as-is, ignoring the runtime root", () => {
    const elsewhere = runtimeRootWith(["issues-prompt.md"]);
    const runtimeRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-abs-"));
    const config = resolveConfig({
      ...minimalUser(),
      promptFiles: { issue: join(elsewhere, "prompts", "issues-prompt.md") },
    });

    let message = "";
    try {
      assertPromptFilesExist(config, runtimeRoot);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("issue:");
    expect(message).toContain("research");
  });
});
