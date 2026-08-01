#!/usr/bin/env bash
# Nested-dogfood boundary smoke (#77). Boots the two-tenant fleet with a
# deliberately invalid token and asserts the multi-tenant supervision chain walks
# end to end — with NO real secrets. This is the flat dogfood's "verified to the
# GitHub boundary" check, one tier up: two tenants on one shared engine, not one.
#
# What a passing run proves:
#   1. nested mode is detected — boot announces it is supervising 2 tenants;
#   2. each tenant gets its OWN engine child (own cwd + scrubbed env, #58/#61) that
#      reaches its first `gh` call and dies on the bad credentials, so the
#      supervisor reaps it per-tenant by dir — real per-tenant supervision (#60),
#      not one shared failure;
#   3. `phoebe list` enumerates both tenants from the mounted repos/ tree —
#      per-tenant state/health (#62/#63), and it needs no token at all.
#
# What it does NOT prove (deferred to a real run — see README "How far…"): the
# per-unit `[phoebe:<slug>]` event tag + status.json (#73) and the concurrency
# broker serializing real work (#59) only fire on the far side of the GitHub
# boundary, which needs your secrets and real ready-for-agent issues. Those are
# unit-tested (unit-event / slot-broker / supervise-fleet .test.ts); this smoke
# is about the live wiring in between.
#
# Usage: ./.phoebe-nested/smoke.sh    (requires Docker; no .env needed)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
reposdir="${here}/repos"
tenants=("JesusFilm/phoebe" "JesusFilm/youtube-studio")

# --- Dummy secrets, created only if absent and cleaned up on exit ------------
# The token is intentionally invalid: every tenant child should fail at its first
# gh call, which is exactly the boundary we are asserting reached.
DUMMY_TOKEN="phoebe-nested-smoke-invalid-token"
created=()
cleanup() {
  for f in "${created[@]:-}"; do [ -n "${f}" ] && rm -f "${f}"; done
}
trap cleanup EXIT

rootenv="$(mktemp)"
created+=("${rootenv}")
printf 'GH_TOKEN=%s\n' "${DUMMY_TOKEN}" > "${rootenv}"

for slug in "${tenants[@]}"; do
  envfile="${reposdir}/${slug}/.env"
  if [ ! -f "${envfile}" ]; then
    printf 'GH_TOKEN=%s\n' "${DUMMY_TOKEN}" > "${envfile}"
    created+=("${envfile}")
  else
    echo "[smoke] note: reusing your existing repos/${slug}/.env (its real token, not the dummy)." >&2
  fi
done

compose=(docker compose --env-file "${rootenv}")
cd "${here}/container"

echo "[smoke] Building the runtime image (Docker-cache no-op once warm)…"
"${compose[@]}" build >/dev/null

fail=0
assert_contains() { # <haystack-file> <needle> <label>
  if grep -qF -- "$2" "$1"; then
    echo "[smoke]   ✓ $3"
  else
    echo "[smoke]   ✗ $3 — expected to find: $2" >&2
    fail=1
  fi
}

# --- 1. phoebe list: enumerate both tenants (no token needed, #62/#63) -------
echo "[smoke] Step 1/2 — phoebe list enumerates both tenants…"
listout="$(mktemp)"; created+=("${listout}")
"${compose[@]}" run --rm --no-TTY --entrypoint node phoebe \
  /opt/phoebe-engine/src/cli.ts list >"${listout}" 2>&1 || true
assert_contains "${listout}" "JesusFilm/phoebe" "list reports the phoebe tenant"
assert_contains "${listout}" "JesusFilm/youtube-studio" "list reports the youtube-studio tenant"

# --- 2. Boot the fleet to the GitHub boundary (dummy token) ------------------
# No --run-once: the fleet loop respawns a dead child, so a fixed timeout gives
# each tenant time to boot, hit its gh call, and be reaped by dir at least once.
# --dry-run keeps it selection-only even if a token were valid.
echo "[smoke] Step 2/2 — booting the 2-tenant fleet to the GitHub boundary…"
bootout="$(mktemp)"; created+=("${bootout}")
timeout --signal=SIGTERM 75 "${compose[@]}" run --rm --no-TTY phoebe --dry-run \
  >"${bootout}" 2>&1 || true

assert_contains "${bootout}" "supervising 2 tenant(s)" "boot detects nested mode with 2 tenants"
assert_contains "${bootout}" "repos/JesusFilm/phoebe exited" \
  "phoebe tenant child ran and was reaped per-tenant at the boundary"
assert_contains "${bootout}" "repos/JesusFilm/youtube-studio exited" \
  "youtube-studio tenant child ran and was reaped per-tenant at the boundary"

echo
if [ "${fail}" -eq 0 ]; then
  echo "[smoke] PASS — the nested supervision chain walked end to end for both tenants."
else
  echo "[smoke] FAIL — see the ✗ lines above; full boot log:" >&2
  echo "-------------------------------------------------------------" >&2
  cat "${bootout}" >&2
  exit 1
fi
