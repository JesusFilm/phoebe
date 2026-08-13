// Phoebe consumer config for JesusFilm/phoebe. It doubles as the fixture that
// src/test-setup.ts installs into src/resolved-config.ts before any test module
// loads, AND as this repo's tenant entry when it is a member of the workspace
// deployment one directory up (../phoebe.config.ts scans for it). Real consumers
// install `phoebe-agent` and export their own config; the shape is identical:
//
// ```ts
// import { defineConfig } from "phoebe-agent";
// export default defineConfig({
//   repoSlug: "your-org/your-repo",
//   repoUrl: "https://github.com/your-org/your-repo.git",
//   installCommand: "npm ci",
//   checkCommand: "npm run check",
//   testCommand: "npm test",
// });
// ```
//
// Only five fields are required (repo slug, clone URL, install/check/test
// commands). Everything else is optional and filled from `CONFIG_DEFAULTS`
// (see src/config-schema.ts) by `resolveConfig()`. Add entries here only when
// overriding a shipped default; `PHOEBE_*` env vars provide one-off overrides
// for a subset of scalar fields (see src/load-config.ts).

import { defineConfig } from "./bootstrap/define-config.ts";

export const config = defineConfig({
  repoSlug: "JesusFilm/phoebe",
  repoUrl: "https://github.com/JesusFilm/phoebe.git",

  // This repo is pnpm + vite-plus (`vp`); the container enables corepack so the
  // pinned pnpm is on PATH. installCommand runs in each worktree; check/test/
  // ready go to the agent.
  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "pnpm run check",
  testCommand: "pnpm run test",
  readyCommand: "pnpm run ready",

  // Cursor provider (composer-2.5 default); requires CURSOR_API_KEY in this
  // tenant's .env — the supervisor scrubs every other tenant's secrets.
  defaultProvider: "cursor",

  // Run the `claude` provider (via PHOEBE_AGENT=claude) on a Pro/Max
  // subscription rather than metered API billing: name the OAuth token's var
  // instead of the shipped `ANTHROPIC_API_KEY` default. `providerEnv` merges
  // key-by-key, so cursor and codex keep theirs.
  //
  // This is not cosmetic — `buildAgentEnv` (src/agent-env.ts) forwards exactly
  // the one var named here, so with the default mapping a `.env` holding only
  // CLAUDE_CODE_OAUTH_TOKEN hands the CLI nothing and every unit dies on
  // "Not logged in · Please run /login". Mint the token with `claude
  // setup-token` (or `node scripts/hoist-claude-login.mjs`); see
  // docs/claude-subscription-auth.md.
  providerEnv: { claude: "CLAUDE_CODE_OAUTH_TOKEN" },

  // As a workspace tenant, reuse this repo's standalone `.phoebe/` folder: the
  // supervisor reads `.env` (and cwd-relative prompts) from `.phoebe/` instead
  // of the repo root, so nothing is duplicated. A standalone `.phoebe/`
  // deployment ignores this (configDir only applies to fleet tenants), so solo
  // still works unchanged. Requires engine >= v0.3.0.
  configDir: ".phoebe",

  // …and, because `configDir` moves the engine child's cwd to `.phoebe/`, point
  // every prompt back at the repo's own `prompts/` one level up rather than
  // keeping a second copy under `.phoebe/prompts/`. The whole working tree is
  // mounted, so `..` is in reach, and one tree means prompt edits reach the
  // agent that works this repo instead of drifting out of sight (#164). Relative
  // `promptFiles` are resolved by existence, not containment.
  //
  // These are written for the cwd this config is RUN with — `.phoebe/` — so a
  // by-hand engine run against this repo belongs there too (`cd .phoebe && node
  // ../src/cli.ts --dry-run --run-once`), not at the repo root, where `..` would
  // leave the checkout and the startup check would say so.
  promptFiles: {
    issue: "../prompts/issues-prompt.md",
    conflict: "../prompts/conflict-prompt.md",
    checks: "../prompts/checks-prompt.md",
    reviews: "../prompts/reviews-prompt.md",
    research: "../prompts/research-prompt.md",
  },
});

export default config;
