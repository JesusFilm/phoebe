// Dogfood config — Phoebe working its own repo (JesusFilm/phoebe).
//
// Type-only import, same as the shipped scaffold: this config is loaded from a
// container mount with no reachable `node_modules`, so a value import could not
// resolve under ESM. The scaffold's import resolves the published package; here
// it resolves this repo's own source, since that is what the container runs.
import type { PhoebeUserConfig } from "../src/config-schema.ts";

const config: PhoebeUserConfig = {
  repoSlug: "JesusFilm/phoebe",
  repoUrl: "https://github.com/JesusFilm/phoebe.git",

  // This repo is pnpm + vite-plus (`vp`). The container enables corepack, so
  // `pnpm` resolves to the version pinned in package.json's `packageManager`.
  // installCommand is run by the engine (execSync) in each worktree;
  // check/test are rendered into the agent prompt and run by the agent.
  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "pnpm run check",
  testCommand: "pnpm run test",
  readyCommand: "pnpm run ready",

  // Dogfood with Claude Code on Opus 5, running under a Claude Pro/Max
  // *subscription* rather than pay-as-you-go API billing: `providerEnv.claude`
  // points at CLAUDE_CODE_OAUTH_TOKEN, so `buildAgentEnv` hands the CLI that
  // token and never ANTHROPIC_API_KEY — no ambiguity about which credential is
  // used. Mint the token with `node scripts/hoist-claude-login.mjs` and see
  // docs/claude-subscription-auth.md for the whole path.
  //
  // Low effort: Phoebe's work units are well-specified by the prompts and the
  // issue, and this is a long-running loop paying against subscription usage
  // limits, so the cheap tier is the right default. Raise it per-run without
  // editing this file via PHOEBE_EFFORT.
  defaultProvider: "claude",
  defaultModels: { claude: "claude-opus-5" },
  defaultEfforts: { claude: "low" },
  providerEnv: { claude: "CLAUDE_CODE_OAUTH_TOKEN" },

  // The engine child's cwd is this directory (compose `working_dir`), so point
  // every prompt at the repo's own `prompts/` one level up instead of keeping a
  // second copy under `.phoebe/prompts/`. The whole working tree is mounted, so
  // `..` is in reach, and one tree means a prompt improvement merged to
  // `prompts/` actually reaches the agent working this repo (#164).
  promptFiles: {
    issue: "../prompts/issues-prompt.md",
    conflict: "../prompts/conflict-prompt.md",
    checks: "../prompts/checks-prompt.md",
    reviews: "../prompts/reviews-prompt.md",
    research: "../prompts/research-prompt.md",
  },

  // Run the engine from the host working tree mounted at /opt/phoebe-engine
  // (container/compose.yml) rather than a github checkout, so `boot` execs
  // exactly what is checked out. Only the bootstrapper reads this field; the
  // engine drops it in resolveConfig.
  engine: { source: "local" },
};

export default config;
