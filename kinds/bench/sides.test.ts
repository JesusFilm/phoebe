import { describe, expect, test } from "vite-plus/test";
import { parseTreeSettings, settingsChildEnv, settingsDiffer, unmeasuredPaths } from "./sides.ts";

const PROVIDER_ENV = {
  claude: "ANTHROPIC_API_KEY",
  cursor: "CURSOR_API_KEY",
  codex: "OPENAI_API_KEY",
} as const;

describe("settingsChildEnv", () => {
  test("holds no GitHub credential, no provider key, and a HOME of its own", () => {
    const env = settingsChildEnv({
      parentEnv: {
        PATH: "/usr/bin",
        HOME: "/home/phoebe",
        GH_TOKEN: "ghs_fake", // gitleaks:allow
        GITHUB_TOKEN: "ghs_fake", // gitleaks:allow
        GH_ENTERPRISE_TOKEN: "x",
        GH_APP_ID: "1",
        GH_APP_PRIVATE_KEY: "x",
        ANTHROPIC_API_KEY: "x",
        CURSOR_API_KEY: "x",
        OPENAI_API_KEY: "x",
        SLACK_TOKEN: "x",
        GIT_AUTHOR_NAME: "Phoebe",
      },
      providerEnv: PROVIDER_ENV,
      home: "/scratch/home",
    });
    expect(env).toEqual({
      CI: "true",
      PATH: "/usr/bin",
      GIT_AUTHOR_NAME: "Phoebe",
      HOME: "/scratch/home",
      XDG_CONFIG_HOME: "/scratch/home/.config",
      GH_CONFIG_DIR: "/scratch/home/.config/gh",
      GIT_CONFIG_GLOBAL: "/scratch/home/.gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});

describe("parseTreeSettings", () => {
  test("reads the child's one line", () => {
    expect(
      parseTreeSettings(
        '{"provider":"claude","model":"m","effort":null,"promptFile":"/t/p.md"}\n',
        "x",
      ),
    ).toEqual({ provider: "claude", model: "m", effort: null, promptFile: "/t/p.md" });
  });

  test("refuses anything else", () => {
    expect(() => parseTreeSettings("hello", "cfg")).toThrow("cfg: the settings read printed");
    expect(() => parseTreeSettings('{"provider":"claude"}', "cfg")).toThrow("no `model`");
  });
});

describe("what a bench measures", () => {
  test("settings differ on any of provider, model and effort, and only when both are known", () => {
    const base = { provider: "claude", model: "m", effort: "high" };
    expect(settingsDiffer(base, { ...base })).toBe(false);
    expect(settingsDiffer(base, { ...base, effort: null })).toBe(true);
    expect(settingsDiffer(base, { ...base, model: "n" })).toBe(true);
    expect(settingsDiffer(null, base)).toBe(false);
  });

  test("AGENTS.md at any depth and skills are the unmeasured paths", () => {
    expect(
      unmeasuredPaths([
        "AGENTS.md",
        "apps/web/AGENTS.md",
        ".agents/skills/tdd/SKILL.md",
        ".claude/skills/x/SKILL.md",
        "prompts/issues-prompt.md",
        "src/AGENTS.md.ts",
      ]),
    ).toEqual([
      "AGENTS.md",
      "apps/web/AGENTS.md",
      ".agents/skills/tdd/SKILL.md",
      ".claude/skills/x/SKILL.md",
    ]);
  });
});
