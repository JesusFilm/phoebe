# Container mount, workspace root

**Who this is for:** anyone running a workspace deployment, where one container
serves several repositories. It explains what the mount has to contain and why.

The compose file binds the entire deployment directory, meaning the parent of
`container/`, into the container at `/etc/phoebe` read-only:

```yaml
volumes:
  - ..:/etc/phoebe:ro
working_dir: /etc/phoebe
```

One directory mount rather than one per child. That way `phoebe boot` re-walks
the tree every poll and sees children come and go without a recreate.

## Workspace specifics

### Keep each child's `.git` on the mount

The child-origin cross-check reads each child's `remote.origin.url`, so keep
`.git` on the mounted path. Do not exclude it, and do not use a bind that stops
at the working tree. Where the origin lives depends on how the child is checked
out:

```text
<child>/.git/config              # plain clone: .git is a directory
<child>/.git  ->  ../.git/modules/<child>/config   # submodule: .git is a file pointing at the root
<child>/.git  ->  <main-checkout>/.git/config      # linked worktree: .git is a file, resolved via commondir
```

Only the plain clone keeps `config` under `<child>/.git/` directly. A submodule
and a linked worktree both have a `.git` **file** that points elsewhere, so the
directory it resolves to has to be on the mount too, or the lookup fails.

The check is a safety net rather than a requirement. If the resolved git
directory is not visible in the container, the child's config `repoSlug` is taken
as authoritative. Keeping it present lets Phoebe catch a checkout pointed at the
wrong remote.

### Materialize child checkouts before boot

Phoebe never runs `git` in the workspace tree. You place each child checkout on
disk yourself. An empty or unmaterialized child directory is a **skip-and-warn**
tenant: boot carries on, and that child goes unsupervised until the checkout
exists.

A plain clone is material the moment you `git clone` it. If your children are
submodules, populate them before `docker compose up`:

```bash
git submodule update --init --recursive
```

Then start the container from `container/` as usual, with `--env-file ../.env`.

### What lands on the mount

| Path | Role |
| ---- | ---- |
| `phoebe.config.ts` | Root only: `engine` + `workspace: { depth }` |
| `<child>/phoebe.config.ts` | Authoritative per-tenant config (`repoSlug`, …) |
| `<child>/.env` | Per-tenant secrets (gitignored on the host) |
| `<child>/.git` and whatever it resolves to | Origin metadata for the best-effort cross-check. A directory for a plain clone, a file pointing at the root `.git/modules/` or the main checkout otherwise |
| `container/` | Image + compose (this directory) |

The root `.env` holds deployment secrets: `GH_TOKEN` for the engine checkout and
the `PHOEBE_*` runtime toggles.

**Put each child's provider key in that child's own `.env`.** The env-scrub builds
every engine child's environment from its co-located `.env`, so a provider key
sitting only at the root never reaches a tenant, and a child without one has no
key for its provider.

### Read-only means host checkouts are never written

The local checkout tree is for discovery and config, nothing else. Phoebe still
clones each tenant privately under `/data/repos/<owner>/<repo>/`. The `:ro` flag
is what guarantees the host workspace is never a working copy.
