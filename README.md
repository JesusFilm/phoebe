# Phoebe

**Phoebe is an AFK coding agent.** It polls a GitHub repository for ready-to-work
issues, works each one on its own branch in an isolated git worktree, runs your
project's gates, and opens a pull request. Between new issues it sweeps open PRs
for merge conflicts, failing CI, and unresolved review feedback, so work keeps
moving without a human babysitting every branch.

Phoebe runs as a **single Docker container** that is both orchestrator and
execution environment. Your host checkout is never touched: the container owns a
private clone and pushes branches directly to origin. Every repo-specific value
lives behind one config file, so the same engine drives any repository.

Phoebe sits at the end of a planning pipeline, not in place of one. A pipeline
handles every decision that needs a person; Phoebe handles the automated work
that follows. So the quality of what comes out depends on the quality of the
issue that goes in, which is what
[`docs/preparing-work.md`](docs/preparing-work.md) is about. Start there if you
are deciding what to hand Phoebe.

Phoebe is published on npm as [`phoebe-agent`](https://www.npmjs.com/package/phoebe-agent)
and runs against repositories inside and outside JesusFilm. It also works this
one: most of the pull requests merged here were opened by Phoebe, from this
repository's own issue tracker.

## Distribution

The engine is published to npm as **`phoebe-agent`** (unscoped) and consumed as a
pinned CLI. You never vendor the engine source into your repo, only a small
config file, your prompt overrides, and the container files `phoebe init`
scaffolds for you.

## Quickstart

From the root of the repo you want Phoebe to work:

```bash
npx --yes phoebe-agent init      # scaffold config, prompts, .env.example, container/
```

Then edit the five required fields in `phoebe.config.ts`, pin the engine with
`engine: { source: "github", ref: "v0.7.1" }`, and copy `.env.example` to `.env`
and fill in your `GH_TOKEN` and provider key. The scaffolded `.env` lives at the
repo root while the compose files live in `container/`, so pass
`--env-file ../.env` when you run Compose from there:

```bash
cd container
docker compose --env-file ../.env build
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once   # preview one unit
docker compose --env-file ../.env up -d                                  # start Phoebe
```

The container's main process is `phoebe boot`: it checks the engine out at the
ref your config names, runs it, and keeps supervising it. Upgrading is an edit to
`engine.ref`, without rebuilding or restarting the container. Boot drains the
running engine and relaunches it on the new ref. The deployment dir is
bind-mounted as a directory, so an in-place edit or a `git pull` is picked up on
the next poll.

**Multiple repos in one container.** You don't need one Phoebe per repo: run at
a workspace root whose child repos are checked out as child directories, either
plain clones or submodules (`phoebe init --workspace` / `init --tenant`; see
[`docs/workspace.md`](docs/workspace.md)). Read [`docs/trust.md`](docs/trust.md)
first, because co-locating repos means co-locating them in one trust domain. See
[`docs/configuration.md`](docs/configuration.md) and
[`docs/operating.md`](docs/operating.md). For deployments spanning several repos
under one org owner, the GitHub App arm replaces the per-repo token ceremony. See
[`docs/github-app-mode.md`](docs/github-app-mode.md).

The full version, covering prerequisites, secrets, and verification, is
[`docs/ai-install.md`](docs/ai-install.md). It runs top to bottom.

## Configuration at a glance

Only five fields are required; everything else falls back to a shipped default.

```ts
import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  engine: { source: "github", ref: "v0.7.1" },
};

export default config;
```

| Field             | Default                                  | What it controls                                |
| ----------------- | ---------------------------------------- | ----------------------------------------------- |
| `repoSlug`        | _required_                               | GitHub `owner/repo` for every `gh` call.        |
| `repoUrl`         | _required_                               | Clone URL for the container's private clone.    |
| `installCommand`  | _required_                               | Dependency install run in each worktree.        |
| `checkCommand`    | _required_                               | Lint/type gate.                                 |
| `testCommand`     | _required_                               | Test gate.                                      |
| `defaultBranch`   | `main`                                   | Branch PRs target and worktrees base off.       |
| `branchPrefix`    | `phoebe/`                                | Prefix for agent branches.                      |
| `readyLabel`      | `ready-for-agent`                        | Label marking issues Phoebe may pick up.        |
| `researchLabel`   | `wayfinder:research`                     | Label marking wayfinder research tickets.       |
| `prOptOutLabel`   | `ready-for-human`                        | Label that hands a PR back to a human.          |
| `workOrder`       | conflicts→checks→reviews→issues→research | Order the work kinds are tried.                 |
| `defaultProvider` | `cursor`                                 | Agent CLI to drive (`cursor`/`claude`/`codex`). |

See [`docs/configuration.md`](docs/configuration.md) for the complete field
reference and the `PHOEBE_*` environment overlay.

## Documentation

[`CONTEXT.md`](CONTEXT.md) is the glossary. It holds the words this project uses
for its own concepts, and the ones it avoids on purpose.

Docs live under [`docs/`](docs/), in two groups.

**Using Phoebe**, running it against your own repositories:

- [`docs/preparing-work.md`](docs/preparing-work.md), what an issue needs before Phoebe can work it, and the planning pipeline that produces one.
- [`docs/ai-install.md`](docs/ai-install.md), a deterministic, agent-followable install runbook.
- [`docs/configuration.md`](docs/configuration.md), full config-field reference and env overlay.
- [`docs/work-kinds.md`](docs/work-kinds.md), issues / conflicts / checks / reviews / research mechanics, PR-scan scope, poll loop, and writing your own kind.
- [`docs/operating.md`](docs/operating.md), controlling Phoebe as a human (labels, drafts, watermarks).
- [`docs/feature-branches.md`](docs/feature-branches.md), the `phoebe:feature` arm for a group of tickets that only makes sense landed together.
- [`docs/pipelines.md`](docs/pipelines.md), running more than one stream of work in a tenant: declaring pipelines, supervision, units in flight, and the intake example.
- [`docs/upgrading.md`](docs/upgrading.md), the init / pin / upgrade contract, `phoebe migrate` verb, and what Phoebe may write in your repos.
- [`docs/workspace.md`](docs/workspace.md), workspace mode topology, two-tier `.env`, operator runbook (plain-clone or submodule children).
- [`docs/github-app-mode.md`](docs/github-app-mode.md), the GitHub App credential arm, for deployments spanning several repos under one org owner.
- [`docs/claude-subscription-auth.md`](docs/claude-subscription-auth.md), driving the `claude` provider from a subscription rather than an API key.
- [`docs/phoebe-core-onboarding.md`](docs/phoebe-core-onboarding.md), worked onboarding for `JesusFilm/core` (Nx + pnpm, no vp).

**Working on Phoebe**, changing the engine itself:

- [`docs/architecture.md`](docs/architecture.md), topology, worktree isolation, engine updates and crash-loop fallback, named volumes.
- [`docs/migrations.md`](docs/migrations.md), the `Migration` interface, roles, detect/describe/apply, refusal semantics, and idempotence tests.
- [`docs/releasing.md`](docs/releasing.md), the Changesets + npm trusted-publishing release flow.
- [`docs/trust.md`](docs/trust.md), contributor trust list (`vouch`) for this repo, and how it relates to `ready-for-agent`. Governance for this repository, not a package feature.
- [`docs/research/`](docs/research/), design records: the decision behind a seam, what was considered, and why.

Agents landing in this repo should start at [`AGENTS.md`](AGENTS.md).

## History & attribution

Phoebe was designed, built, and dogfooded inside
[`JesusFilm/youtube-studio`](https://github.com/JesusFilm/youtube-studio), which
incubated it. Phoebe has since outgrown that one repository and now runs against
several, so youtube-studio is where it started rather than what it serves.

Two pieces of Matt Pocock's work are woven through it. Its execution loop was
first prototyped on [Sandcastle](https://github.com/mattpocock/sandcastle)
(`@ai-hero/sandcastle`): the sandbox-per-run design proved the loop end-to-end,
and its provider wrappers are the design ancestor of `src/providers/`. That
dependency was removed when the host-spawns-sandboxes topology was replaced by
the single persistable container.

The [AI Hero skills](https://github.com/mattpocock/skills) are the planning
pipeline Phoebe was built to sit behind. They are vendored under
[`.agents/skills/`](.agents/skills) and pinned by content hash in
[`skills-lock.json`](skills-lock.json), and the `research` work kind implements
wayfinder's resolution protocol directly. See
[`docs/preparing-work.md`](docs/preparing-work.md).

This repository starts with fresh history. Design decisions made here are
recorded here, as issues on this tracker and as design records under
[`docs/research/`](docs/research/).

## License

[MIT](LICENSE) © JesusFilm
