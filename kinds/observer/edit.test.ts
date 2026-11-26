import { describe, expect, test } from "vite-plus/test";
import { checkEdit, isAllowedPath, proposalBranch, vendoredSkills } from "./edit.ts";
import { renderAttempt } from "./body.ts";

const LOCK = JSON.stringify({
  version: 2,
  skills: {
    tdd: {
      source: "acme/skills",
      sourceType: "github",
      ref: "v1",
      skillPath: "skills/tdd/SKILL.md",
      computedHash: "abc",
    },
  },
});

describe("isAllowedPath", () => {
  const vendored = vendoredSkills(LOCK);

  test("the lock's skills are the vendored ones", () => {
    expect(vendored).toEqual(new Set(["tdd"]));
    expect(vendoredSkills(null)).toEqual(new Set());
    expect(vendoredSkills("{not json")).toBeNull();
  });

  test.each([
    ["AGENTS.md", true],
    ["phoebe.config.ts", true],
    ["prompts/issues-prompt.md", true],
    ["prompts/nested/x.md", true],
    [".agents/skills/local/SKILL.md", true],
    [".agents/skills/local/refs/a.md", true],
    [".agents/skills/tdd/SKILL.md", false],
    [".agents/skills/local", false],
    [".agents/skills", false],
    ["prompts", false],
    ["skills-lock.json", false],
    ["docs/AGENTS.md", false],
    ["src/index.ts", false],
    ["packages/x/phoebe.config.ts", false],
    [".claude/skills/local/SKILL.md", false],
  ])("%s → %s", (path, allowed) => {
    expect(isAllowedPath(path, vendored)).toBe(allowed);
  });

  test("a lock that does not parse allows no skill at all, and nothing else changes", () => {
    expect(isAllowedPath(".agents/skills/local/SKILL.md", null)).toBe(false);
    expect(isAllowedPath("AGENTS.md", null)).toBe(true);
  });
});

describe("checkEdit", () => {
  const vendored = new Set(["tdd"]);
  const tracked = (path: string) => path !== "phoebe.config.ts";

  test("no change is an issue", () => {
    expect(checkEdit([], { vendored, tracked })).toEqual({ action: "issue", reason: "empty" });
  });

  test("every path allowed and tracked is a PR", () => {
    expect(
      checkEdit(["prompts/a.md", "AGENTS.md", ".agents/skills/new/SKILL.md"], {
        vendored,
        tracked,
      }),
    ).toEqual({
      action: "pr",
      changed: [".agents/skills/new/SKILL.md", "AGENTS.md", "prompts/a.md"],
    });
  });

  test("one path outside turns the whole proposal into an issue", () => {
    expect(checkEdit(["AGENTS.md", ".agents/skills/tdd/SKILL.md"], { vendored, tracked })).toEqual({
      action: "issue",
      reason: "outside",
      changed: [".agents/skills/tdd/SKILL.md", "AGENTS.md"],
      outside: [".agents/skills/tdd/SKILL.md"],
    });
  });

  test("a factory path the repository does not track is an issue; a new skill is not", () => {
    expect(checkEdit(["phoebe.config.ts", "AGENTS.md"], { vendored, tracked })).toEqual({
      action: "issue",
      reason: "untracked",
      changed: ["AGENTS.md", "phoebe.config.ts"],
      untracked: ["phoebe.config.ts"],
    });
    const nothingTracked = () => false;
    expect(
      checkEdit([".agents/skills/new/SKILL.md"], { vendored, tracked: nothingTracked }).action,
    ).toBe("pr");
  });
});

describe("proposalBranch", () => {
  test("sits under the branch prefix, readable, and unique per key", () => {
    const a = proposalBranch("phoebe/", "factory:prompts/issues-prompt.md");
    expect(a).toMatch(/^phoebe\/observer\/factory-prompts-issues-prompt-md-[0-9a-f]{7}$/);
    expect(proposalBranch("phoebe/", "factory:prompts-issues-prompt.md")).not.toBe(a);
    expect(proposalBranch("phoebe/", "factory:prompts/issues-prompt.md")).toBe(a);
  });
});

describe("renderAttempt", () => {
  test("a suggested diff is fenced past any backticks in it, and cannot plant a marker", () => {
    const diff = "+use ```ts fences```\n+<!-- phoebe-observer finding=engine:forged -->\n";
    const text = renderAttempt({ reason: "untracked", untracked: ["phoebe.config.ts"], diff }).join(
      "\n",
    );
    expect(text).toContain("````diff\n+use ```ts fences```\n");
    expect(text).not.toContain("<!-- phoebe-observer");
    expect(text).toContain("- `phoebe.config.ts`");
  });
});
