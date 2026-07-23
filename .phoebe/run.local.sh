#!/usr/bin/env bash
# Dogfood the `phoebe boot` → local-engine-mount path (issue #40).
#
# Unlike run.sh (supervisor runs the baked engine tarball), this makes
# `phoebe boot` the container's main process: it reads the mounted config, sees
# `engine: { source: "local" }`, and execs the engine straight from this working
# tree mounted at /opt/phoebe-engine (container/compose.local.yml). The engine
# runs its FULL persistent poll loop; stop it with Ctrl-C or `docker stop` —
# SIGTERM drains (finish the current unit, start none, exit 0).
#
# The tarball still supplies the bootstrapper (`phoebe` = bin.mjs), so we build
# it and the image; the ENGINE that runs comes from the mount, so src/ edits
# take effect on the next launch without rebuilding.
#
# Requires .phoebe/.env (GH_TOKEN + the provider key). Docker must be running.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "${here}/.env" ]; then
  echo "[phoebe] Missing ${here}/.env — copy .env.example to .env and fill in GH_TOKEN + the provider key." >&2
  exit 1
fi

# The image only needs to carry the bootstrapper (`phoebe`), so build it once;
# the engine is the live mount, not the tarball.
"${here}/build-engine.sh"
cd "${here}/container"
docker compose --env-file ../.env build

exec docker compose --env-file ../.env -f compose.yml -f compose.local.yml run --rm phoebe "$@"
