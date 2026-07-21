#!/usr/bin/env bash
# Phoebe supervisor — scaffolded by `phoebe init`, consumer-owned.
#
# Keeps the engine (`phoebe-agent`) restarted when it exits deliberately for a
# self-update, and re-runs the consumer's install command (`npm ci`)
# after every self-update so the private clone stays warm. Exits 0 only when
# the engine returns 0 in one-shot mode.

set -euo pipefail

: "${PHOEBE_REPO_DIR:=/data/repo}"
: "${PHOEBE_STATE_DIR:=/data/state}"

# Exit code the engine uses to request a supervisor re-exec after a self-update
# (kept in sync with SELF_UPDATE_EXIT_CODE in src/supervisor-decision.ts).
SELF_UPDATE_EXIT_CODE=75

mkdir -p "${PHOEBE_REPO_DIR}" "${PHOEBE_STATE_DIR}"

warm_install() {
  # Best-effort: on first boot the clone doesn't exist yet, and the engine will
  # populate it on its first tick. Skip silently when there's nothing to install.
  if [ -f "${PHOEBE_REPO_DIR}/package.json" ]; then
    ( cd "${PHOEBE_REPO_DIR}" && pnpm install --frozen-lockfile ) || true
  fi
}

while true; do
  warm_install
  set +e
  phoebe-agent "$@"
  status=$?
  set -e

  if [ "${status}" -eq "${SELF_UPDATE_EXIT_CODE}" ]; then
    echo "[phoebe-supervisor] Engine exited ${SELF_UPDATE_EXIT_CODE} — reinstalling and re-execing."
    npm install -g "phoebe-agent@${PHOEBE_VERSION:-latest}" || true
    continue
  fi

  # Non-self-update exit — one-shot runs propagate the exit code, persistent
  # runs treat any exit as unexpected and get restarted after a short backoff.
  case " $* " in
    *" --run-once "*|*" --dry-run "*)
      exit "${status}"
      ;;
  esac
  echo "[phoebe-supervisor] Engine exited ${status} — restarting in 10s."
  sleep 10
done
