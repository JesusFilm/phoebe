# Init, pin & upgrade

**Who this is for:** an operator moving a deployment from one engine version to
another. It answers which files are yours, how the pin works, and exactly what
Phoebe is allowed to write in your repo.

The contract between the published `phoebe-agent` package and a consumer repo:
what `phoebe init` scaffolds, which files you own, how the engine version is
pinned, and how upgrades roll out.

## The distribution model

You never vendor the engine source. The published `phoebe-agent` package is a
thin **bootstrapper**. `phoebe boot`, the container's main process, checks the
**engine** out separately from a git ref you name in your config. You keep only:

- a small `phoebe.config.ts` (see [`configuration.md`](configuration.md)),
- your `prompts/` overrides (or the shipped copies), and
- the container files `phoebe init` scaffolds.

Everything else lives in the engine and upgrades as a unit: the orchestration
loop, work-kind logic, git model, and providers.

## `phoebe init`, scaffold a consumer-owned runtime

```
npx --yes phoebe-agent init            # into the current directory
npx --yes phoebe-agent init ./phoebe   # into a subdirectory
```

It writes these files. All of them are consumer-owned, so commit them:

| File                          | Purpose                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `phoebe.config.ts`            | Consumer config starter. Edit the five required fields.                                                       |
| `prompts/`                    | Copies of the shipped agent prompts. Edit to override; leave as-is to use defaults.                           |
| `.env.example`                | Documented env vars. Copy to `.env` and fill secrets.                                                         |
| `.gitignore`                  | Phoebe entries **appended additively** (existing content untouched).                                          |
| `container/Dockerfile`        | Runtime image: Node 24 + git + `gh` + the `phoebe-agent` bootstrapper, run as the unprivileged `phoebe` user. |
| `container/compose.yml`       | The long-lived `phoebe boot` container + named volumes.                                                       |
| `container/compose.local.yml` | Dev-only overlay: run an engine checkout from your own machine.                                               |

**Existing files are left untouched**, so re-running `init` is safe and only
fills gaps. To regenerate one scaffolded file, delete it and re-run. Placeholder
tokens in the templates (the CLI bin name, your `installCommand`) are
substituted at scaffold time.

## Pinning the engine version

The engine version is a single knob, and it lives in `phoebe.config.ts` rather than in
`.env` and not in the image:

```ts
engine: { source: "github", ref: "vX.Y.Z" },
```

