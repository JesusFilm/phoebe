# Workspace mode: topology and operator runbook

How to run Phoebe at the root of a **workspace** whose child project repos each
sit in their own directory with an in-tree Phoebe install. A child directory can
be a plain clone, a git submodule, a git worktree — any on-disk checkout;
submodules are supported but **not required**. One container discovers whatever
is on disk, and the multi-tenant fleet supervisor (#57) runs one engine child
per tenant.

Workspace mode is a **discovery source**: what it contributes is the tenant
list. Everything downstream — the shared engine, per-tenant children, fleet
concurrency cap, env-scrub isolation, and reconcile loop — is the #57 fleet
supervisor. It is one of the two supported layouts; the other is solo, one repo
per deployment (see [Mode selection](#mode-selection)).

For day-to-day labels and janitors, see [`operating.md`](operating.md), and
[configuration.md → Multiple repos](configuration.md#multiple-repos-workspace-tenants)
for the config-field view of the same layout.

For a complete worked layout — the `engine` + `workspace: { depth }` root config
plus two placeholder child checkouts — see
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

| Layer              | Who owns it            | What it holds                                                                                                     |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Root**           | deployment / workspace | Shared `engine` + `workspace: { depth }` or `{ tenants }`; deployment-level `.env`; `container/`                  |
| **Child (tenant)** | each linked repo       | In-tree `phoebe.config.ts` + gitignored `.env` (+ optional `prompts/`); **no** `container/`                       |
| **Private clone**  | container volumes      | `/data/repos/<owner>/<repo>/` — each tenant still clones privately; the host checkout is **not** the working copy |

**One supervised engine child per tenant.** The bootstrapper discovers children
via the root's `workspace` arm — walk to `workspace.depth` (default `1`) or the
declared `workspace.tenants` list ([Declaring the fleet](#declaring-the-fleet-workspacetenants))
— treats every resolved directory with a root-level `phoebe.config.ts` as a
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
  root — no root git repo needed. This is what the
  [runbook](#operator-runbook) below shows.
- **Submodules:** `git init` the root, then `git submodule add <url> <dir>` per
  child and `git submodule update --init` **before** boot — useful when you want
  the root to be a super-repo that pins each child at a reviewed SHA.
- **Anything else** that leaves a real checkout on disk (worktrees, a sync tool,
  a bind of an existing clone) works the same — discovery only reads what is
  there.

An empty or unmaterialized child directory is skip-and-warned until the checkout
exists on disk. Refreshing a child's content (a `git pull` or `submodule
update`) moves mtime; the fleet treats that as a changed tenant (mtime:size
fingerprint) and will respawn that child.

## Two-tier `.env` model

| Tier                  | Path                  | Contents                                                                                                                                     | Who sees it                                                      |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Root (deployment)** | `workspace-root/.env` | Engine-checkout `GH_TOKEN`, default provider keys if used at boot, `PHOEBE_*` runtime toggles                                                | Supervisor / compose; **not** handed wholesale to tenant engines |
| **Child (tenant)**    | `child/.env`          | That repo's `GH_TOKEN` + the active provider key (under the App arm `GH_TOKEN` may be blank here — the supervisor synthesizes it at startup) | That tenant's engine child only, after env-scrub                 |

**Config↔env binding is 1:1 by co-location**: each child dir has
one `phoebe.config.ts` and one `.env`. The supervisor parses each child's `.env`
in-process and builds a deny-by-default env for that engine child
(`buildEngineChildEnv` — #61). The deployment engine-clone credential never
spreads into children; sibling tenants never receive each other's secrets in
env.

**On-disk residual:** all children share one container uid, so
a prompt-injected agent can still _read_ another child's `.env` file off the
shared `/etc/phoebe` mount. Env-scrub is the runtime isolation boundary, not
filesystem ACL. Co-locate only repos in the same trust domain — see
[`trust.md`](trust.md#one-container--one-trust-domain).

## Adding a tenant

There is no `add-child` verb. Placing the child checkout — `git clone`, a
submodule, whatever — is the operator's job; Phoebe only scaffolds the in-tree
install into a directory you already put on disk:

```bash
git clone <url> widget          # or: git submodule add <url> widget
phoebe init --tenant widget     # scaffolds widget/phoebe.config.ts + .env.example
```

Registration is then an edit **you** make to the root `phoebe.config.ts` (adding
the dir to `workspace.tenants`, on the declared arm) — Phoebe never writes that
file. On the walk arm, the checkout appearing under the root is the
registration. Either way the running supervisor picks the child up on its next
poll.

| Concern                  | Where it lives                                                         |
| ------------------------ | ---------------------------------------------------------------------- |
| Create deployment root   | `phoebe init --workspace [dir]`                                        |
| Add a tenant skeleton    | Operator places the checkout → `phoebe init --tenant <dir>`            |
| Authoritative identity   | Child config `repoSlug` (origin cross-check is best-effort validation) |
| Deployment secrets       | Root `.env`                                                            |
| Per-tenant secrets       | `<child>/.env`                                                         |
| Container templates      | Root `container/` (children never get `container/`)                    |
| Who runs git on the tree | **Operator always** — the child checkouts are operator-owned           |

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

The `workspace` block declares exactly one of two ways to find the children —
declaring both is an error:

| Arm                       | Fleet membership                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `{ depth: 1 }`            | **Walked.** Every child under the root carrying a `phoebe.config.ts`. `depth` is optional — `workspace: {}` defaults it to `1`. |
| `{ tenants: ["widget"] }` | **Declared.** Exactly the directories listed, in the order listed.                                                              |

Everything below this section describes the **walk** arm, which is the default
and what `phoebe init --workspace` scaffolds. For the declared arm — explicit
order, hold-not-fatal, out-of-tree entries, `phoebe list` accounting, and the
add-a-child delta — see [Declaring the fleet](#declaring-the-fleet-workspacetenants).

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
order, and warn order — not sorted by `repoSlug`.

**Entries are directory paths** resolved against the workspace root. Absolute
paths and `..` chains are deliberately supported so a root may supervise repos
outside the workspace checkout. Out-of-tree entries are a **host-location
affordance only**: they are not inside the `:ro` mount at `/etc/phoebe`, so
Phoebe reads config from the host path at boot/list time but such a tenant
**holds** rather than boots in the container.

**Hold-not-fatal.** Anything discovery observes about a single declared
directory — absent dir, no config, unreadable config, empty `repoSlug`, origin
mismatch — is skip-and-warn and **hold**. A declared tenant is never `removed`
by discovery; deleting a checkout on disk keeps the child running until you edit
the config.

**Accounting in `phoebe list`.** On the explicit arm, `phoebe list` prints one
row per declared entry in declared order. The header reads `N of M declared
tenant(s)`. Rows that cannot boot show `held — <reason>`. Config-carrying
directories on disk that are not in the list surface as `undeclared` (a drift
check — boot never walks the tree for this). See
[`operating.md`](operating.md#running-many-repos-in-one-container) for the
shared `held — <reason>` rendering plus `--json` and `--check`.

**Add a child (delta from the walk arm).** After linking a checkout and running
`phoebe init --tenant`, paste the line the command prints into the root
`workspace.tenants` array — Phoebe never edits the root config for you. See
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
  install/check/test fields — those live on children),
- deployment `.env.example` (engine token + toggles; not tenant secrets),
- `.gitignore` (`.env`, `node_modules/`),
- `container/` (same single-deployment templates as #57).

Copy and fill the root `.env`, and pin the engine:

```bash
cp .env.example .env
# Edit .env: GH_TOKEN for the engine clone, optional PHOEBE_* toggles
# Edit phoebe.config.ts: engine.ref (e.g. "v0.1.0" or "main")
```

### 2. Make the root a git repo (if using submodules)

```bash
git init
# optional: first commit of the scaffold so submodule add has a parent tree
```

The workspace root need **not** be a git repository for discovery itself — only
for submodule workflow and so `.git` (including `.git/modules/…`) is present on
the host path that compose bind-mounts.

### 3. Per child: place a checkout, scaffold, secret

**Walk arm** (default — `workspace: { depth }`):

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

The walk finds each child on the next poll — no root-config edit.

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
silently never boots — step 3 is not optional.

Repeat for each child. `init --tenant` refuses if `phoebe.config.ts` already
exists (loud no-clobber). It does **not** create `container/` under the child.

### 4. Materialize checkouts before boot (submodules only)

Plain clones are already material — skip this step. If your children are
submodules, populate them first:

```bash
git submodule update --init
# or: git submodule update --init --recursive
```

Either way, an empty child dir is skipped with a warning and is not supervised
until a real checkout appears.

### 5. Boot

From `container/`, the same compose shape solo uses — whole parent dir mounted
`:ro` at `/etc/phoebe` (keep each child's `.git` on the mount so the origin
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
   list — see [Declaring the fleet](#declaring-the-fleet-workspacetenants)),
3. Hands the discovered set to the #57 fleet (one engine child per tenant,
   env-scrub, shared concurrency cap, reconcile re-reads the block every poll).

See the mount notes beside the scaffolded templates
(`container/README.md` when produced by `init --workspace`) for why each child's
`.git` should stay on the mount (origin cross-check) and why submodule children
must be material before first boot.

## Fleet invariants

- One container, one shared engine version (`engine` only on the root).
- `paths` still derive from each tenant's `repoSlug` under `/data/repos/…`.
- Fleet-wide `PHOEBE_MAX_CONCURRENT_AGENTS` (default 1).
- Log lines tagged `[phoebe:<owner>/<repo>]`.
- Trust domain: one container = co-locate only mutually trusted repos
  ([`trust.md`](trust.md#one-container--one-trust-domain)).

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
