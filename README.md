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

## Documentation

Docs live under [`docs/`](docs/) and grow as the engine lands:

- `docs/architecture.md` — topology, worktree isolation, supervisor self-update.
- `docs/configuration.md` — full config-field reference.
- `docs/work-kinds.md` — issues / conflicts / checks / reviews mechanics.
- `docs/operating.md` — controlling Phoebe as a human (labels, drafts, watermarks).
- `docs/upgrading.md` — the init / pin / upgrade contract.
- `docs/ai-install.md` — a deterministic, agent-followable install runbook.

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
