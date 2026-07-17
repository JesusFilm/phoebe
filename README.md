# Phoebe

**Phoebe is an AFK coding agent.** It polls a GitHub repository for ready-to-work
issues, works each one on its own branch in an isolated git worktree, runs your
project's gates, and opens a pull request. Between new issues it sweeps open PRs
for merge conflicts, failing CI, and unresolved review feedback — so work keeps
moving without a human babysitting every branch.

Phoebe runs as a **single Docker container** that is both orchestrator and
execution environment. Your host checkout is never touched: the container owns a
private clone and pushes branches directly to origin. Every repo-specific value
lives behind one config file, so the same engine drives any repository.

> ⚠️ **Early scaffold.** This repository is being stood up as the public home of
> Phoebe's engine, extracted from [`JesusFilm/youtube-studio`](https://github.com/JesusFilm/youtube-studio).
> The engine, CLI packaging, `phoebe init` scaffolder, CI, and first npm release
> land as the tracked execution issues on this repo. Until `phoebe-agent@0.1.0`
> is published, treat everything here as work in progress.

## Distribution

The engine is published to npm as **`phoebe-agent`** (unscoped) and consumed as a
pinned CLI — you never vendor the engine source into your repo, only a small
config file, your prompt overrides, and the container files `phoebe init`
scaffolds for you.

## Quickstart

From the root of the repo you want Phoebe to work:

```bash
npx --yes phoebe-agent init      # scaffold config, prompts, .env.example, container/
```

Then edit the five required fields in `phoebe.config.ts`, copy `.env.example` to
`.env` and fill in your `GH_TOKEN` and provider key, and pin `PHOEBE_VERSION`.
The scaffolded `.env` lives at the repo root while the compose files live in
`container/`, so pass `--env-file ../.env` when you run Compose from there:

```bash
cd container
docker compose --env-file ../.env build
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once          # preview one unit
docker compose --env-file ../.env -f compose.yml -f compose.daemon.yml up -d    # start the daemon
```

The full, execute-top-to-bottom version — prerequisites, secrets, verification —
is [`docs/ai-install.md`](docs/ai-install.md).

## Configuration at a glance

Only five fields are required; everything else falls back to a shipped default.

```ts
import { defineConfig } from "phoebe-agent";

export default defineConfig({
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
});
```

| Field             | Default                         | What it controls                                |
| ----------------- | ------------------------------- | ----------------------------------------------- |
| `repoSlug`        | _required_                      | GitHub `owner/repo` for every `gh` call.        |
| `repoUrl`         | _required_                      | Clone URL for the container's private clone.    |
| `installCommand`  | _required_                      | Dependency install run in each worktree.        |
| `checkCommand`    | _required_                      | Lint/type gate.                                 |
| `testCommand`     | _required_                      | Test gate.                                      |
| `defaultBranch`   | `main`                          | Branch PRs target and worktrees base off.       |
| `branchPrefix`    | `phoebe/`                       | Prefix for agent branches.                      |
| `readyLabel`      | `ready-for-agent`               | Label marking issues Phoebe may pick up.        |
| `prOptOutLabel`   | `ready-for-human`               | Label that hands a PR back to a human.          |
| `workOrder`       | conflicts→checks→reviews→issues | Order the work kinds are tried.                 |
| `defaultProvider` | `cursor`                        | Agent CLI to drive (`cursor`/`claude`/`codex`). |

See [`docs/configuration.md`](docs/configuration.md) for the complete field
reference and the `PHOEBE_*` environment overlay.

## Documentation

Docs live under [`docs/`](docs/):

- [`docs/architecture.md`](docs/architecture.md) — topology, worktree isolation, supervisor self-update, named volumes.
- [`docs/configuration.md`](docs/configuration.md) — full config-field reference and env overlay.
- [`docs/work-kinds.md`](docs/work-kinds.md) — issues / conflicts / checks / reviews mechanics, PR-scan scope, poll loop.
- [`docs/operating.md`](docs/operating.md) — controlling Phoebe as a human (labels, drafts, watermarks).
- [`docs/upgrading.md`](docs/upgrading.md) — the init / pin / upgrade contract.
- [`docs/ai-install.md`](docs/ai-install.md) — a deterministic, agent-followable install runbook.
- [`docs/releasing.md`](docs/releasing.md) — the Changesets + npm trusted-publishing release flow.
- [`docs/phoebe-core-onboarding.md`](docs/phoebe-core-onboarding.md) — worked onboarding for `JesusFilm/core` (Nx + pnpm, no vp).

Agents landing in this repo should start at [`AGENTS.md`](AGENTS.md).

## History & attribution

Phoebe was designed, built, and dogfooded inside
[`JesusFilm/youtube-studio`](https://github.com/JesusFilm/youtube-studio), which
remains its reference consumer. Its execution loop was first prototyped on
[Sandcastle](https://github.com/mattpocock/sandcastle) (`@ai-hero/sandcastle`, by
Matt Pocock) — the sandbox-per-run design proved the loop end-to-end and its
provider wrappers are the design ancestor of `src/providers/`. The dependency was
removed when the host-spawns-sandboxes topology was replaced by the single
persistable container. This repository starts with fresh history; the full design
record lives in the youtube-studio issue tracker.

## License

[MIT](LICENSE) © JesusFilm
