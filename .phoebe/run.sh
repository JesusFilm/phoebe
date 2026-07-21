#!/usr/bin/env bash
# Base dogfood runner — invoked via `vp run phoebe` (the package.json `phoebe`
# script). Builds the engine from the current working tree, builds the runtime
# image, and runs it against JesusFilm/phoebe.
#
# Any args are forwarded to the engine; with none it works a single unit:
#   vp run phoebe                # one real unit (--run-once): may open a PR
#   vp run phoebe --dry-run      # selection preview only, nothing executes
#   vp run phoebe --dry-run --run-once
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

# Default to a single one-shot unit; forward explicit flags otherwise.
if [ "$#" -eq 0 ]; then
  set -- --run-once
fi
exec docker compose --env-file ../.env run --rm phoebe "$@"
