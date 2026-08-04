# phoebe-agent

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
