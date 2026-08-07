# Workspace mode: topology and operator runbook

How to run Phoebe at the root of a **workspace** whose child project repos each
sit in their own directory with an in-tree Phoebe install. A child directory can
be a plain clone, a git submodule, a git worktree — any on-disk checkout;
submodules are supported but **not required**. One container discovers whatever
is on disk, and the multi-tenant fleet supervisor (#57) runs one engine child
per tenant.

Workspace mode is a **discovery source** only. The shared engine, per-tenant
children, fleet concurrency cap, env-scrub isolation, and reconcile loop are
the same machinery as the nested `repos/<owner>/<repo>/` layout. Nested
discovery is not removed — pick one mode per deployment (see [Mode selection](#mode-selection)).

For day-to-day labels and janitors, see [`operating.md`](operating.md). For the
nested add-repo path, see
[configuration.md → Multiple repos](configuration.md#multiple-repos-nested-tenants)
and [operating.md → Running many repos](operating.md#running-many-repos-in-one-container).

For a complete worked layout — the `engine` + `workspace: { depth }` root config
plus two placeholder child checkouts — see
[`examples/workspace/`](../examples/workspace/).

## Topology

```text
workspace-root/                         # bind-mounted :ro → /etc/phoebe
  phoebe.config.ts                      # engine + workspace: { depth } only
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
| **Root**           | deployment / workspace | Shared `engine` + `workspace: { depth }`; deployment-level `.env`; `container/`                                   |
| **Child (tenant)** | each linked repo       | In-tree `phoebe.config.ts` + gitignored `.env` (+ optional `prompts/`); **no** `container/`                       |
| **Private clone**  | container volumes      | `/data/repos/<owner>/<repo>/` — each tenant still clones privately; the host checkout is **not** the working copy |

**One supervised engine child per tenant.** The bootstrapper walks the tree to
`workspace.depth` (default `1`), treats every directory with a root-level
`phoebe.config.ts` as a tenant, and never treats the workspace root itself as a
tenant. Bad children are skip-and-warned; a duplicate `repoSlug` aborts boot.

**Private clones.** Discovery reads config and secrets from the on-disk child
checkout; the engine still runs against a private clone under
`/data/repos/<owner>/<repo>/`. The host workspace is read-only discovery +
config — same isolation invariant as nested multi-tenant.

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

| Tier                  | Path                  | Contents                                                                                      | Who sees it                                                      |
| --------------------- | --------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Root (deployment)** | `workspace-root/.env` | Engine-checkout `GH_TOKEN`, default provider keys if used at boot, `PHOEBE_*` runtime toggles | Supervisor / compose; **not** handed wholesale to tenant engines |
| **Child (tenant)**    | `child/.env`          | That repo's `GH_TOKEN` + the active provider key                                              | That tenant's engine child only, after env-scrub                 |

**Config↔env binding is 1:1 by co-location**, same as nested: each child dir has
one `phoebe.config.ts` and one `.env`. The supervisor parses each child's `.env`
in-process and builds a deny-by-default env for that engine child
(`buildEngineChildEnv` — #61). The deployment engine-clone credential never
spreads into children; sibling tenants never receive each other's secrets in
env.

**On-disk residual (same as nested):** all children share one container uid, so
a prompt-injected agent can still _read_ another child's `.env` file off the
shared `/etc/phoebe` mount. Env-scrub is the runtime isolation boundary, not
filesystem ACL. Co-locate only repos in the same trust domain — see
[`trust.md`](trust.md#one-container--one-trust-domain).

## Nested `add-repo` ↔ workspace `init --tenant`

Two ways to put many repos under one container; same fleet underneath.

| Concern                  | Nested (`repos/`)                                              | Workspace                                                                                   |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Create deployment root   | `phoebe init` (then add tenants)                               | `phoebe init --workspace [dir]`                                                             |
| Add a tenant skeleton    | `phoebe add-repo <owner/repo>` (mints `repos/<owner>/<repo>/`) | Operator: `git clone` (or `git submodule add`) `<url> <dir>` → `phoebe init --tenant <dir>` |
| Authoritative identity   | Path segment `<owner>/<repo>` (must match `repoSlug`)          | Child config `repoSlug` (origin cross-check is best-effort validation)                      |
| Deployment secrets       | Root `.env`                                                    | Root `.env`                                                                                 |
| Per-tenant secrets       | `repos/<owner>/<repo>/.env`                                    | `<child>/.env`                                                                              |
| Container templates      | Root `container/`                                              | Root `container/` (children never get `container/`)                                         |
| Who runs git on the tree | Operator (optional clones for host review)                     | **Operator always** — the child checkouts are operator-owned                                |

`add-repo` **mints a directory** under `repos/` from a slug. Workspace
`init --tenant` scaffolds an **existing** directory you already put on disk (you
pass the path). There is no `add-child` verb: placing the child checkout —
`git clone`, a submodule, whatever — is your job; Phoebe only scaffolds the
in-tree install.

## Mode selection

Detection ladder at boot (`bootstrap/tenants.ts`):

1. Root config has a `workspace` block → **workspace** mode  
   (if `repos/` also exists → workspace wins, with a warning; `repos/` is ignored).
2. Else a `repos/` directory is present → **nested** mode.
3. Else → **flat** (single-repo) mode.

Modes are mutually exclusive **per deployment**. Use nested when the deployment
owns tenant directories under `repos/`; use workspace when the children are the
project checkouts sitting under the workspace root.

### Discovery arms

The `workspace` block declares exactly one of two ways to find the children —
declaring both is an error:

| Arm                       | Fleet membership                                                      |
| ------------------------- | --------------------------------------------------------------------- |
| `{ depth?: 1 }`           | **Walked.** Every child under the root carrying a `phoebe.config.ts`. |
| `{ tenants: ["widget"] }` | **Declared.** Exactly the directories listed, in the order listed.    |

Everything below this section describes the **walk** arm, which is the default
and what `phoebe init --workspace` scaffolds. The declared arm's field shape and
validation have landed — entries normalize, absolute and `..` paths supervise
repos outside the workspace checkout, and an entry that is (or contains) the
root, a duplicate, a nested pair, or a glob is rejected at load — but discovery
for a declared fleet is not wired yet: `phoebe boot` and `phoebe list` refuse
such a config rather than falling back to a walk.

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

From `container/`, same compose shape as flat/nested — whole parent dir mounted
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
2. Walks children to `depth`,
3. Hands the discovered set to the #57 fleet (one engine child per tenant,
   env-scrub, shared concurrency cap, reconcile re-walk every poll).

See the mount notes beside the scaffolded templates
(`container/README.md` when produced by `init --workspace`) for why each child's
`.git` should stay on the mount (origin cross-check) and why submodule children
must be material before first boot.

## What stays the same as nested multi-tenant

- One container, one shared engine version (`engine` only on the root).
- `paths` still derive from each tenant's `repoSlug` under `/data/repos/…`.
- Fleet-wide `PHOEBE_MAX_CONCURRENT_AGENTS` (default 1).
- Log lines tagged `[phoebe:<owner>/<repo>]`.
- Trust domain: one container = co-locate only mutually trusted repos
  ([`trust.md`](trust.md#one-container--one-trust-domain)).

## Related work

| Topic                                                        | Where                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Discovery contract (depth, prune, skip-and-warn, duplicates) | #82, `bootstrap/tenants.ts`                                        |
| Mode ladder / coexistence with `repos/`                      | #83                                                                |
| Child in-tree layout                                         | #84                                                                |
| Origin cross-check / slug uniqueness                         | #85                                                                |
| Reconcile re-walk; operator owns git                         | #86                                                                |
| Mount model (`:ro`, include `.git`)                          | #87                                                                |
| Scaffold profiles / this runbook                             | #88                                                                |
| Nested operating commands                                    | [`operating.md`](operating.md#running-many-repos-in-one-container) |
