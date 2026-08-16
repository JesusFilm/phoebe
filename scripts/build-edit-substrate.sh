#!/usr/bin/env bash
# Regenerates src/migrations/vendor/babel-parser.mjs from @babel/parser@8.0.4.
#
# Runs in a temporary npm project so the main package.json and pnpm-lock.yaml
# are not touched. Pinning both package versions and esbuild guarantees
# byte-identical output across machines and CI runs.
#
# Usage: bash scripts/build-edit-substrate.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/src/migrations/vendor"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$TMP_DIR"
npm init -y >/dev/null 2>&1

# Pin both versions — the committed bundle was produced with these exact versions.
npm install --no-audit --no-fund \
  "@babel/parser@8.0.4" \
  "esbuild@0.28.2" \
  2>/dev/null

# Minimal entry: export only what migrations consume.
cat > entry.mjs << 'EOF'
export { parse } from "@babel/parser";
EOF

# Bundle + minify. --bundle resolves and inlines the three transitive packages
# (@babel/types, @babel/helper-string-parser, @babel/helper-validator-identifier).
# --legal-comments=none strips the few embedded license fragments esbuild would
# otherwise emit; the MIT notice is carried in vendor/LICENSE instead.
node_modules/.bin/esbuild entry.mjs \
  --bundle \
  --format=esm \
  --platform=node \
  --target=node24 \
  --minify \
  --legal-comments=none \
  --outfile="$TMP_DIR/bundle.mjs"

# Prepend the required MIT attribution header.
mkdir -p "$VENDOR_DIR"
{
  echo "// @babel/parser@8.0.4 — vendored ESM bundle (MIT)"
  echo "// Includes: @babel/types@8.0.4, @babel/helper-string-parser@8.0.0,"
  echo "//           @babel/helper-validator-identifier@8.0.4"
  echo "// DO NOT EDIT — regenerate with: bash scripts/build-edit-substrate.sh"
  echo "// See src/migrations/vendor/LICENSE for the full MIT license text."
  cat "$TMP_DIR/bundle.mjs"
} > "$VENDOR_DIR/babel-parser.mjs"

# Copy the MIT license text of every bundled package (required by the MIT license).
# Write to a temp file first so a partial read never leaves a truncated LICENSE.
LICENSE_TMP="$TMP_DIR/LICENSE"
: > "$LICENSE_TMP"
for pkg in @babel/parser @babel/types @babel/helper-string-parser @babel/helper-validator-identifier; do
  {
    echo "===== $pkg ====="
    cat "node_modules/$pkg/LICENSE"
    echo
  } >> "$LICENSE_TMP"
done
mv "$LICENSE_TMP" "$VENDOR_DIR/LICENSE"

echo "Built $VENDOR_DIR/babel-parser.mjs ($(wc -c < "$VENDOR_DIR/babel-parser.mjs") bytes)"
