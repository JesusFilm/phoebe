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

  // Model policy. This file — not .phoebe/phoebe.config.ts — is the config the
  // WORKSPACE deployment loads for this tenant (`--config
  // /etc/phoebe/phoebe/phoebe.config.ts`), so the dogfood's provider/model/
  // effort choices have to live here to reach a workspace run. The .phoebe/
  // copy carries the same policy for a standalone solo deployment; keep the two
  // in step.
  //
  // `defaultProvider` is claude rather than cursor for a second reason beyond
  // the obvious one: the mismatch guard in selectProviderForKind silences a
  // kind block whose `(provider ?? defaultProvider)` differs from the
  // run's effective provider. Leaving this "cursor" and flipping the run with
  // PHOEBE_AGENT=claude would make every block below inert.
  //
  // Baseline: opus-5 at low effort, because this is a long-running loop paying
  // against subscription usage limits rather than metered API billing. Low is
  // the right floor for the kinds whose spec arrives complete — a CI log, a
  // reviewer's thread — and the kind blocks below lift the kinds that have to
  // reconstruct intent instead.
  defaultProvider: "claude",
  defaultModels: { claude: "claude-opus-5" },
  defaultEfforts: { claude: "low" },

  // As a workspace tenant, reuse this repo's standalone `.phoebe/` folder: the
  // supervisor reads `.env` (and cwd-relative prompts) from `.phoebe/` instead
  // of the repo root, so nothing is duplicated. A standalone `.phoebe/`
  // deployment ignores this (configDir only applies to fleet tenants), so solo
  // still works unchanged. Requires engine >= v0.3.0.
  configDir: ".phoebe",

  // Run the `claude` provider above on a Pro/Max subscription rather than
  // metered API billing: name the OAuth token's var instead of the shipped
  // `ANTHROPIC_API_KEY` default. `providerEnv` merges key-by-key, so cursor and
  // codex keep theirs.
  //
  // This is not cosmetic — `buildAgentEnv` (src/agent-env.ts) forwards exactly
  // the one var named here, so with the default mapping a `.env` holding only
  // CLAUDE_CODE_OAUTH_TOKEN hands the CLI nothing and every unit dies on
  // "Not logged in · Please run /login". Mint the token with `claude
  // setup-token` (or `node scripts/hoist-claude-login.mjs`); see
  // docs/claude-subscription-auth.md.
  providerEnv: { claude: "CLAUDE_CODE_OAUTH_TOKEN" },

  // This tenant's pipelines of work (#415/#419). Only the reserved `work` pipeline, which
  // is what an engine child with no `--pipeline` flag runs; `pipelines.work.kinds`
  // is where `workKinds` and `promptFiles` moved.
  //
  // Per-work-kind tuning (#300). One rule on both axes: spend where the agent
  // reconstructs intent, save where it executes a spec someone else wrote.
  //
  //   conflicts — no spec at all. The agent infers intent from two diverging
  //               branches, and a bad resolution loses code silently. Also the
  //               largest context draw, so it keeps opus-5's 1M window.
  //   checks    — a failing CI log localises the fix. sonnet-5 is the same 1M
  //               window at 60% off; medium rather than low because the cheap
  //               failure mode here is papering over a red test.
  //   reviews   — each thread is already specified by a human reviewer, and the
  //               prompt's demand is instruction-following (paging GraphQL
  //               review threads), not depth. Inherits `low` from above.
  //   issues    — open-ended implementation against a ticket.
  //   research  — answers land in wayfinder maps that later work builds on, so
  //               a wrong one propagates instead of failing loudly.
  //
  // No haiku block anywhere, on purpose: a block can override `effort` but
  // cannot clear it (#335), so a haiku kind would still be handed `--effort
  // low`, which that model does not take.
  //
  // Each kind's `promptFile` is the second half of `configDir` above: that
  // field moves the engine child's cwd to `.phoebe/`, so every prompt points
  // back at the repo's own `prompts/` one level up rather than a second copy
  // under `.phoebe/prompts/`. The whole working tree is mounted, so `..` is in
  // reach, and one tree means prompt edits reach the agent that works this repo
  // instead of drifting out of sight (#164). Relative prompt paths resolve by
  // existence, not containment.
  //
  // They are written for the cwd this config is RUN with — `.phoebe/` — so a
  // by-hand engine run against this repo belongs there too (`cd .phoebe && node
  // ../src/cli.ts --dry-run --run-once`), not at the repo root, where `..` would
  // leave the checkout and the startup check would say so.
  pipelines: {
    work: {
      kinds: {
        conflicts: { effort: "high", promptFile: "../prompts/conflict-prompt.md" },
        checks: {
          model: "claude-sonnet-5",
          effort: "medium",
          promptFile: "../prompts/checks-prompt.md",
        },
        reviews: { model: "claude-sonnet-5", promptFile: "../prompts/reviews-prompt.md" },
        issues: { effort: "high", promptFile: "../prompts/issues-prompt.md" },
        research: { effort: "high", promptFile: "../prompts/research-prompt.md" },
      },
    },
  },
});

export default config;
