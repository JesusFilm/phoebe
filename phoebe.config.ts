// All repo-specific configuration for the Phoebe engine lives here — repo slug,
// labels, branch prefix, toolchain commands, prompts, work order, provider keys.
// Engine code under src/ never mentions any concrete repository (enforced by
// src/config-seam.test.ts), so pointing Phoebe at a repo is a matter of editing
// this one file. These are the engine's shipped defaults; consumers replace the
// repo/toolchain values with their own.

import type { PhoebeConfig } from "./src/config-schema.ts";

export const config: PhoebeConfig = {
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  defaultBranch: "main",
  branchPrefix: "phoebe/",
  readyLabel: "ready-for-agent",
  prScope: "phoebe",
  draftPrs: "skip-non-phoebe",
  prOptOutLabel: "ready-for-human",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  promptFiles: {
    issue: "prompts/prompt.md",
    conflict: "prompts/conflict-prompt.md",
    checks: "prompts/checks-prompt.md",
    reviews: "prompts/reviews-prompt.md",
  },
  workOrder: ["conflicts", "checks", "reviews", "issues"],
  defaultProvider: "cursor",
  defaultModels: {
    cursor: "composer-2.5",
    claude: "claude-sonnet-4-6",
    codex: "gpt-5.4-mini",
  },
  providerEnv: {
    cursor: "CURSOR_API_KEY",
    claude: "ANTHROPIC_API_KEY",
    codex: "OPENAI_KEY",
  },
  selfUpdatePaths: ["package.json", "package-lock.json"],
  paths: {
    repoDir: "/data/repo",
    worktreesDir: "/data/worktrees",
    stateDir: "/data/state",
  },
};
