# Phoebe deployment examples

Reference illustrations of the canonical file layout and `phoebe.config.ts`
shape for each way Phoebe can be deployed. Read them to see the real thing, then
scaffold your own with `npx --yes phoebe-agent init`.

They are **reference illustrations, not runnable fixtures**: read-to-learn, not a
CI-booted starter you copy wholesale. Every config type-checks against the live
schema (`src/config-schema.ts`) as part of the repo's `typecheck`, so if the
schema changes underneath, these examples fail CI rather than silently rotting.
The fictional `acme/widget` + `acme/gadget` naming is shared across both so they
read as one progression: the same repos appear alone, then as workspace
children.

The two supported topologies, simplest first:

## [`solo/`](solo/) — one repo, one deployment

A single, self-configured repo at the runtime root: one `phoebe.config.ts`
describes one repository, and Phoebe works that repository's issues and PRs.
**Use this when** one repo, one deployment is all you need — the classic
single-root layout.

## [`workspace/`](workspace/) — one container, many repos it discovers

Phoebe runs at the root of a **workspace** whose children are each a self-configured
project checkout (a clone, submodule, or worktree the operator places on disk);
one container discovers whatever is there and runs them as an isolated
multi-tenant fleet — each child with its own config, secrets, and engine child,
sharing one engine version and one concurrency broker (the
[#81](https://github.com/JesusFilm/phoebe/issues/81) layout). **Use this when**
the repos you want to serve are the checkouts already sitting under one root.

Solo and workspace are **mutually exclusive per deployment** — pick one. See
[`docs/workspace.md` → Mode selection](../docs/workspace.md#mode-selection).

## Learn more

- [`docs/configuration.md`](../docs/configuration.md) — every `phoebe.config.ts` field and the `PHOEBE_*` env overlay.
- [`docs/workspace.md`](../docs/workspace.md) — the workspace topology and operator runbook.
- [`docs/ai-install.md`](../docs/ai-install.md) — scaffolding and first boot end to end.
