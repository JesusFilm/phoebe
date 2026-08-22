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
<child>/.git/config              # plain clone / worktree
.git/modules/<child>/config      # submodule
```

The check is a safety net rather than a requirement. With no `.git` on the
mount, the child's config `repoSlug` is taken as authoritative. Keeping `.git`
present lets Phoebe catch a checkout pointed at the wrong remote.

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
| `<child>/.git/` (or root `.git/modules/` for submodules) | Origin metadata for the best-effort cross-check |
| `container/` | Image + compose (this directory) |

The root `.env` holds deployment secrets: `GH_TOKEN` for the engine checkout,
default provider keys, and runtime toggles. Per-child secrets live in each
child's `.env`, and the fleet env-scrub hands each engine child only its own.

### Read-only means host checkouts are never written

The local checkout tree is for discovery and config, nothing else. Phoebe still
clones each tenant privately under `/data/repos/<owner>/<repo>/`. The `:ro` flag
is what guarantees the host workspace is never a working copy.
