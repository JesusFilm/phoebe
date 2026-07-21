#!/usr/bin/env bash
# Build the Phoebe engine from this working tree and stage it as the tarball the
# dogfood Dockerfile installs. Run this before `docker compose ... build`.
#
# Why: npm only publishes phoebe-agent@0.0.0 (a stub), so installing the engine
# from npm would dogfood empty/old code. This packs the local source instead,
# so the container runs exactly what's checked out here.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/container/phoebe-agent.tgz"

cd "${repo_root}"
echo "[build-engine] pnpm install + build in ${repo_root}"
pnpm install --frozen-lockfile
pnpm run build

echo "[build-engine] npm pack"
tarball="$(npm pack --silent)"
mv "${repo_root}/${tarball}" "${dest}"
echo "[build-engine] staged ${dest}"