`vX.Y.Z` stands for a released tag. Pick one from
[the releases page](https://github.com/JesusFilm/phoebe/releases); the
[Quickstart](../README.md#quickstart) and [`ai-install.md`](ai-install.md) carry a
concrete one you can copy.

`phoebe boot` reads that field, checks the engine out at that ref, and runs it.
Two shapes, with deliberately different guarantees:

| `ref`             | Behaviour                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| a tag or full SHA | Exactly that commit, always. No crash-loop fallback. Pinning means pinning, and quietly serving different code than you asked for would be worse.    |
| a branch          | Follows the tip. Guarded: a commit that will not boot is quarantined after three fast crashes and boot pins back to the last one that ran healthily. |

**Pin an explicit released ref in a real deployment.** `main` is for
environments where you want every push, and accept the guard as the safety net.

`repo` defaults to the upstream engine repo; set it to run a fork. For an engine
checkout on your own machine, see `container/compose.local.yml`.

## Upgrading

Edit `engine.ref` in `phoebe.config.ts`, by hand or with the command that does
exactly that edit for you:

```bash
phoebe upgrade                  # prompt for a target, move to the latest release tag
phoebe upgrade v0.4.0 --both    # engine pin + npm CLI to one release
phoebe upgrade main --engine    # pin back to branch-following
phoebe upgrade --check [--json] # report current vs latest; exit 1 when behind
```

### What Phoebe may write in your repos

**Closed set.** The only things Phoebe may ever write in a consumer's repos:

- The `engine.ref` string literal in the root `phoebe.config.ts`, written by
  `phoebe upgrade` when it succeeds.
- Migration-owned config edits, such as appending a work kind to `workOrder`,
  written when a migration applies and validation succeeds.
- Migration-scaffolded artifacts such as new prompt files and compose fragments, written
  as create-if-absent; operator overrides are never touched.

The two migration entries are written by `phoebe migrate`, whether you invoke it
yourself or `phoebe upgrade` runs it for you. `upgrade` spawns the target
checkout's `migrate` before it moves the pin. Same writes, same closed set,
either way.

**Four prohibitions. Phoebe never:**

1. Edits your fleet declaration: `workspace.tenants` is yours. No migration may
   add, remove, or reorder tenants. See [Fleet invariants](workspace.md#fleet-invariants)
   and [Declaring the fleet](workspace.md#declaring-the-fleet-workspacetenants).
2. Commits. It writes files and lists them; the operator reviews and commits per
   repo.
3. Runs these writes from a boot, poll, or reconcile path. Only the two
   operator-initiated verbs, `upgrade` and `migrate`, may write.
4. Touches `/data`, named volumes, or git history.

Every other "Phoebe never writes" or "Phoebe never edits the root config" claim
in this documentation is a narrowing of rule 1 above: Phoebe may now write
config _content_, but it may never write your _fleet declaration_. See
[`workspace.md` → Declaring the fleet](workspace.md#declaring-the-fleet-workspacetenants).

### `phoebe upgrade`, moving the engine ref

`phoebe upgrade` is an operator-initiated command that moves you to a new engine
version in three steps, **in this order**:

1. **Materialize the target ref.** Clone or fetch the target engine checkout.
   Refs are validated against the remote **before** anything else happens, so a
   typo'd tag changes nothing.
2. **Run the target checkout's own migrations.** `upgrade` spawns
   `phoebe migrate` from the checkout it just materialized, not from the CLI you
   have installed. New code migrates old artifacts, so the facility upgrades
   itself. A checkout with no migrations index simply has no migrations, and the
   upgrade proceeds. Output is inherited verbatim; `upgrade` parses nothing and
   branches on the exit code alone.
3. **Write `engine.ref` last, or not at all.** Only if step 2 exits 0 does the
   pin move: the `engine.ref` string literal is rewritten (or the scaffold-shaped
   `engine` block inserted when absent) in place on the same inode, so the
   bind-mount watch keeps working. Anything fancier than a plain string literal is
   refused with the exact one-line edit printed, and the file stays yours. Every
   upgrade prints the previous ref plus the exact rollback command.

This ordering is the safety property: **a broken upgrade cannot land.** If the
target's migrations leave the root config invalid, the flip is aborted and the
deployment stays on the ref that was working. Per-child failures never block the
flip. Only root-level failure does.

Because step 2 runs automatically, `phoebe upgrade` can write migration-owned
config edits and migration-scaffolded artifacts before the pin moves. The second
and third items of the closed set above, not just the first. Running
`phoebe migrate` by hand afterwards is therefore not required; it is the same
work, and is idempotent if you do. Run it directly when you want to migrate
without moving the pin, or to re-run a child that was held or failed.

Recommended posture for production: **pin to release tags and advance with
`phoebe upgrade`**; branch-following is the opt-in live mode.

The `--cli` half runs `npm install -g phoebe-agent@<version>` on a host; inside
the container the launcher is baked into the image, so it prints the rebuild
step instead. A commit SHA or branch ref is engine-only, because the npm package has
no version for it.

**Two-voices output.** `phoebe upgrade` writes success lines and informational
notes to stdout and diagnostic warnings or refusal details to stderr. A script
that only wants the final result can redirect stderr; a human-facing terminal sees
both voices interleaved. The engine-refusal message goes to stderr and exits 1;
the engine-success message (`v0.3.0 → v0.4.0 written to …`) goes to stdout.

**`upgrade --check` and its gap.** `phoebe upgrade --check [--json]` reports
versions only: the configured engine ref versus the latest release tag, and the
installed CLI versus the npm registry. It does **not** preview what migrations
would run when you move to the target version. The reason: previewing migrations
requires materializing the target engine checkout, a full git clone on every
scripted check. That cost is deliberately deferred.

What the two modes preview:

- `upgrade --check` previews versions (current vs latest). It says "you are
  behind" but not "here is what will change in your files."
- `migrate --check` previews migrations on the ref you are **already on**, not
  the one you are moving to.

The gap is livable because the apply path has the same safety net: nothing
commits, failed children revert, and the ref flip lands last. If a migration
leaves the root config invalid the flip is aborted; if a child fails or has a
dirty tree it is skipped with instructions to re-run. The recorded escape hatch
would be a preview flag on `upgrade` that ran the target ref's migrations without
applying them. No such flag exists today: `upgrade` accepts `--engine`, `--cli`,
`--both`, `--check`, `--json`, and `--config`, and rejects anything else.
`migrate --check` previews migrations for the ref you are already on, not the
target.

However the edit happens, applying it works the same way:

Within one reconcile interval (`PHOEBE_RECONCILE_INTERVAL_MS`, default 60s) the
running `boot` notices the config changed and `SIGTERM`s the engine, which
finishes its current work unit and starts no new one. Boot then checks out the new ref, and
relaunches. Same container, no rebuild, no restart, no interrupted work unit.

> **How you write the file no longer matters.** `compose.yml` mounts the whole
> deployment directory at `/etc/phoebe`, not `phoebe.config.ts` on its own. An
> in-place edit, an editor's atomic save, and a `git pull` are all visible inside
> the container, and all of them fire the reconcile watch. The single-file mount
> this used to describe pinned the host inode and did need a
> `--force-recreate`; the directory mount is what replaced it.

Tracking a branch upgrades the same way with no edit at all: boot polls
`git ls-remote` and relaunches when the tip moves.

Rebuild the image only when the image itself changes, such as a new provider CLI, a
different base image, a new system package:

```bash
phoebe start --build
```

Raw compose fallback (e.g. from the `container/` directory, or off the scaffolded
layout):

```bash
docker compose --env-file ../.env build
docker compose --env-file ../.env up -d
```

The `--env-file ../.env` is needed because the scaffolded `.env` lives at the
scaffold root while the compose files live in `container/`; Compose otherwise
only auto-loads a `.env` sitting next to the compose file.

### `phoebe migrate`, reshaping your files for the current ref

`phoebe migrate` applies every registered migration against the deployment in
order, detecting whether each one is applicable, staging writes, validating the
result, and reverting on failure. It is safe to run repeatedly, because migrations are
idempotent by construction (a second run reports all not-applicable).

```bash
phoebe migrate                    # apply all migrations; list what was written
phoebe migrate --check            # preview: which migrations would apply? (no writes)
phoebe migrate --json             # apply, emit machine-readable report
phoebe migrate --check --json     # preview, machine-readable
phoebe migrate --config <path>    # specify the root phoebe.config.ts explicitly
```

**Exit codes:**

| Mode      | Exit 0                                                                            | Exit 1 (nonzero)                                      |
| --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| apply     | no root migration `failed`, so `up-to-date`, `migrated`, and `manual` all qualify | at least one **root** migration `failed`, do not flip |
| `--check` | nothing applicable                                                                | ≥1 migration is applicable                            |

**Only `failed` is nonzero.** A root verdict of `manual`, where a migration
declined to auto-rewrite and printed an instruction for you, exits **0**, even when
other migrations in the same run applied successfully. The exit code answers "is the deployment valid under the current schema, so the flip is safe?",
and a manual result leaves it exactly as valid as it was. It does **not** answer
"is there nothing left for you to do." Read the report, not just `$?`: scripted
gates that must catch outstanding manual work should check the verdicts rather
than the exit code.

In apply mode, per-child failures are never reported as the command's exit code
either: a child failing or being held does not set exit 1. Only root-level
failure (which would make the deployment invalid under the current schema)
triggers exit 1 and blocks the ref flip.

**Per-directory verdicts** (the `verdict` field in `--json`, a fixed closed union):

| Verdict      | When                                                                     | What you do                                                         |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `up-to-date` | No applicable migrations; deployment is current                          | Nothing, already done                                               |
| `migrated`   | At least one migration applied; config valid; paths listed               | Review the listed paths and commit in that repo                     |
| `manual`     | At least one migration declined to auto-rewrite                          | Follow the printed instruction; make the edit by hand, then re-run  |
| `reverted`   | A migration's writes failed post-apply validation and were rolled back   | Read the error, fix the config, then re-run                         |
| `failed`     | A migration errored outright (detect or apply threw); nothing written    | Read the error, fix the cause or re-run when the issue is resolved  |
| `invalid`    | Nothing was applicable, but the config was already broken before the run | Fix the config by hand, since no migration addresses it             |
| `pending`    | `--check` mode: at least one migration would apply                       | Run `phoebe migrate` (without `--check`) when ready                 |
| `skipped`    | Child's tree was dirty, or enumeration held it back; no migrations ran   | Commit or stash the child's uncommitted work, then re-run `migrate` |

**One verdict per directory, by precedence.** A directory gets exactly one
verdict even when its migrations disagree. There is no `partial`. In apply mode
the first match wins, in this order: `manual` → `reverted` → `failed` →
`migrated` → `invalid` → `up-to-date`. So a run that applied one migration and
had another decline reports `manual`, and the applied paths are still listed. In
check mode the order is `failed` → `pending` → `invalid` → `up-to-date`. Read
`migrations[]` for the per-migration picture; the verdict is a summary, not a
substitute.

**Clean-tree asymmetry.** A dirty child is passed over, taking verdict `skipped`
with `reason` naming the cause, while the root is not gated on a clean tree. The
clean-tree precondition on a child makes the on-failure revert precise, because every file in the revert set was placed
there by this run, so reversing it restores exactly the pre-migration state.
Without that guarantee a revert could clobber the operator's in-progress work.
The root must be able to land even when a child is dirty, because the deployment
needs to be valid under the new schema before the ref flip, so the root is
ungated. In practice, run `phoebe migrate` from a clean workspace: stage or
stash each child's pending work first.

After a run, any paths written are listed with a review command. Phoebe never
commits: review and commit the changes yourself.

**`--json` contract (not a field table).** The envelope is stable and
additive-only: fields may be added in later engine releases, never removed or
repurposed. There is no schema-version field, since any bump would strand exactly the
older CLIs that most need to upgrade. The shape:

```json
{
  "mode": "apply",
  "report": 1,
  "engine": { "dir": "/data/engine", "sha": "abc123def456", "source": "git" },
  "root": {
    "dir": "/etc/phoebe",
    "slug": "acme/deployment",
    "role": "solo-root",
    "verdict": "migrated",
    "validation": true,
    "migrations": [
      {
        "id": "add-research-prompt",
        "title": "Scaffold missing research-prompt.md",
        "status": "applied",
        "detail": "scaffold prompts/research-prompt.md from the shipped default",
        "paths": ["prompts/research-prompt.md"]
      },
      {
        "id": "add-research-to-workorder",
        "title": "Add \"research\" to workOrder",
        "status": "not-applicable",
        "detail": "",
        "paths": []
      }
    ]
  },
  "tenants": [],
  "counts": {
    "migrations": { "applied": 1, "applicable": 0, "failed": 0, "manual": 0, "notApplicable": 1 },
    "tenants": {
      "migrated": 0,
      "pending": 0,
      "upToDate": 0,
      "invalid": 0,
      "failed": 0,
      "reverted": 0,
      "manual": 0,
      "skipped": 0
    }
  },
  "ok": true
}
```

Key contract rules:

- `report: 1`, the envelope version. Constant.
- `ok` mirrors the process exit code: `true` → exit 0, `false` → exit nonzero.
- `mode` discriminates apply/check mode: the union of `migrations[].status` widens
  (apply: `applied`, `not-applicable`, `failed`, `manual`; check: `applicable`,
  `not-applicable`) rather than blurs. `applicable` never appears in apply output,
  `applied` never in check output.
- `root` and each entry in `tenants` share one entry shape, so a single parser
  handles both. `role` distinguishes them: `solo-root`, `workspace-root`, or
  `tenant`. A solo root always reports `"tenants": []`.
- `reason` is present **only** on a `skipped` entry, carrying why it was passed
  over. It is absent, not null, everywhere else.
- `slug` is the repo slug (`acme/service-a`), or `null` when the config declares
  none.
- `validation` is tri-state and must not be read as a boolean: `true` = the config
  was checked and is valid, `false` = checked and invalid, `null` = **not checked
  by this run**. Treating `null` as falsy reads "unknown" as "broken"; treating it
  as truthy reads it as "healthy". Neither is right, so branch on all three. See
  [validation is not a health check](#validation-is-not-a-health-check) below.
- `counts` is nested, not flat: `counts.migrations` tallies migration statuses
  across the root and every tenant combined, while `counts.tenants` tallies
  per-directory verdicts and excludes the root. A run whose only work was on the
  root therefore reports all-zero `counts.tenants`.
- `engine.source` is `git` when the engine is a git checkout (`engine.sha` holds
  its HEAD), or `local` for a local mount (`engine.sha` is `null`). The two always
  agree, and `source: "local"` implies `sha: null`.
- Pre-image file contents never appear: the journal holds them for revert only.
  Echoing operator file contents into logs and CI output is not acceptable.
- `migrations[].paths` is the single source for written files; there is no
  top-level `wrote` array. The uncommitted listing derives from this.
- `not-applicable` migrations are present in the JSON (collapsed in the human
  render). Suppressing them would deny a script the full picture.

#### `validation` is not a health check

`validation` reports only what this run happened to confirm, and a run confirms a
config in exactly two places: after a migration applies (post-apply validation,
which reverts the write on failure), and on a directory where nothing was
applicable (a pre-flight probe that tells an already-broken config apart from a
current one). Root and tenants are probed alike. Nothing else is checked, so a
run that ended in failure, a manual instruction, or pending check-mode work
validated nothing and reports `null`:

| Outcome                                          | `verdict`                        | `validation` |
| ------------------------------------------------ | -------------------------------- | ------------ |
| Nothing applicable, config probed and valid      | `up-to-date`                     | `true`       |
| Nothing applicable, config probed and **broken** | `invalid`                        | `false`      |
| A migration applied and cleared validation       | `migrated`                       | `true`       |
| A migration errored, reverted, or declined       | `failed` / `reverted` / `manual` | `null`       |
| `--check` mode with work outstanding             | `pending`                        | `null`       |

The `invalid` row is the one worth scripting against: a config nobody can migrate
because it is already broken. It is distinct from `null`, which claims nothing at
all. Do not collapse them.

Even `true` is narrow. It means the config loaded and satisfied the schema at the
moment it was checked, not that the deployment is healthy. Run `phoebe doctor` for
that.

### Upgrading a workspace

The end-to-end ritual for advancing a workspace deployment to a new engine version:

Start from a clean workspace: stage or stash each child's pending work first, or
those children are passed over with verdict `skipped`.

```bash
# 1. Upgrade — one command, three steps
phoebe upgrade v0.4.0 --engine
#    materializes v0.4.0, runs *its* migrations across root and fleet, and moves
#    the pin only if the root migrated cleanly. The migration report prints inline:
#    it lists uncommitted paths Phoebe wrote. Root failure aborts the flip; child
#    failures are reported per child but never block it.
#    Once the pin moves, boot drains and relaunches onto it within one reconcile
#    interval (default 60s).

# 2. Review what Phoebe wrote in each child
git -C ./service-a diff -- phoebe.config.ts prompts/research-prompt.md
git -C ./service-b diff -- phoebe.config.ts

# 3. Commit per-repo
git -C ./service-a add -p && git -C ./service-a commit -m "chore: apply phoebe v0.4.0 migrations"
git -C ./service-b add -p && git -C ./service-b commit -m "chore: apply phoebe v0.4.0 migrations"

# 4. Confirm the deployment is healthy
phoebe doctor
```

Step 1 is one command because `upgrade` runs the migrations itself. There is no
separate `phoebe migrate` step in the normal ritual. Reach for `migrate` directly
in two cases: to migrate without moving the pin, and to re-run a child that came
back `skipped` or `failed` once you have fixed it. It is idempotent, so an extra run
costs nothing but a report.

The migration report prints an uncommitted-paths listing with the exact `git diff`
command for each directory. Follow that listing rather than guessing which files
changed. For a child that was `skipped` (dirty tree), stash or commit its pending
work and re-run `phoebe migrate` for that child.

### One-time: chown the volumes when moving to the unprivileged image

**This applies once, to deployments that ran an image built before the container
ran as a non-root user.** Skip it for a fresh install.

Docker seeds a named volume's ownership from the image **only when it creates
that volume**. Volumes your old root container already created keep their
`root:root` ownership through any number of rebuilds, so the new unprivileged
container starts and then fails on the first write, a `git clone` or lock
acquisition dying with `EACCES`, not an obvious permissions message at startup.

Fix it in place, without losing the clone, watermarks, or logs (from the
deployment root, where `phoebe.config.ts` lives):

```bash
phoebe stop
docker compose -f container/compose.yml --env-file .env run --rm --user root \
  --entrypoint chown phoebe -R phoebe:phoebe /data
phoebe start
```

`--entrypoint chown` is needed because the image's `ENTRYPOINT` is `phoebe boot`;
everything after the service name is the argument list. To confirm it took:

```bash
docker compose -f container/compose.yml --env-file .env run --rm --entrypoint stat phoebe -c '%U' /data/repos
# phoebe
```

Deleting the volumes (`down -v`) also works and is simpler, at the cost of
re-cloning the repo and losing the watermarks that stop already-handled work
from being reconsidered.

### One-time: rebuild the image to harden the bootstrapper

**This applies once, to deployments that ran the consumer Dockerfile before
`chmod 0711 "$(command -v node)"` was added to the template.** Skip it for a
fresh install or any image already built with that line present.

The bootstrapper (`phoebe boot`) and every engine child run on the image's system
node. Before this change, those long-lived processes were ordinary dumpable execs
because a same-uid sibling could read their `/proc/<pid>/environ` to lift `GH_TOKEN`
or a provider key. A rebuild bakes the execute-only bit in:

```bash
phoebe start --build
```

No data is affected, and the volumes are untouched.

New engine defaults land automatically, because your `phoebe.config.ts` only
names fields you deliberately override, any field you left to the default picks
up the new default on upgrade. That is the point of the required-vs-optional
split in [`configuration.md`](configuration.md): a minimal config stays current.

Full mechanics, covering the reconcile loop, crash-loop thresholds, and what each
run verdict means, are in
[`architecture.md`](architecture.md#engine-updates-and-crash-loop-fallback).

## Scaffolded-file invariants

A few properties the templates rely on. Keep them intact when you customise:

- **The container marker.** Work-unit execution is refused unless
  `/.phoebe-container` exists (created by the image). Selection and `--dry-run`
  stay host-runnable; anything that mutates a clone or pushes runs only in the
  container.
- **`ENTRYPOINT` owns `phoebe boot`.** Compose's `command:` fully replaces
  `CMD` (it does not append to `ENTRYPOINT`), so the whole `phoebe boot`
  invocation lives in `ENTRYPOINT` and the compose files only ever contribute
  engine flags, which boot forwards to the engine (`--run-once`, `--dry-run`, or
  nothing for the persistent loop).
- **The config is type-only.** The scaffolded `phoebe.config.ts` is imported by
  `boot` from a container mount with no reachable `node_modules`, so every
  import in it must be `import type`, because a value import cannot resolve there.
- **Config + prompts are mounted read-only.** `compose.yml` mounts the whole
  deployment directory into `/etc/phoebe` read-only, so boot re-reads edits
  **without a rebuild**. Because it is a directory mount rather than a
  single-file one, a save-by-rename and a `git pull` are both picked up, with no
  `--force-recreate`.
- **The workload runs unprivileged.** The image creates a `phoebe` user
  (uid 10001) and ends with `USER phoebe`, so `boot`, the engine, the agent
  child, and your repo's install/check/test commands all run as it. Two things
  follow, and both bite quietly if you customise around them:
  - The four `/data` mount points are created **and chowned in the image**,
    before any volume exists. Docker seeds a fresh named volume from the image's
    contents at that path, ownership included. Add a fifth volume without
    adding its directory to that `mkdir`/`chown` and Docker will create the
    mount point as `root:root`, leaving it unwritable.
  - Anything the workload writes must be under `/data` or `$HOME`
    (`/home/phoebe`, set explicitly because the engine forwards `HOME` to the
    agent child). Bind-mounted files must be readable by _other_, because a git
    checkout's default `0644` is; a `0600` config is not.
- **The provider CLI is pinned, not piped.** The scaffold installs Cursor's
  agent from a pinned, `sha256`-verified tarball rather than the
  `curl https://cursor.com/install | bash` one-liner Cursor documents, and
  symlinks it to `/usr/local/bin/agent`, which is on `PATH` for every user, so it still
  resolves after the privilege drop.

  The trade-off, since this is your file to change: piping the vendor installer
  into a shell means two builds of the same Dockerfile can produce different
  images, and neither records which agent version it got. Pinning costs you a
  version that goes stale until you bump it deliberately. Cursor publishes no
  checksums and no `latest` indirection, so the digests in the Dockerfile are
  **ours**, recorded from the artifact its installer fetched, and pin the
  build rather than attesting anything about the vendor. To bump: run the vendor
  installer once, read the version out of the download URL it prints, and
  `sha256sum` the `linux/x64` and `linux/arm64` tarballs. If you switch to Claude
  Code or Codex (the commented lines), both are npm packages, so pin with
  `@version` there instead.

- **`.gitignore` edits are additive.** `init` only appends; it never rewrites
  your existing ignore rules.

## Upgrading a pre-multi-tenant deployment (volume clean break)

Multi-tenant Phoebe changed the on-disk layout: state now nests per repo under
two named volumes (`phoebe-data` → `/data/repos/<owner>/<repo>/{repo,worktrees,state}`,
`phoebe-engine` → `/data/engine`) instead of the old four (`phoebe-repo`,
`phoebe-worktrees`, `phoebe-state`, `phoebe-engine`). There is **no volume
migration**. It is a clean break. Migrations rewrite tracked files in your
repos; they never touch `/data`, named volumes, or git history.

1. `phoebe init` a fresh deployment (or pull the new `container/` templates) so
   `compose.yml` declares the two volumes and mounts the deployment dir at
   `/etc/phoebe`. Your `phoebe.config.ts` is unchanged (a `paths` field, if you
   ever set one, is gone, because paths are now derived from `repoSlug`).
2. `phoebe stop`.
3. `phoebe start`. The new volumes start **empty**; the engine re-clones
   its target lazily on the first work unit (a fresh clone, not a migration of
   the old volume). Nothing is copied across.
4. **Rollback** is `git revert` of the compose commit: the old differently-named
   volumes were never touched and persist until you `docker volume prune` them,
   so reverting brings the previous deployment straight back.

Going from **one repo to many** means moving to a workspace root: add a
`workspace` block to the root config, place each repo's checkout under it, and
run `phoebe init --tenant <dir>` per child. The running bootstrapper picks each up
on the next poll (see [`workspace.md`](workspace.md),
[`configuration.md`](configuration.md), and [`operating.md`](operating.md)). Read [`trust.md`](trust.md) first, because co-locating
repos in one container means co-locating them in **one trust domain**.

## One-time: mask the deployment env-file inside the container

**This applies to any deployment whose `container/compose.yml` does not already
include the `/dev/null:/etc/phoebe/.env:ro` bind mount.** Fresh installs from
`phoebe init` include it automatically. Skip this step if it is already present.

The deployment env-file (`.env` at the root, next to `phoebe.config.ts`) is
mounted read-only inside the container via the `..:/etc/phoebe:ro` deployment
mount. Because all tenant engine children run as the same uid (10001), any child
can read `/etc/phoebe/.env` off disk and recover the deployment `GH_TOKEN`,
defeating the env allowlist in the bootstrapper. The fix is one additional mount
that shadows the file with `/dev/null` inside the container; Compose still reads
the real file as its `--env-file` input before the container starts.

Add this entry to the `volumes:` list of the `phoebe` service in
`container/compose.yml`, immediately after the `..:/etc/phoebe:ro` line:

```yaml
- /dev/null:/etc/phoebe/.env:ro
```

Then restart the container so the new mount takes effect:

```bash
phoebe stop
phoebe start
```

No volume data is affected. To confirm the mask is active:

```bash
docker compose -f container/compose.yml --env-file .env run --rm --entrypoint cat phoebe /etc/phoebe/.env
# should produce no output (empty file)
```

## First install

For the full install runbook, covering prerequisites, secrets, the first
one-shot, and starting persistent mode, see [`ai-install.md`](ai-install.md). It runs
top to bottom.
