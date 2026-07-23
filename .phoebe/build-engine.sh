#!/usr/bin/env bash
# Pack the Phoebe engine from this working tree and stage it as the tarball the
# dogfood Dockerfile installs. Run this before `docker compose ... build`.
#
# Why: npm only publishes phoebe-agent@0.0.0 (a stub), so installing the engine
# from npm would dogfood empty/old code. This packs the local source instead,
# so the container runs exactly what's checked out here.
#
# There is no build step: the package ships raw `.ts` and runs under Node 24
# type-stripping, so `npm pack` bundles the source the container runs directly.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/container/phoebe-agent.tgz"

cd "${repo_root}"
echo "[build-engine] vp install in ${repo_root}"
vp install --frozen-lockfile

echo "[build-engine] npm pack"
tarball="$(npm pack --silent)"
mv "${repo_root}/${tarball}" "${dest}"
echo "[build-engine] staged ${dest}"
