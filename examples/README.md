# Phoebe deployment examples

**Who this is for:** anyone about to write their first `phoebe.config.ts` who
wants to see a real one before scaffolding. It shows the file layout and config
shape for each way Phoebe can be deployed.

Read these to see the real thing, then scaffold your own with
`npx --yes phoebe-agent init`.

They illustrate rather than run. Nothing here is a CI-booted starter you copy
wholesale. Every config does type-check against the live schema
(`src/config-schema.ts`) as part of the repo's `typecheck`, so if the schema
changes underneath them, these examples fail CI instead of rotting quietly. The
fictional `acme/widget` and `acme/gadget` naming is shared across both, so they
read as one progression: the same repos alone first, then as workspace children.

The two supported topologies, simplest first — then one feature illustration.

## [`solo/`](solo/), one repo, one deployment

A single self-configured repo at the runtime root. One `phoebe.config.ts`
describes one repository, and Phoebe works that repository's issues and PRs.
Reach for this when one repo and one deployment is all you need.

## [`workspace/`](workspace/), one container and the repos it discovers

Phoebe runs at the root of a workspace whose children are each a self-configured
project checkout, whether a clone, a submodule, or a worktree the operator places
on disk. One container discovers whatever is there and runs them as an isolated
fleet. Each child gets its own config, secrets, and engine child, while sharing
one engine version and one concurrency broker. This is the
[#81](https://github.com/JesusFilm/phoebe/issues/81) layout. Reach for it when
the repos you want served are already checked out under one root.

A deployment is solo or workspace, never both. See
[`docs/workspace.md` → Mode selection](../docs/workspace.md#mode-selection).

## [`custom-kind/`](custom-kind/), writing your own work kind

Not a topology — a feature illustration on a solo-shaped config: a full-form
custom work kind (a stale-PR nudger, loaded from a module in the repo) beside
the inline prompt-only-producer cheap case, both registered under
`pipelines.work.kinds` and treated by the engine exactly like the
built-ins. Start here when the five built-in kinds do not cover the work you
want Phoebe to do.

## Learn more

- [`docs/configuration.md`](../docs/configuration.md), every `phoebe.config.ts` field and the `PHOEBE_*` env overlay.
- [`docs/workspace.md`](../docs/workspace.md), the workspace topology and operator runbook.
- [`docs/ai-install.md`](../docs/ai-install.md), scaffolding and first boot end to end.
