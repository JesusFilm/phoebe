# Workspace mode: topology and operator runbook

**Who this is for:** an operator running one container against several
repositories. It answers how children are discovered, how secrets stay separate,
and what you have to place on disk yourself.

How to run Phoebe at the root of a **workspace** whose child project repos each
sit in their own directory with an in-tree Phoebe install. A child directory can
be a plain clone, a git submodule, or a git worktree, meaning any on-disk
checkout. Submodules are supported but **not required**. One container discovers whatever
is on disk, and the multi-tenant fleet bootstrapper (#57) runs one engine child
per tenant.

Workspace mode is a **discovery source**: what it contributes is the tenant
list. Everything downstream is the #57 fleet bootstrapper: the shared engine,
per-tenant children, fleet concurrency cap, env-scrub isolation, and reconcile
loop. It is one of the two supported layouts; the other is solo, one repo
per deployment (see [Mode selection](#mode-selection)).

For day-to-day labels and janitors, see [`operating.md`](operating.md), and
[configuration.md → Multiple repos](configuration.md#multiple-repos-workspace-tenants)
for the config-field view of the same layout.

For a complete worked layout, with the `engine` and `workspace: { depth }` root
config plus two placeholder child checkouts, see
[`examples/workspace/`](../examples/workspace/).

## Topology

```text
workspace-root/                         # bind-mounted :ro → /etc/phoebe
  phoebe.config.ts                      # engine + workspace: { depth } or { tenants }
  .env                                  # deployment: engine-checkout GH_TOKEN, toggles
  .env.example
  .gitignore
  container/                            # Dockerfile, compose (deployment-owned)
  .git/                                 # optional; only submodule children need the root's
  .gitmodules                           # only if children are submodules
  child-a/                              # a plain clone, submodule, or any checkout
    phoebe.config.ts                    # authoritative repoSlug, per-repo fields
    .env                                # this tenant's GH_TOKEN + provider key
    .env.example
    prompts/?                           # optional
  child-b/
    phoebe.config.ts
    .env
    …
```

| Layer              | Who owns it            | What it holds                                                                                                        |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Root**           | deployment / workspace | Shared `engine` + `workspace: { depth }` or `{ tenants }`; deployment-level `.env`; `container/`                     |
| **Child (tenant)** | each linked repo       | In-tree `phoebe.config.ts` + gitignored `.env` (+ optional `prompts/`); **no** `container/`                          |
| **Private clone**  | container volumes      | `/data/repos/<owner>/<repo>/`. Each tenant still clones privately, and the host checkout is **not** the working copy |

**One supervised engine child per `(tenant × pipeline)` pipeline.** A tenant that
declares no [pipelines](configuration.md#pipelines) has one `work` pipeline, so the
default is one child per tenant; a tenant declaring `work` and `intake` gets two,
each reconciled on its own ([Supervising pipelines](architecture.md#supervising-pipelines)).
The bootstrapper discovers children
via the root's `workspace` arm, either walking to `workspace.depth` (default `1`)
or resolving the declared `workspace.tenants` list ([Declaring the fleet](#declaring-the-fleet-workspacetenants)).
It treats every resolved directory with a root-level `phoebe.config.ts` as a
tenant, and never treats the workspace root itself as a tenant. Bad children are
skip-and-warned; a duplicate `repoSlug` aborts boot.

**Private clones.** Discovery reads config and secrets from the on-disk child
checkout; the engine still runs against a private clone under
`/data/repos/<owner>/<repo>/`. The host workspace is read-only discovery +
config; the working copy only ever lives on the container volume.

## Operator owns all git in the tree

**Phoebe never runs `git` in the workspace tree.** It does not clone, fetch,
`submodule add`, `submodule update`, or commit there. The operator (or host CI)
puts a materialized checkout of each child on disk and keeps it current. How is
your choice:

- **Plain clones (simplest):** `git clone <url> <dir>` for each child under the
  root, with no root git repo needed. This is what the
  [runbook](#operator-runbook) below shows.
- **Submodules:** `git init` the root, then `git submodule add <url> <dir>` per
  child and `git submodule update --init` **before** boot. Useful when you want
  the root to be a super-repo that pins each child at a reviewed SHA.
- **Anything else** that leaves a real checkout on disk (worktrees, a sync tool,
  a bind of an existing clone) works the same, because discovery only reads what
  is there.

An empty or unmaterialized child directory is skip-and-warned until the checkout
exists on disk. Refreshing a child's content (a `git pull` or `submodule
update`) moves mtime; the fleet reads that as a changed tenant (mtime:size
fingerprint), re-reads its pipelines, and respawns the pipelines the edit actually moved.

## Two-tier `.env` model

| Tier                  | Path                  | Contents                                                                                                                                            | Who sees it                                                        |
| --------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Root (deployment)** | `workspace-root/.env` | Engine-checkout `GH_TOKEN`, default provider keys if used at boot, `PHOEBE_*` runtime toggles                                                       | Bootstrapper / compose; **not** handed wholesale to tenant engines |
| **Child (tenant)**    | `child/.env`          | That repo's `GH_TOKEN` + the active provider key (under the App arm `GH_TOKEN` may be blank here, since the bootstrapper synthesizes it at startup) | That tenant's engine child only, after env-scrub                   |

**Config↔env binding is 1:1 by co-location**: each child dir has
one `phoebe.config.ts` and one `.env`. The bootstrapper parses each child's `.env`
in-process and builds a deny-by-default env for that engine child
(`buildEngineChildEnv`, #61). The deployment engine-clone credential never
spreads into children; sibling tenants never receive each other's secrets in
env.

**Rotating a tenant's `GH_TOKEN` lands in place, with no relaunch.** Editing only
the `GH_TOKEN` line in a child's `.env` does not drain-and-respawn that child:
the bootstrapper re-reads the file when the running engine next asks for its
credential lease (top of each poll, and again just before each agent spawn), and
the engine assigns the fresh value into its live environment. Nothing in the
engine caches the token, so the rotation takes effect at the next unit boundary.
Only the token's **value** is invisible to reconcile: _removing_ (or blanking)
the `GH_TOKEN` line still relaunches the child, because the lease cannot deliver
an absence and the respawn is what stops a deleted token being used. Any **other**
`.env` edit, such as provider keys or identity vars, also relaunches the child.
Those values are frozen into the scrubbed child env at spawn and a relaunch is
the only way to deliver them.

**Git identity is layered, not scrubbed.** A child's declared `gitIdentity`
(`phoebe.config.ts`) is applied above the bootstrapper's own `GIT_*` and the App
arm's bot fallback, and below that child's `.env`, so a repo can carry its own
commit attribution into any deployment, and a deployment can still override it
per tenant ([`configuration.md` → Commit attribution](configuration.md#commit-attribution-gitidentity)).

**On-disk residual:** all children share one container uid, so
a prompt-injected agent can still _read_ another child's `.env` file off the
shared `/etc/phoebe` mount. Env-scrub is the runtime isolation boundary, not
filesystem ACL. Co-locate only repos in the same trust domain. See
[`trust.md`](trust.md#one-container--one-trust-domain).

## Adding a tenant

There is no `add-child` verb. Placing the child checkout is the operator's job,
whether by `git clone`, a submodule, or anything else. Phoebe only scaffolds the in-tree
install into a directory you already put on disk:

```bash
git clone <url> widget          # or: git submodule add <url> widget
phoebe init --tenant widget     # scaffolds widget/phoebe.config.ts + .env.example
```

Registration is then an edit **you** make to the root `phoebe.config.ts` (adding
the dir to `workspace.tenants`, on the declared arm). Phoebe never edits your
fleet declaration. `workspace.tenants` is yours, and no migration may add,
remove, or reorder it. On the walk arm, the checkout appearing under the root is
the registration. Either way the running bootstrapper picks the child up on its
next poll.

| Concern                  | Where it lives                                                         |
| ------------------------ | ---------------------------------------------------------------------- |
| Create deployment root   | `phoebe init --workspace [dir]`                                        |
| Add a tenant skeleton    | Operator places the checkout → `phoebe init --tenant <dir>`            |
| Authoritative identity   | Child config `repoSlug` (origin cross-check is best-effort validation) |
| Deployment secrets       | Root `.env`                                                            |
| Per-tenant secrets       | `<child>/.env`                                                         |
| Container templates      | Root `container/` (children never get `container/`)                    |
| Who runs git on the tree | **Operator always.** The child checkouts are operator-owned            |

## Mode selection

Detection ladder at boot (`bootstrap/tenants.ts`):

1. Root config has a `workspace` block → **workspace** mode.
2. Else → **solo** (single-repo) mode.

Modes are mutually exclusive **per deployment**. Use solo when one repo is one
deployment; use workspace when the children are the project checkouts sitting
under the workspace root.

The `repos/<owner>/<repo>/` (nested) layout was **removed in 0.4.0**. A root
still carrying a `repos/` directory fails boot with a message naming the removal
rather than falling through to solo and dying on a missing required field.

### Discovery arms

The `workspace` block declares exactly one of two ways to find the children.
Declaring both is an error:

| Arm                       | Fleet membership                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `{ depth: 1 }`            | **Walked.** Every child under the root carrying a `phoebe.config.ts`. `depth` is optional, and `workspace: {}` defaults it to `1`. |
| `{ tenants: ["widget"] }` | **Declared.** Exactly the directories listed, in the order listed.                                                                 |

Everything below this section describes the **walk** arm, which is the default
and what `phoebe init --workspace` scaffolds. For the declared arm, covering
explicit order, hold-not-fatal, out-of-tree entries, `phoebe list` accounting,
and the add-a-child delta, see [Declaring the fleet](#declaring-the-fleet-workspacetenants).

## Declaring the fleet (workspace.tenants)

When fleet membership and supervision order should be reviewable in the config
diff rather than emergent from whatever happens to be on disk, declare the fleet
explicitly:

```typescript
workspace: {
  tenants: ["service-a", "service-b"];
}
```

**Declared order is authoritative.** The list is spawn order, `phoebe list`
order, and warn order. It is not sorted by `repoSlug`.

**Entries are directory paths** resolved against the workspace root. Absolute
paths and `..` chains are deliberately supported so a root may supervise repos
outside the workspace checkout. Out-of-tree entries are a **host-location
affordance only**: they are not inside the `:ro` mount at `/etc/phoebe`, so
Phoebe reads config from the host path at boot/list time but such a tenant
**holds** rather than boots in the container.

**Hold-not-fatal.** Anything discovery observes about a single declared
directory is skip-and-warn and **hold**: an absent dir, no config, an unreadable
config, an empty `repoSlug`, or an origin mismatch. A declared tenant is never
`removed` by discovery, and deleting a checkout on disk keeps the child running until you edit
the config.

**Accounting in `phoebe list`.** On the explicit arm, `phoebe list` prints one
row per declared entry in declared order. The header reads `N of M declared
tenant(s)`. Rows that cannot boot show `held — <reason>`. Config-carrying
directories on disk that are not in the list surface as `undeclared`, a drift
check that boot never walks the tree for. See
[`operating.md`](operating.md#running-many-repos-in-one-container) for the
shared `held — <reason>` rendering plus `--json` and `--check`.

**Add a child (delta from the walk arm).** After linking a checkout and running
`phoebe init --tenant`, paste the line the command prints into the root
`workspace.tenants` array. Phoebe never edits your fleet declaration.
`workspace.tenants` is yours, and no migration may add, remove, or reorder it. See
[runbook step 3](#3-per-child-place-a-checkout-scaffold-secret) for the full
flow.

## Operator runbook

End-to-end: create root → add children → materialize → boot.

### 1. Create the workspace root

```bash
npx --yes phoebe-agent init --workspace ./my-workspace
cd ./my-workspace
```

That scaffolds a bootable root:

- `phoebe.config.ts` with `engine` + `workspace: { depth: 1 }` (no per-repo
  install/check/test fields, which live on children),
- deployment `.env.example` (engine token + toggles; not tenant secrets),
- `.gitignore` (`.env`, `node_modules/`),
- `container/` (same single-deployment templates as #57).

Copy and fill the root `.env`, and pin the engine:

```bash
cp .env.example .env
# Edit .env: GH_TOKEN for the engine clone, optional PHOEBE_* toggles
# Edit phoebe.config.ts: engine.ref (replace "vX.Y.Z" with a released tag, or use "main")
```

### 2. Make the root a git repo (if using submodules)

```bash
git init
# optional: first commit of the scaffold so submodule add has a parent tree
```

The workspace root need **not** be a git repository for discovery itself. That
matters only for submodule workflow, and so `.git` (including `.git/modules/…`) is present on
the host path that compose bind-mounts.

### 3. Per child: place a checkout, scaffold, secret

**Walk arm** (the default, `workspace: { depth }`):

```bash
# Put a checkout on disk. A plain clone is simplest and needs no root git repo:
git clone https://github.com/acme/service-a.git service-a
# ...or, if the root is a super-repo, add it as a submodule instead:
# git submodule add https://github.com/acme/service-a.git service-a

npx --yes phoebe-agent init --tenant ./service-a
# Edit service-a/phoebe.config.ts if needed (repoSlug/repoUrl are prefilled from origin when present)
cp service-a/.env.example service-a/.env
# Fill service-a/.env: that repo's GH_TOKEN + provider key
```

The walk finds each child on the next poll, with no root-config edit.

**Declared arm** (`workspace: { tenants: [...] }`):

```bash
# 1. Link the checkout (same as walk — Phoebe never runs git here):
git clone https://github.com/acme/service-a.git service-a

# 2. Scaffold the in-tree install:
npx --yes phoebe-agent init --tenant ./service-a
# Edit service-a/phoebe.config.ts if needed; copy and fill service-a/.env

# 3. Paste the line init --tenant printed into the root workspace.tenants array:
#    workspace: { tenants: ["service-a", "service-b"] },
```

`init --tenant` detects the declared arm and prints the exact entry to paste;
it refuses to edit the root config. Until the entry is in the list, the child
silently never boots, so step 3 is not optional.

Repeat for each child. `init --tenant` refuses if `phoebe.config.ts` already
exists (loud no-clobber). It does **not** create `container/` under the child.

### 4. Materialize checkouts before boot (submodules only)

Plain clones are already material, so skip this step. If your children are
submodules, populate them first:

```bash
git submodule update --init
# or: git submodule update --init --recursive
```

Either way, an empty child dir is skipped with a warning and is not supervised
until a real checkout appears.

### 5. Boot

From `container/`, the same compose shape solo uses, with the whole parent dir
mounted `:ro` at `/etc/phoebe` (keep each child's `.git` on the mount so the origin
cross-check can read it; it is a best-effort check, not required):

```bash
cd container
docker compose --env-file ../.env build
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once   # optional preview
docker compose --env-file ../.env up -d
```

`phoebe boot` then:

1. Selects workspace mode from the root `workspace` block,
2. Discovers children (walks to `depth`, or resolves the declared `tenants`
   list, see [Declaring the fleet](#declaring-the-fleet-workspacetenants)),
3. Sweeps each tenant's stale state — the disk of pipelines the config no
   longer declares — before spawning anything, and again after a later pipeline-set
   change has drained the pipelines it removed
   ([Reclaiming what a pipeline leaves behind](architecture.md#reclaiming-what-a-pipeline-leaves-behind)).
   A sweep that fails never holds up a spawn,
4. Hands the discovered set to the #57 fleet (one engine child per pipeline,
   env-scrub, shared concurrency cap, reconcile re-reads the block every poll).

See the mount notes beside the scaffolded templates
(`container/README.md` when produced by `init --workspace`) for why each child's
`.git` should stay on the mount (origin cross-check) and why submodule children
must be material before first boot.

## Fleet invariants

The fleet the supervisor walks is a **(tenant × pipeline) matrix**, not a list of
tenants: the unit it spawns, keys, and reclaims slots for is a pipeline, and a tenant
declaring two pipelines contributes two pipelines. A deployment that never declares
`pipelines` has one pipeline per tenant, which is what the invariants below always
described. The model is [`pipelines.md`](pipelines.md).

- One container, one shared engine version (`engine` only on the root).
- `paths` still derive from each tenant's `repoSlug` under `/data/repos/…`, and
  every pipeline of a tenant shares them, partitioned rather than duplicated
  ([`pipelines.md`](pipelines.md#what-a-pipeline-owns-on-disk)).
- One fleet-wide slot cap over **pipelines**, derived from the pipelines' `concurrency` and
  overridable with `PHOEBE_MAX_CONCURRENT_AGENTS`
  ([configuration.md](configuration.md#concurrency-the-pipelines-knob-and-the-fleets-cap)).
  The queue is served oldest waiter first and turns are taken per pipeline, so three
  pipelines queue as three streams.
- A pipeline's death is its own: the container exits only when every pipeline is
  crash-looping at once.
- Log lines tagged `[phoebe:<owner>/<repo>:<pipeline>]` (match as a prefix).
- Trust domain: one container = co-locate only mutually trusted repos
  ([`trust.md`](trust.md#one-container--one-trust-domain)).
- **Phoebe never edits your fleet declaration.** `workspace.tenants` is yours,
  and no migration may add, remove, or reorder it. Migrations may only rewrite
  config content (e.g., `workOrder`) and scaffold missing artifacts. See
  [`upgrading.md` → What Phoebe may write](upgrading.md#what-phoebe-may-write-in-your-repos).

## Related work

| Topic                                                        | Where                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Explicit `workspace.tenants` arm (declared fleet)            | #127, [Declaring the fleet](#declaring-the-fleet-workspacetenants) |
| Discovery contract (depth, prune, skip-and-warn, duplicates) | #82, `bootstrap/tenants.ts`                                        |
| Mode ladder (workspace vs. solo)                             | #83                                                                |
| Child in-tree layout                                         | #84                                                                |
| Origin cross-check / slug uniqueness                         | #85                                                                |
| Reconcile re-walk; operator owns git                         | #86                                                                |
| Mount model (`:ro`, include `.git`)                          | #87                                                                |
| Scaffold profiles / this runbook                             | #88                                                                |
| Fleet operating commands                                     | [`operating.md`](operating.md#running-many-repos-in-one-container) |
| Pipelines: pipelines within a tenant                         | [`pipelines.md`](pipelines.md)                                     |
