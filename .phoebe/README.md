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
- **Bootstrapper _and_ engine from the working tree.** The scaffold installs the
  bootstrapper from npm and lets `boot` check the engine out from GitHub. Here
  both are read from this repo mounted read-only at `/opt/phoebe-engine`:
  compose overrides the entrypoint to run the mounted `bootstrap/cli.ts`, and
  the config says `engine: { source: "local" }`. So the container runs exactly
  what is checked out — no publish, no push, no image rebuild in the loop. (It
  also sidesteps npm still only publishing the `phoebe-agent@0.0.0` stub, which
  has no `boot` at all.)
- **One compose file.** With the bootstrapper on the mount there is nothing for
  a local-engine overlay to switch on, so the scaffold's `compose.local.yml` is
  folded into the base file here.
- **Config mounted as a directory.** `working_dir` is `/opt/phoebe-engine/.phoebe`
  inside the working-tree mount, rather than the scaffold's single-file bind
  mount of `phoebe.config.ts`. A file bind mount pins the host _inode_, so an
  editor that saves by rename would be invisible to `boot`'s config watch.
- **Cursor provider.** `defaultProvider: "cursor"` + `CURSOR_API_KEY`.

**What that costs in coverage.** Because the image installs no `phoebe-agent`
and compose supplies the entrypoint, the dogfood does **not** exercise two things
the shipped scaffold depends on: `npm install -g phoebe-agent` landing a working
`phoebe` bin, and the `ENTRYPOINT ["/usr/bin/tini", "--", "phoebe", "boot"]` form.
Those are covered instead by the packed-artifact smoke in
`.github/workflows/ready.yml` and by `src/init.test.ts`. Nor does it exercise the
`github` engine source or the crash-loop fallback, which need a moving remote
ref; flip `engine` to `{ source: "github", ref }` to try that path by hand.

## Prerequisites

- Docker + Docker Compose, Node ≥ 24, pnpm (via corepack) on the host.
- A GitHub token with `repo` + `read:org` on `JesusFilm/phoebe`.
- A `CURSOR_API_KEY`.
- At least one issue on `JesusFilm/phoebe` labeled `ready-for-agent`.

## Run it

First set secrets: edit `.phoebe/.env` and fill in `GH_TOKEN` and
`CURSOR_API_KEY` (`.env` is gitignored — never commit it).

The quick path is `run.sh`, wired to `vp run phoebe`. It builds the image (a
Docker-cache no-op once warm) and starts the container:

```bash
vp run phoebe                        # FULL persistent loop — works unit after
                                     # unit across every work kind (may open
                                     # many PRs). Foreground; Ctrl-C to stop.
vp run phoebe --run-once             # work exactly one unit, then exit
vp run phoebe --dry-run --run-once   # selection preview, nothing executes
```

Flags are forwarded through `boot` to the engine. Or drive it by hand:

```bash
cd .phoebe/container
docker compose --env-file ../.env build
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once
docker compose --env-file ../.env up -d            # persistent, detached
docker compose --env-file ../.env logs -f
```

Editing `src/` or `bootstrap/` needs no rebuild — the next launch picks it up
from the mount.

## What `boot` does while it runs

`phoebe boot` is the container's long-lived main process, not a wrapper that
execs and forgets:

- **SIGTERM drains.** `docker stop` (or Ctrl-C — compose `run` forwards it)
  makes the engine finish the current work unit, start no new one, and exit 0.
  The signal is forwarded tini → `boot` → engine (#40).
- **Reconcile relaunches in place.** Edit `.phoebe/phoebe.config.ts` while it
  runs and `boot` drains the engine and relaunches it on the new config at the
  next work-unit boundary — same container, no interrupted unit (#42). Compose
  sets `PHOEBE_RECONCILE_INTERVAL_MS=10000` here so you see it within ten
  seconds instead of the default minute.
- **No crash-loop guard here.** `boot`'s fallback to a last-good engine commit
  (#43) only covers a moving github ref; a `local` mount has no commit to pin,
  so a crashing engine exits exactly as it would have anyway.

Missing the mount fails loudly: `boot` aborts with "no engine is mounted at
/opt/phoebe-engine" rather than silently falling back.

The other engine source is `{ source: "github", ref }` — `boot` clones the
engine repo (into `PHOEBE_ENGINE_DIR`, `GH_TOKEN`-authenticated) and checks out
the ref, which is what a real deployment runs. Flip the config field to try it;
the compose file already wires a `/data/engine` volume for the checkout. See
[`docs/configuration.md`](../docs/configuration.md#engine-source-engine).

## How far this has actually been run

Verified in a real container, with a deliberately invalid `GH_TOKEN`:
`docker compose build`, then `run --rm phoebe --dry-run --run-once` walked the
whole chain — tini → `bootstrap/cli.ts boot` → the mounted config loaded → the
`local` source resolved → `/opt/phoebe-engine/src/cli.ts` exec'd → the engine
parsed its flags and reached its first `gh` call, which failed on the bad
credentials exactly as it should.

So everything up to the GitHub boundary is proven. What still needs your
secrets, on a first real run, is the far side of it:

- `pnpm install --frozen-lockfile` succeeding inside the container's clone,
- the Cursor agent authenticating with `CURSOR_API_KEY`,
- a work unit going all the way to an opened PR.
