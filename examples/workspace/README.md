# Workspace topology

**Who this is for:** anyone running one container against several repositories.
It shows the two-tier config and secrets layout, and what the operator owns
versus what Phoebe creates.

One Phoebe deployment runs at the root of a directory whose children are each a
project repository with its own in-tree Phoebe install: its own config, its own
secrets, its own engine child. They share one engine version and one concurrency
broker. This is the [#81](https://github.com/JesusFilm/phoebe/issues/81) layout.
Reach for it when the repos you want served are already checked out under one
root, whether that is a super-repo of submodules, a folder of clones, or a set of
worktrees, and you want one container to pick up whatever is on disk.

Discovery is the only thing that distinguishes it. From the first child onward it
is the #57 fleet bootstrapper: one engine child per tenant, one shared engine, one
broker. Use the other topology when you have one repo and one deployment. See
[`../solo/`](../solo/).

A deployment is solo or workspace, never both. A `workspace` block on the root
config selects workspace mode, and without one the deployment is solo. See
[`docs/workspace.md` → Mode selection](../../docs/workspace.md#mode-selection).

## What's here

```text
workspace/
  phoebe.config.ts          ← DEPLOYMENT-ROOT: shared engine + workspace:{depth} (Pick<…,"engine"|"workspace">)
  .env.example              ← supervisor's token + fleet knobs
  .gitignore                ← ignores .env and each child's .env
  widget/                   ← child 1 — a self-configured repo checkout
    phoebe.config.ts        ←   full config, NO engine field; defaultProvider: claude
    .env.example
  gadget/                   ← child 2 — a DIFFERENT provider, to show isolation
    phoebe.config.ts        ←   defaultProvider: cursor
    .env.example
```

The `workspace` block on the root config selects workspace mode. Its `depth`
field, default 1, is how many levels down the bootstrapper walks looking for a
child `phoebe.config.ts`. You add or remove a child by placing or removing a
checkout under the root. The two here, `widget/` and `gadget/`, are placeholders
showing the multiplicity.

## Declared fleet, the alternative arm

The example above uses the walk arm, `workspace: { depth: 1 }`, which is what
`phoebe init --workspace` scaffolds. The layout is identical under the declared
arm. Only the root config field changes:

```typescript
workspace: {
  tenants: ["widget", "gadget"];
}
```

Declared order is authoritative. See
[`docs/workspace.md` → Declaring the fleet](../../docs/workspace.md#declaring-the-fleet-workspacetenants)
for hold behaviour, out-of-tree entries, `phoebe list` accounting, and the
add-a-child delta. CI does not type-check this snippet, only the on-disk
`phoebe.config.ts`.

## Directory name against `repoSlug`

A child's directory name is a local checkout name the operator chose, not its
identity. `widget/` and `gadget/` are what the checkouts happen to be called on
disk. The authoritative identity is each child's `repoSlug`, `acme/widget` and
`acme/gadget`, which drives the `/data/repos/<owner>/<repo>/` clone path and the
`gh -R` calls. Phoebe cross-checks `repoSlug` against the checkout's git origin
where it can, but the directory name itself is free.

## What you author against what Phoebe creates

The operator owns all git in the workspace tree. Phoebe never clones, fetches, or
updates submodules there. You place a materialized checkout of each child on disk,
whether a plain clone, a submodule, or a worktree, and you keep it current. An
empty or unmaterialized child directory is skip-and-warned until the checkout
exists. Discovery only reads each child's config and `.env` off the host mount.

At runtime the engine still works against a private clone under
`/data/repos/<owner>/<repo>/` on the container volume, never the host checkout.
The host workspace stays read-only discovery and config, and the working copy
lives in the container. See
[`docs/workspace.md` → Topology](../../docs/workspace.md#topology).

These placeholder children commit only the two authored files shown,
`phoebe.config.ts` and `.env.example`. A real child would also be a whole project
repo, but nothing runtime-generated is ever committed at the workspace root.

## Two things the root config makes explicit

- **The root config is engine and discovery only.** In workspace mode the
  bootstrapper reads just the shared `engine` source and the `workspace` discovery
  block from the deployment-root `phoebe.config.ts`, giving one engine version to
  the whole fleet. That is why it is typed `Pick<PhoebeUserConfig, "engine" |
"workspace">`, with no `repoSlug` or commands, because it describes no single
  repo. Each child is a full `PhoebeUserConfig` without `engine`.
- **Secrets are two-tier and scrubbed.** The root `.env` holds only the
  bootstrapper's engine-checkout `GH_TOKEN`. Each child's engine sees only its own
  co-located `.env`, with every other child's secrets and the root token scrubbed
  (#61). That is why `widget` on claude and `gadget` on cursor can hold different
  provider keys with no cross-child leakage.

These configs illustrate rather than run. The `acme/widget` and `acme/gadget`
naming is fictional and shared with the solo example so the two read as one
progression, the same repos appearing alone and then as workspace children. Every
config type-checks against the live schema (`src/config-schema.ts`) as part of the
repo's `typecheck`, so if the schema changes underneath, this example fails CI
instead of rotting quietly.

## Learn more

- [`docs/workspace.md`](../../docs/workspace.md), the full topology, the two-tier
  `.env` model, mode selection, and the end-to-end operator runbook.
- [`docs/configuration.md`](../../docs/configuration.md), every `phoebe.config.ts`
  field and the `PHOEBE_*` env overlay.
