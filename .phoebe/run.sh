#!/usr/bin/env bash
# Dogfood runner — invoked via `vp run phoebe` (the package.json `phoebe`
# script). Builds the runtime image and runs Phoebe against JesusFilm/phoebe
# with `phoebe boot` as the container's main process.
#
# There is nothing to pack or publish first: both the bootstrapper and the
# engine are read from this working tree, mounted read-only at
# /opt/phoebe-engine (container/compose.yml). Edit `src/` or `bootstrap/` and
# the next launch runs it. The image only needs rebuilding when its toolchain
# does, and Docker's cache makes the no-op case cheap.
#
# With no args it runs the FULL engine — the persistent poll loop that works
# unit after unit across every work kind (may open many PRs). Ctrl-C to stop,
# which drains: the current work unit finishes, no new one starts, exit 0.
# Pass engine flags to scope a single invocation instead:
#   vp run phoebe                          # full persistent loop (foreground)
#   vp run phoebe --run-once               # work exactly one unit, then exit
#   vp run phoebe --dry-run --run-once     # selection preview, nothing executes
#
# Requires .phoebe/.env (GH_TOKEN + the provider key). Docker must be running.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "${here}/.env" ]; then
  echo "[phoebe] Missing ${here}/.env — copy .env.example to .env and fill in GH_TOKEN + the provider key." >&2
  exit 1
fi

cd "${here}/container"
docker compose --env-file ../.env build
exec docker compose --env-file ../.env run --rm phoebe "$@"
