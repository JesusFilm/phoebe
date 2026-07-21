#!/usr/bin/env bash
# Base dogfood runner — invoked via `vp run phoebe` (the package.json `phoebe`
# script). Builds the engine from the current working tree, builds the runtime
# image, and runs it against JesusFilm/phoebe.
#
# With no args it runs the FULL engine — the persistent poll loop that works
# unit after unit across every work kind (may open many PRs). Ctrl-C to stop.
# Pass engine flags to scope a single invocation instead:
#   vp run phoebe                # full persistent loop (foreground)
#   vp run phoebe --run-once     # work exactly one unit, then exit
#   vp run phoebe --dry-run      # selection preview only, nothing executes
#
# Requires .phoebe/.env (GH_TOKEN + the provider key). Docker must be running.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "${here}/.env" ]; then
  echo "[phoebe] Missing ${here}/.env — copy .env.example to .env and fill in GH_TOKEN + the provider key." >&2
  exit 1
fi

# Rebuild the engine tarball from the working tree, then the image (both are
# Docker-cache/no-op cheap when nothing changed) so the run always exercises the
# code you have checked out.
"${here}/build-engine.sh"
cd "${here}/container"
docker compose --env-file ../.env build

# No args → full persistent loop. compose.yml pins `command: ["--run-once"]`, so
# the daemon overlay (which sets `command: []`) is what drops the engine into
# its poll loop; the in-container supervisor keeps it restarted. Explicit flags
# override the command for a scoped one-shot run against the base compose file.
if [ "$#" -eq 0 ]; then
  exec docker compose --env-file ../.env -f compose.yml -f compose.daemon.yml run --rm phoebe
fi
exec docker compose --env-file ../.env run --rm phoebe "$@"
