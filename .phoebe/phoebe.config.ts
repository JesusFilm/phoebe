// The Phoebe config for JesusFilm/phoebe: Phoebe working its own repo.
//
// One file, read three ways (#663):
//
//   - as a workspace tenant. A workspace one directory up finds this repo by the
//     pointer at its root (../phoebe.config.ts), which names this directory, and
//     runs the tenant on this file;
//   - as the dogfood. `vp run phoebe` starts the deployment in this directory
//     with the engine read from the working tree (README.md);
//   - as the test fixture. src/test-setup.ts installs it into
//     src/resolved-config.ts before any test module loads.
//
// It used to be two files, one here and one at the root, and they drifted every
// time one was edited: the workspace ran on the shipped default model for three
// weeks while this copy said Opus (#389), and this copy never learned about the
// `intake` pipeline at all.
//
// A real consumer's config has the same shape. Only five fields are required
// (repo slug, clone URL, install/check/test commands); everything else is filled
// from `CONFIG_DEFAULTS` (src/config-schema.ts) by `resolveConfig()`, and
// `PHOEBE_*` env vars override a subset of scalar fields for one run
// (src/load-config.ts).
//
// The import is a value import of this repo's own source, where a consumer
// writes `import type { PhoebeUserConfig } from "phoebe-agent"`. A config is
// loaded from a container mount with no reachable `node_modules`, so a package
// specifier could not resolve there under ESM. A relative path into the same
// checkout can, in all three readings above.

import { defineConfig } from "../bootstrap/define-config.ts";

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

  // Model policy, for every deployment that runs this repo.
  //
  // `defaultProvider` is claude rather than cursor for a second reason beyond
  // the obvious one: the mismatch guard in selectProviderForKind silences a
  // kind block whose `(provider ?? defaultProvider)` differs from the
  // run's effective provider. Leaving this "cursor" and flipping the run with
  // PHOEBE_AGENT=claude would make every block below inert.
  //
  // Baseline: opus-5.5 at low effort, because this is a long-running loop
  // paying against subscription usage limits rather than metered API billing.
  // Low is the floor a kind with no `effort` of its own runs at; every built-in
  // kind below names its own level, so the floor reaches only tenant-authored
  // kinds and a PHOEBE_MODEL override that names a model with no kind block.
  defaultProvider: "claude",
  defaultModels: { claude: "claude-opus-5-5" },
  defaultEfforts: { claude: "low" },

  // Run the engine from the host working tree mounted at /opt/phoebe-engine
  // (container/compose.yml) rather than a github checkout, so `boot` execs
  // exactly what is checked out. Read by the deployment in this directory and
  // by nothing else: a workspace takes its engine from its own root config and
  // ignores this field in a tenant's, and the engine drops it in resolveConfig.
  engine: { source: "local" },

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
  // cannot clear it (#335), so a haiku kind would still be handed `--effort
  // low`, which that model does not take.
  //
  // Each kind's `promptFile`: the engine child's cwd is this directory in
  // every deployment (compose's `working_dir` for the one here, the pointer's
  // `configDir` for a workspace), so every prompt points back at the repo's own
  // `prompts/` one level up rather than a second copy under `.phoebe/prompts/`. The whole working tree is mounted, so `..` is in
  // reach, and one tree means prompt edits reach the agent that works this repo
  // instead of drifting out of sight (#164). Relative prompt paths resolve by
  // existence, not containment.
  //
  // They are written for the cwd this config is RUN with — `.phoebe/` — so a
  // by-hand engine run against this repo belongs there too (`cd .phoebe && node
  // ../src/cli.ts --dry-run --run-once`), not at the repo root, where `..` would
  // leave the checkout and the startup check would say so.
  //
  // Dogfood for the crash reporter (#474): this tenant triages the maintainers'
  // Sentry project — the one every consumer's `reporting: { maintainers: true }`
  // sends to — through the `sentry` catalog kind, so a crash report anywhere
  // becomes a front-loaded issue here. Declared on its own pipeline so the token
  // never reaches the `work` pipeline's child. The pipeline boots only with
  // SENTRY_AUTH_TOKEN (scope event:read) in .phoebe/.env; without it, this
  // pipeline alone refuses to start and `work` is untouched. See
  // docs/work-kinds.md → sentry.
  //
  pipelines: {
    intake: {
      pollIntervalMs: 900_000,
      kinds: {
        sentry: {
          path: "phoebe-agent/kinds/sentry",
          org: "jesusfilm-rb",
          project: 4512031884050432,
          // Crash reports carry no environment, so the default's
          // `["production"]` names one Sentry has never seen and the scan
          // 404s. Empty is no filter.
          environments: [],
        },
      },
    },
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
});

export default config;
