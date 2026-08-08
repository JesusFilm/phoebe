# Workspace topology

**One container at the root of a workspace of self-configured child repos.** A
single Phoebe deployment runs at the root of a directory whose children are each
a project repository with its own in-tree Phoebe install — its own config, its
own secrets, its own engine child — all sharing one engine version and one
concurrency broker. This is the
[#81](https://github.com/JesusFilm/phoebe/issues/81) layout. Reach for it when
**the repos you want to serve are the checkouts sitting under one root** (a
super-repo of submodules, a folder of clones, a set of worktrees) and you want
one container to pick up whatever is on disk.

Under the hood it is the same multi-tenant fleet as nested — workspace mode is
only a different **discovery source** (walk the children) feeding the #57
supervisor. Use a different topology when:

- you have **one repo, one deployment** → see [`../solo/`](../solo/) (the classic
  single-root layout);
- you want the deployment to **own the tenant directories** under `repos/` rather
  than discover checkouts on disk → see [`../nested/`](../nested/) (the
  [#57](https://github.com/JesusFilm/phoebe/issues/57) `repos/<owner>/<repo>/`
  layout).

Nested and workspace are **mutually exclusive per deployment** — a `workspace`
block on the root config selects workspace mode and a `repos/` dir would be
ignored (with a warning). See [`docs/workspace.md` → Mode selection](../../docs/workspace.md#mode-selection).

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

The `workspace` block on the root config is what selects workspace mode; `depth`
(default 1) is how many levels down the bootstrapper walks looking for a child
`phoebe.config.ts`. Add or remove a child by placing or removing a checkout under
the root — the two here (`widget/`, `gadget/`) are placeholders showing the
multiplicity.

## Declared fleet (alternative arm)

The example above uses the walk arm (`workspace: { depth: 1 }`), matching what
`phoebe init --workspace` scaffolds. The layout is identical under the declared
arm — only the root config field changes:

```typescript
workspace: {
  tenants: ["widget", "gadget"];
}
```

Declared order is authoritative; see
[`docs/workspace.md` → Declaring the fleet](../../docs/workspace.md#declaring-the-fleet-workspacetenants)
for hold behaviour, out-of-tree entries, `phoebe list` accounting, and the
add-a-child delta. This snippet is **not** CI-type-checked (only the on-disk
`phoebe.config.ts` is).

## Directory name vs. `repoSlug`

The one thing that differs from nested: here a child's **directory name is an
operator-chosen local checkout name**, not its identity. `widget/` and `gadget/`
are just what the checkouts happen to be called on disk; the authoritative
identity is each child's `repoSlug` (`acme/widget`, `acme/gadget`), which drives
the `/data/repos/<owner>/<repo>/` clone path and the `gh -R` calls. Phoebe
best-effort cross-checks `repoSlug` against the checkout's git origin but the
directory name is free. (In nested, by contrast, the `repos/<owner>/<repo>/` path
segment _is_ the slug.)

## What you author vs. what Phoebe creates

The operator owns **all** git in the workspace tree — Phoebe never clones,
fetches, or updates submodules there. You place a materialized checkout of each
child on disk (a plain clone, a submodule, a worktree) and keep it current; an
empty or unmaterialized child dir is skip-and-warned until the checkout exists.
Discovery only **reads** each child's config + `.env` off the host mount.

At runtime the engine still runs against a **private clone** under
`/data/repos/<owner>/<repo>/` on the container volume — never the host checkout.
So the host workspace stays read-only discovery + config; the working copy lives
in the container. (Same isolation invariant as nested — see
[`docs/workspace.md` → Topology](../../docs/workspace.md#topology).)

These placeholder children commit only the two authored files shown
(`phoebe.config.ts` + `.env.example`); a real child would additionally be a whole
project repo, but nothing runtime-generated is ever committed at the workspace
root.

## Two things the root config makes explicit

- **The root config is engine + discovery only.** In workspace mode the
  bootstrapper reads _just_ the shared `engine` source and the `workspace`
  discovery block from the deployment-root `phoebe.config.ts` — one engine version
  for the whole fleet. That is why it is typed `Pick<PhoebeUserConfig, "engine" |
"workspace">` (no `repoSlug`/commands: it describes no single repo), while each
  child is a full `PhoebeUserConfig` **minus** `engine`.
- **Secrets are two-tier and scrubbed.** The root `.env` holds only the
  supervisor's engine-checkout `GH_TOKEN`; each child's engine sees only its own
  co-located `.env`, with all other children's secrets and the root token
  scrubbed (#61). That is why `widget` (claude) and `gadget` (cursor) can hold
  different provider keys with no cross-child leakage.

These configs are a **reference illustration**, not a runnable fixture. The
`acme/widget` + `acme/gadget` naming is fictional and shared across all three
examples so they read as one progression (the same two repos appear solo, then as
nested tenants, then as workspace children). Every config type-checks against the
live schema (`src/config-schema.ts`) as part of the repo's `typecheck` — if the
schema changes underneath, this example fails CI rather than silently rotting.

## Learn more

- [`docs/workspace.md`](../../docs/workspace.md) — the full topology, the two-tier
  `.env` model, mode selection, and the end-to-end operator runbook.
- [`docs/configuration.md`](../../docs/configuration.md) — every `phoebe.config.ts`
  field and the `PHOEBE_*` env overlay.
