# phoebe-agent

## 0.5.2

### Patch Changes

- 21f7cf7: Two CLI guards against misleading errors: an unknown bare subcommand is now rejected with the installed version and the `pnpm dlx phoebe-agent@latest upgrade` hint (instead of falling through to the engine-run path and dying in config validation), and the engine-run path refuses a workspace-root config with "run from a tenant directory, or `phoebe boot`" (instead of the five-required-fields error about tenant fields a root never carries).

## 0.5.1

### Patch Changes

- 204aa3e: Quarantine now has two working exits. The auto-un-stick sweep is wired into the
  poll cycle: each cycle Phoebe checks every unit still labelled
  `phoebe:quarantined` and removes the label when the unit's content has advanced
  past the baseline its escalation comment recorded — a PR's head SHA, or a
  fingerprint of the issue body. Issue baselines are that fingerprint rather than
  `updatedAt`, which GitHub bumps on any comment, label, or reaction (including
  Phoebe's own quarantine writes) and which would therefore have cleared every
  quarantine on the first sweep. Both exits — the sweep and a hand-removed label —
  now reset the timeout counter, so a released unit gets a fresh
  `maxUnitTimeouts` allowance instead of re-quarantining on its next timeout. A
  `phoebe:quarantined` label applied by a human is never auto-removed: the sweep
  only acts on a quarantine of its own that is still in force, and ignores the
  baseline of one it has already lifted.

## 0.5.0

### Minor Changes

- 808b24f: New operator commands: `phoebe upgrade` advances the pinned engine ref (a
  strict-literal, in-place rewrite of `engine.ref` in the deployment-root
  `phoebe.config.ts` — refs validated before the pin moves, rollback command
  printed) and/or the npm CLI, with `--check [--json]` as a scriptable
  behind-detector; `phoebe doctor [--json]` reports deployment health (cli and
  engine versions, config, repo reachability, crash-loop quarantine state,
  supervisor liveness) and sweeps every tenant's token and repo reachability.

## 0.4.0

### Minor Changes

- c7a741a: Remove the nested (`repos/<owner>/<repo>/`) layout; **solo and workspace are the
  only supported layouts** (#169). Nested was never used in a real deployment, and
  workspace mode covers every fleet case it was meant to — and better, since
  children are self-configured repos rather than config dirs the operator
  hand-assembles.

  Breaking, with no deprecation window:

  - The surviving single-repo layout is renamed **`flat` → `solo`** everywhere —
    `InitProfile`, the discovery `mode` discriminant, help text, log lines, and
    docs — so code, docs, and `examples/` share one vocabulary.
  - `phoebe init` gains an explicit `--solo` flag alongside `--workspace` /
    `--tenant`. Default behaviour is unchanged: no flag ⇒ solo.
  - `phoebe add-repo` and `phoebe remove-repo` are **deleted** — both were
    nested-only. Workspace children are scaffolded by `phoebe init --tenant`, and
    registering or unregistering one is an edit to the deployment-root config the
    operator owns.
  - `--repo <owner/repo>` is **deleted**, along with the config-selection ladder it
    drove. It existed only to pick a nested tenant's config. So that it fails loudly
    rather than surviving as a no-op alias, engine mode now **rejects any
    unrecognised flag** instead of forwarding it — the engine reads its flags with
    `argv.includes(...)`, so a forwarded unknown flag was silently dropped and a
    typo like `--dry-runn` would run the opposite of what was asked. `--run-once`,
    `--dry-run`, `--config`/`-c`, and `--help`/`-h` are unchanged.
  - `phoebe list` and `phoebe purge` survive minus their nested arms. `list`
    enumerates workspace children and reports no tenants in solo; `purge` now
    refuses whenever a live config still claims the slug — including a _held_
    child, whose engine may still be running — and its advice names no removed
    verb.
  - A deployment root that still carries a `repos/` directory **fails boot** with
    `nested \`repos/\` layout was removed in 0.4.0; use workspace mode`. That guard
    is an error message, not a mode: without it such a tree would fall through to
    solo and die on a misleading "missing required field".
  - `examples/nested/` is retired; `examples/` ships solo and workspace.

  `/data/repos/<owner>/<repo>/` is untouched — that is the runtime data layout for
  every tenant, unrelated to the removed config-side `repos/`.

## 0.3.2

### Patch Changes

- c66e9f1: Validate `promptFiles` at engine startup (#164). Prompt loading was fail-at-use:
  a tenant whose runtime root was missing one prompt kind booted clean, polled
  happily, and only died when the first work unit of that kind was dispatched —
  which for a rare kind meant weeks later, one failed unit at a time. The engine
  now checks, before it starts, every entry the tenant's `workOrder` can actually
  dispatch, and refuses to run with a single error naming the tenant and every
  missing kind with its resolved path. A kind you dropped from `workOrder` needs no
  prompt file — it was never going to be loaded.

  Being a loadable file is the whole rule — a regular file, since a directory would
  pass an existence check and then throw `EISDIR` at dispatch — so a `promptFiles`
  key may point outside the runtime root. That is what a `configDir` tenant wants:
  `issue: "../prompts/issues-prompt.md"` reaches the prompts at the repo root
  instead of keeping a second copy under `<configDir>/prompts/` that silently
  misses every prompt improvement merged afterward.

## 0.3.1

### Patch Changes

- 2b2723e: Add `workspace: { tenants: [...] }` (#128) — the field shape, ordering, and
  validation for declaring a workspace fleet in the root config instead of walking
  the tree for it. A `workspace` block now declares exactly one of two discovery
  arms: `depth` (walk, unchanged and still the default) or `tenants` (an ordered
  list of directory paths). Declared order is authoritative, so it is spawn,
  `phoebe list`, and warn order rather than the walk's emergent slug sort.

  Entries are normalized (`"./widget/"` → `widget`); absolute and `..` paths are
  deliberately supported so a root may supervise repos outside the workspace
  checkout. Fatal at load: an entry that is or contains the workspace root, a
  duplicate after normalization, a tenant nested inside another tenant, a glob, or
  declaring both arms at once. An empty list is a valid zero-tenant fleet.

  One validator in `bootstrap/workspace-source.ts` backs both the bootstrapper and
  `resolveConfig`, so the two entry points cannot drift, and `WorkspaceField` is a
  union — declaring both arms fails to compile as well as to validate.

  Discovery for a declared fleet is not wired yet: a config using `tenants` is
  validated and then refused at boot rather than silently falling back to a walk.

## 0.3.0

### Minor Changes

- 0591258: Add a bootstrapper-only `configDir` field (#98) so a fleet tenant can point at a
  single asset directory instead of duplicating `.env`/`prompts/` at the repo
  root. `configDir: ".phoebe"` makes the supervisor read the tenant's `.env` from
  `<dir>/.phoebe/.env` and run its engine child with cwd `<dir>/.phoebe/` (so
  relative `promptFiles` resolve there), while `phoebe.config.ts` stays at the
  tenant root for discovery. Honored for workspace children and nested `repos/`
  tenants; malformed values are held like a bad `repoSlug`. Default `"."` keeps
  the co-located path byte-for-byte unchanged. Like `engine`/`workspace` it is
  validated then dropped by `resolveConfig` — the engine never reads it.

## 0.2.0

### Minor Changes

- 8bbfa25: Multi-tenant Phoebe: run one container that supervises many repos (map #57). A
  single deployment can now discover a fleet of tenants from
  `/etc/phoebe/repos/<owner>/<repo>/` — each with its own `phoebe.config.ts` and
  `.env` — and run one supervised engine child per tenant behind a global
  concurrency cap, per-tenant `[phoebe:<slug>]` log tagging, per-tenant
  `state/<slug>/status.json`, and `phoebe list`. Env-scrub isolation hands each
  child only its own secrets. The flat single-tenant layout still works
  unchanged; nested discovery is additive.
- 8bbfa25: Wire the poison-unit quarantine write path into the engine (#75/#80). A unit of
  work that repeatedly fails is now quarantined rather than retried indefinitely,
  keeping a poison ticket from stalling the fleet.
- 8bbfa25: Workspace discovery mode (map #81): run `phoebe` at the root of a workspace
  whose child repos are linked as submodules, each carrying its own in-tree
  Phoebe install (config + gitignored `.env`). Phoebe walks the tree, reads each
  child's config, and feeds the same tenant abstraction as multi-tenant mode —
  one supervised engine child per tenant, still cloning each repo privately (the
  local checkout is a discovery + config source only). A `workspace: { depth }`
  block in the root `phoebe.config.ts` selects the mode. Highlights:

  - Discover and supervise a fleet from the submodule tree, reconciling on every
    poll as children come and go.
  - Child `repoSlug` stays authoritative; the submodule `origin` is a best-effort
    cross-check, and duplicate slug/origin across the fleet is a fatal boot abort.
  - `phoebe list` and per-tenant status surface workspace tenants.
  - Two new scaffolder profiles: `phoebe init --workspace` (root) and
    `phoebe init --tenant` (child, prefilling `repoSlug`/`repoUrl` from the
    child's `origin`).
  - Topology docs and an operator runbook for the workspace layout.

### Patch Changes

- 8bbfa25: Bound `superviseFleet.drain` with a SIGKILL escalation (#79). Draining the fleet
  on shutdown no longer hangs indefinitely on a child that ignores SIGTERM — the
  supervisor escalates to SIGKILL after a bounded grace period.
- 8bbfa25: Let the conflict-resolution agent drop relocated or superseded hunks (#89)
  instead of forcing every hunk to apply, so a rebase whose changes have moved or
  already landed upstream resolves cleanly.
- 8bbfa25: Fix two container-boot blockers surfaced by dogfooding: the Corepack download
  prompt hanging boot, and the agent child's `0711` permissions preventing it from
  running.

## 0.1.1

### Patch Changes

- 9b8cb25: Authenticate git against private repos at boot. When `GH_TOKEN` is set,
  `phoebe boot` runs `gh auth setup-git --hostname github.com` once before
  supervising the engine, so `ensureClone`, engine fetch/push, and the agent
  child's own `git push`/`fetch` all authenticate via a live credential helper
  — no token is written to disk.
- bcbeefb: Stop two Phoebe instances on one host from sharing each other's clone. The
  scaffolded compose file lives in a directory named `container`, so Compose
  derived the same project name — and therefore the same "private" `/data/repo`,
  `/data/state`, … volumes — for every repo on the machine. `ensureClone` then
  adopted whatever clone was already there, so an instance could silently run its
  git work against the wrong repo while its `gh` calls used its own `repoSlug`.

  - The scaffold compose file now sets an explicit, overridable project name
    (`name: ${COMPOSE_PROJECT_NAME:-phoebe}`); `.env.example` documents setting
    `COMPOSE_PROJECT_NAME` uniquely per repo when sharing a host.
  - `ensureClone` now verifies an existing clone's `origin` matches the configured
    `repoUrl` and fails loudly on a mismatch instead of adopting a foreign clone.

## 0.1.0

### Minor Changes

- f185f7f: Run buildless on Node 24. The engine (`src/`) and the published bootstrapper now
  run from raw `.ts` via native type-stripping — no `dist/` build, no
  `tsconfig.build.json`; `tsc --noEmit` stays for typecheck only, and the package
  requires Node >= 24.

  Node 24 refuses to type-strip files under `node_modules`, so the two files Node
  resolves there — the `bin` and the `defineConfig` import entry — are a dumb JS
  launcher (`bootstrap/bin.mjs`) and a one-line runtime shim (`bootstrap/index.mjs`).
  The launcher copies the package out of `node_modules` (default under the OS temp
  dir, override with `PHOEBE_ENGINE_DIR`) and execs the real, still-TypeScript
  bootstrapper (`bootstrap/cli.ts`) from there. Consumer-facing behavior is
  unchanged — same `phoebe` / `phoebe-agent` commands, same `defineConfig` import —
  only the Node floor moved to 24.

- d76833c: `phoebe boot` now guards against a bad engine ref. Tracking a branch means
  eventually tracking it onto a commit that will not boot; after three consecutive
  fast crashes (a non-zero exit inside 60s) boot quarantines that commit and
  materializes the last engine SHA that ran healthily instead, keeping the
  container serving until the tracked ref moves past the bad commit — at which
  point the quarantine lapses and reconcile resumes normally.

  A run is judged three ways — healthy, crash, or inconclusive — so that a run boot
  itself ended (a reconcile drain, a container stop) moves nothing, and a commit
  that outlives the healthy window is banked as last-good while it is still
  running. The record (last-good SHA, quarantined SHA, crash count) is JSON in
  `paths.stateDir`, so a quarantine survives the container restart a crash-looping
  engine causes; an unwritable state dir is a warning, not a failure. The guard is
  inert unless the engine ref is a moving branch — a `local` mount has no commit to
  pin, and a pinned SHA or tag means the operator chose that exact commit — and
  inert until some commit has proven itself, so a first boot onto a broken ref
  still fails loudly.

- 2db8640: The engine's self-update machinery is gone, and `phoebe init` scaffolds the
  bootstrapper model. With `phoebe boot` owning engine updates, the engine no
  longer diffs its own code on every cycle and exits for a supervisor re-exec:
  `selfUpdatePaths` is removed from the config, and the shell `supervisor.sh` the
  scaffold used to write is removed with it.

  **The engine version moved out of the image and into the config.** It is now
  `engine: { source: "github", ref }` in `phoebe.config.ts`, and `PHOEBE_VERSION`
  is gone from the scaffolded compose and `.env`. Editing `ref` upgrades a running
  deployment: within one reconcile interval boot drains the engine at a work-unit
  boundary and relaunches it on the new commit — no image rebuild, no container
  restart. A tag or SHA pins exactly; a branch follows its tip, guarded by the
  crash-loop fallback.

  **If you already scaffolded a runtime** (nothing is published yet, so this
  breaks no released version), migrate it:

  - `selfUpdatePaths` is no longer a config field. Remove it — an unknown field is
    a type error.
  - Your `phoebe.config.ts` must import **nothing at runtime**. Replace
    `import { defineConfig } from "phoebe-agent"` with
    `import type { PhoebeUserConfig } from "phoebe-agent"` and a plain default
    export. Boot loads the config from the container mount, where no
    `node_modules` is reachable, so a value import fails to resolve.
  - Add an `engine` field (it defaults to `{ source: "github", ref: "main" }` —
    pin it) and set `PHOEBE_ENGINE_DIR` at a persistent volume so engine checkouts
    survive a restart.
  - Re-scaffold `container/`: the Dockerfile's `ENTRYPOINT` is now
    `["/usr/bin/tini", "--", "phoebe", "boot"]`, `compose.yml` describes the
    long-lived container directly, and `compose.daemon.yml` is replaced by a
    dev-only `compose.local.yml` for running an engine checkout from your host.

- c303d65: First public release of the `phoebe-agent` CLI: the configurable AFK coding-agent
  engine, distributed as a pinned CLI with `phoebe init` scaffolding and container
  templates. Installable via `npx phoebe-agent`.

### Patch Changes

- 8327a35: Introduce nominal (branded) types for git SHAs, branch refs, and PR numbers
  (`Sha`, `BranchRef`, `PrNumber`) with `asSha` / `asBranchRef` / `asPrNumber`
  constructors applied at the `gh`/config trust boundary. These were previously
  bare `string` / `number` that could pass each other's parameter slot silently.
  Internal-only hardening — no consumer-facing API or runtime behaviour change.
