# Dogfood: Phoebe working its own repo

This directory runs Phoebe against **`JesusFilm/phoebe`** itself — the engine
polls this repo for `ready-for-agent` issues, works each on a branch in an
isolated worktree, runs the gates, and opens a PR. It's a `phoebe init` runtime
(config + prompts + container) adapted for this repo's toolchain and for
running the engine straight from the working tree.

It lives in `.phoebe/` (not the repo root) because the root `phoebe.config.ts`
is the test fixture, and `phoebe init` won't overwrite it.

## What's different from a stock `phoebe init`

- **pnpm, not npm.** This repo uses pnpm + `vite-plus` (`vp`). The config's
  install/check/test/ready commands are pnpm, and the Dockerfile runs
  `corepack enable` so `pnpm` (pinned by `package.json`'s `packageManager`) is
  on PATH.
- **Engine from local source, not npm.** npm only publishes `phoebe-agent@0.0.0`
  (a stub). `build-engine.sh` packs this working tree into
  `container/phoebe-agent.tgz` and the Dockerfile installs that, so the
  container dogfoods the code you have checked out. Switch back to the npm line
  in the Dockerfile once a real version is published.
- **Config has no `phoebe-agent` import.** The config is mounted into the
  container; a bare `import { defineConfig } from "phoebe-agent"` can't resolve
  from `/etc/phoebe` under ESM, so it's a plain object with a type-only import
  (erased at runtime) for editor safety.
- **Self-update disabled.** `selfUpdatePaths: []` — otherwise a self-update exit
  would make the supervisor reinstall the npm `0.0.0` stub over the local build.
- **Cursor provider.** `defaultProvider: "cursor"` + `PHOEBE_AGENT=cursor`.

## Prerequisites

- Docker + Docker Compose, Node ≥ 24, pnpm (via corepack) on the host.
- A GitHub token with `repo` + `read:org` on `JesusFilm/phoebe`.
- A `CURSOR_API_KEY`.
- At least one issue on `JesusFilm/phoebe` labeled `ready-for-agent`.

## Run it

First set secrets: edit `.phoebe/.env` and fill in `GH_TOKEN` and
`CURSOR_API_KEY` (`.env` is gitignored — never commit it).

The quick path is `run.sh`, wired to `vp run phoebe`. It repacks the engine
tarball from the working tree, rebuilds the image, then runs the engine — so
every invocation exercises the code you have checked out:

```bash
vp run phoebe                # FULL persistent loop — works unit after unit
                             # across every work kind (may open many PRs).
                             # Foreground; Ctrl-C to stop.
vp run phoebe --run-once     # work exactly one unit, then exit
vp run phoebe --dry-run      # selection preview only, nothing executes
```

Or drive the steps by hand:

```bash
# 1. Build the engine tarball from this working tree.
./.phoebe/build-engine.sh

# 2. Build the image and see what the engine WOULD pick (no changes made).
cd .phoebe/container
docker compose --env-file ../.env build
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once

# 3. Work a single unit for real (drop --dry-run).
docker compose --env-file ../.env run --rm phoebe --run-once

# 4. Run as a persistent daemon.
docker compose --env-file ../.env -f compose.yml -f compose.daemon.yml up -d
```

Re-run `./.phoebe/build-engine.sh` and `docker compose ... build` — or just
`vp run phoebe` — whenever you want the container to pick up local engine
changes.

## `phoebe boot` from a local engine mount

`run.sh` above installs the engine from the baked tarball and runs it under the
supervisor. `run.local.sh` exercises the new bootstrapper path instead
(issue #40): `phoebe boot` is the container's main process, reads the mounted
config, sees `engine: { source: "local" }`, and execs the engine straight from
this working tree mounted at `/opt/phoebe-engine`.

```bash
./.phoebe/run.local.sh              # FULL persistent loop via `phoebe boot`
./.phoebe/run.local.sh --dry-run    # forwarded to the engine: selection only
```

Three things it demonstrates over the supervisor path:

- **No engine rebuild for src/ edits.** The engine is the live mount, not the
  tarball — only the bootstrapper (`phoebe` = `bin.mjs`) comes from the image, so
  editing `src/` and relaunching is enough.
- **SIGTERM drains.** `docker stop` (or Ctrl-C → the compose `run` forwards
  SIGTERM) makes the engine finish the current work unit, start no new one, and
  exit 0 — the signal is forwarded tini → `phoebe boot` → engine.
- **Reconcile relaunches in place.** Edit `.phoebe/phoebe.config.ts` while it
  runs and `boot` drains the engine and relaunches it on the new config at the
  next work-unit boundary — same container, no interrupted unit (issue #42).
  `compose.local.yml` sets `PHOEBE_RECONCILE_INTERVAL_MS=10000` so you see it
  within ten seconds instead of the default minute.

Missing the mount fails loudly: `boot` aborts with "no engine is mounted at
/opt/phoebe-engine" rather than silently falling back.

The other engine source is `{ source: "github", ref }` — `boot` clones the
engine repo (into `PHOEBE_ENGINE_DIR`, `GH_TOKEN`-authenticated) and checks out
the ref, so you run a pinned/published engine instead of this working tree. The
dogfood uses `local` because the whole point here is to run the tree you have
checked out; see [`docs/configuration.md`](../docs/configuration.md#engine-source-engine)
for the github source.

## Not yet verified end-to-end

This scaffold is configured but has **not** been launched here (it needs your
secrets + Docker). When you first run the `--dry-run` above, sanity-check that:

- the engine loads `phoebe.config.ts` without a module-resolution error,
- `pnpm install --frozen-lockfile` succeeds inside the container's clone,
- the Cursor agent authenticates with `CURSOR_API_KEY`.
