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

  // Dogfood with Claude Code on Opus 5.5, running under a Claude Pro/Max
  // *subscription* rather than pay-as-you-go API billing: `providerEnv.claude`
  // points at CLAUDE_CODE_OAUTH_TOKEN, so `buildAgentEnv` hands the CLI that
  // token and never ANTHROPIC_API_KEY — no ambiguity about which credential is
  // used. Mint the token with `node scripts/hoist-claude-login.mjs` and see
  // docs/claude-subscription-auth.md for the whole path.
  //
  // Baseline: opus-5.5 at low effort, because this is a long-running loop
  // paying against subscription usage limits rather than metered API billing.
  // Low is the floor a kind with no `effort` of its own runs at; every built-in
  // kind below names its own level, so the floor reaches only tenant-authored
  // kinds and a PHOEBE_MODEL override that names a model with no kind block.
  //
  // Mind the resolution ladder (docs/configuration.md): per-kind config
  // outranks global env, so PHOEBE_EFFORT now moves only the kinds that carry
  // no `effort` of their own. Use PHOEBE_<KIND>_EFFORT to override one of the
  // others for a single run.
  defaultProvider: "claude",
  defaultModels: { claude: "claude-opus-5-5" },
  defaultEfforts: { claude: "low" },
  providerEnv: { claude: "CLAUDE_CODE_OAUTH_TOKEN" },

  // Run the engine from the host working tree mounted at /opt/phoebe-engine
  // (container/compose.yml) rather than a github checkout, so `boot` execs
  // exactly what is checked out. Only the bootstrapper reads this field; the
  // engine drops it in resolveConfig.
  engine: { source: "local" },

  // This deployment's pipelines of work (#415/#419). Only the reserved `work` pipeline,
  // which is what an engine child with no `--pipeline` flag runs;
  // `pipelines.work.kinds` is where `workKinds` and `promptFiles` moved.
  //
  // Per-work-kind tuning (#300). One rule on both axes: spend where the agent
  // reconstructs intent, save where it executes a spec someone else wrote.
  //
  // The opus kinds keep `high` on opus-5.5. Its API default is `medium`, and
  // at any given level it thinks more per turn than opus-5 did, so `high` here
  // buys more deliberation than it did before — a deliberate spend on the kinds
  // where a wrong answer is expensive. Drop one to `medium` if the usage limit
  // bites; Anthropic's own numbers put opus-5.5 `medium` at or above opus-5
  // `high` on agentic coding.
  //
  //   conflicts — no spec at all. The agent infers intent from two diverging
  //               branches, and a bad resolution loses code silently. Also the
  //               largest context draw, so it keeps opus-5.5's 1M window.
  //   checks    — a failing CI log localises the fix. sonnet-5.5 is the same 1M
  //               window at half the price; medium rather than low because the
  //               cheap failure mode here is papering over a red test.
  //   reviews   — each thread is already specified by a human reviewer, but the
  //               kind still edits code and runs the ready gate, and sonnet-5.5
  //               at `low` is prone to reporting a change done without running
  //               a check that exercises it. Medium, not the `low` floor.
  //   issues    — open-ended implementation against a ticket.
  //   research  — answers land in wayfinder maps that later work builds on, so
  //               a wrong one propagates instead of failing loudly.
  //
  // No haiku block anywhere, on purpose: a block can override `effort` but
  // cannot clear it (#335 — selectProviderForKind falls through to
  // defaultEfforts, and an empty PHOEBE_<KIND>_EFFORT reads as unset), so a
  // haiku kind would still be handed `--effort low`, which that model does not
  // take.
  //
  // Each kind's `promptFile`: the engine child's cwd is this directory (compose
  // `working_dir`), so every prompt points at the repo's own `prompts/` one
  // level up instead of a second copy under `.phoebe/prompts/`. The whole
  // working tree is mounted, so `..` is in reach, and one tree means a prompt
  // improvement merged to `prompts/` actually reaches the agent working this
  // repo (#164).
  pipelines: {
    work: {
      kinds: {
        conflicts: { effort: "high", promptFile: "../prompts/conflict-prompt.md" },
        checks: {
          model: "claude-sonnet-5-5",
          effort: "medium",
          promptFile: "../prompts/checks-prompt.md",
          // Renovate's branches, admitted to this kind and to no other (#655).
          // Renovate cannot write a changeset on the hosted app, so a runtime
          // dependency bump arrives red on the `changeset` gate and sits there;
          // the checks kind reads the gate, writes a `patch` changeset with the
          // PR title as its summary, and pushes. The tenant stays on "phoebe",
          // so widening for this does not hand the conflicts kind somebody
          // else's merge or point the reviews kind at a bot's PR. Every bump no
          // consumer would notice opens labelled `skip-changeset` instead
          // (renovate.json), so this only ever fires on the ones that matter.
          //
          // A Renovate rebase recreates the branch's one commit and drops the
          // changeset; Phoebe re-adds it next cycle. `gitIgnoredAuthors` in
          // renovate.json is what keeps Renovate refreshing the branch at all
          // after a push by another author.
          prScope: ["renovate/"],
        },
        reviews: {
          model: "claude-sonnet-5-5",
          effort: "medium",
          promptFile: "../prompts/reviews-prompt.md",
        },
        issues: { effort: "high", promptFile: "../prompts/issues-prompt.md" },
        research: { effort: "high", promptFile: "../prompts/research-prompt.md" },
      },
    },
  },
};

export default config;
