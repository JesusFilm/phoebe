import { describe, expect, test } from "vite-plus/test";
import { buildAgentEnv } from "./agent-env.ts";

const providerEnv = {
  cursor: "CURSOR_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_KEY",
} as const;

const parentEnv = {
  PATH: "/usr/bin",
  HOME: "/home/agent",
  GH_TOKEN: "gh-secret",
  GIT_AUTHOR_NAME: "Phoebe",
  GIT_AUTHOR_EMAIL: "phoebe@example.com",
  GIT_COMMITTER_NAME: "Phoebe",
  GIT_COMMITTER_EMAIL: "phoebe@example.com",
  CURSOR_API_KEY: "cursor-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  OPENAI_KEY: "openai-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  SHELL: "/bin/bash",
};

describe("buildAgentEnv", () => {
  test("contains exactly the allowlist plus the active provider's key", () => {
    const env = buildAgentEnv({ parentEnv, provider: "claude", providerEnv });
    expect(env).toEqual({
      CI: "true",
      PATH: "/usr/bin",
      HOME: "/home/agent",
      GH_TOKEN: "gh-secret",
      GIT_AUTHOR_NAME: "Phoebe",
      GIT_AUTHOR_EMAIL: "phoebe@example.com",
      GIT_COMMITTER_NAME: "Phoebe",
      GIT_COMMITTER_EMAIL: "phoebe@example.com",
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
  });

  test("other providers' keys never leak through", () => {
    for (const provider of ["cursor", "claude", "codex"] as const) {
      const env = buildAgentEnv({ parentEnv, provider, providerEnv });
      const otherKeys = Object.values(providerEnv).filter((k) => k !== providerEnv[provider]);
      for (const key of otherKeys) {
        expect(env, `${provider} run must not see ${key}`).not.toHaveProperty(key);
      }
      expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(env).not.toHaveProperty("SHELL");
    }
  });

  test("skips allowlisted vars absent or empty in the parent env", () => {
    const env = buildAgentEnv({
      parentEnv: { PATH: "/usr/bin", GH_TOKEN: "" },
      provider: "cursor",
      providerEnv,
    });
    expect(env).toEqual({ CI: "true", PATH: "/usr/bin" });
  });
});
