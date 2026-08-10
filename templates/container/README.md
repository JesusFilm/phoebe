# Container mount — workspace root

The compose file binds the **entire deployment directory** (the parent of
`container/`) into the container at `/etc/phoebe` **read-only**:

```yaml
volumes:
  - ..:/etc/phoebe:ro
working_dir: /etc/phoebe
```

That mount model is deliberate: one directory mount, so `phoebe boot` re-walks
the tree every poll and sees children come and go without a recreate.

## Workspace specifics

### Keep each child's `.git` on the mount

The child-origin cross-check reads each child's `remote.origin.url`, so keep
`.git` on the mounted path — don't exclude it (e.g. no bind that stops at the
working tree only). Where the origin lives depends on how the child is checked
out:

```text
<child>/.git/config              # plain clone / worktree
.git/modules/<child>/config      # submodule
```

This check is a **best-effort** safety net, not a hard requirement: with no
`.git` on the mount, the child's config `repoSlug` is taken as authoritative.
Keeping `.git` present just lets Phoebe catch a checkout pointed at the wrong
remote.

### Materialize child checkouts before boot

Phoebe never runs `git` in the workspace tree — you place each child checkout on
disk. Empty or unmaterialized child directories are **skip-and-warned** tenants:
boot continues, that child is not supervised until the checkout exists.

A plain clone is material the moment you `git clone` it. If your children are
submodules, populate them before `docker compose up`:

```bash
git submodule update --init --recursive
```

Then start the container from `container/` as usual (with `--env-file ../.env`).

### What lands on the mount

| Path | Role |
| ---- | ---- |
| `phoebe.config.ts` | Root only: `engine` + `workspace: { depth }` |
| `<child>/phoebe.config.ts` | Authoritative per-tenant config (`repoSlug`, …) |
| `<child>/.env` | Per-tenant secrets (gitignored on the host) |
| `<child>/.git/` (or root `.git/modules/` for submodules) | Origin metadata for the best-effort cross-check |
| `container/` | Image + compose (this directory) |

The root `.env` holds **deployment** secrets (`GH_TOKEN` for the engine
checkout, default provider keys, runtime toggles). Per-child secrets live in
each child's `.env`; the fleet env-scrub hands each engine child only its own.

### Read-only means host checkouts are never written

The local checkout tree is discovery + config only. Each tenant is still
cloned privately under `/data/repos/<owner>/<repo>/`. The `:ro` flag is the
hard guarantee that the host workspace is never a working copy.
