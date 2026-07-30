#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

docker run --rm \
  --network none \
  --user 0:0 \
  --mount "type=bind,src=$repo_root,dst=/work,readonly" \
  --workdir /work \
  node:24-bookworm \
  sh -lc 'touch /.phoebe-container && node scripts/status-contract-container.mjs'
