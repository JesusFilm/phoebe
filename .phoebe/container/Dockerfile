# Dogfood runtime image — Phoebe working its own repo.
#
# Adapted from the `phoebe init` scaffold (templates/container/Dockerfile).
# The deviations from the shipped template are marked below; everything else
# is the same image the scaffold produces.

FROM node:24-bookworm-slim

# gh CLI + git + tini for signal handling; keep the layer small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg tini \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# DOGFOOD DEVIATION: enable corepack so `pnpm` (pinned via package.json's
# `packageManager`) is on PATH for the engine's installCommand and the agent's
# check/test gates. This repo is a pnpm + vite-plus toolchain, not npm.
RUN corepack enable

# Install the Cursor agent CLI. Its installer symlinks the executable as
# `agent` — the exact name the engine spawns — into ~/.local/bin, so put that on
# PATH for both the engine and the locked-down agent child (which inherits it).
RUN curl -fsSL https://cursor.com/install | bash
ENV PATH="/root/.local/bin:${PATH}"

# DOGFOOD DEVIATION: no `npm install -g phoebe-agent`.
#
# The scaffold installs the bootstrapper from npm and lets it check the engine
# out from GitHub. Here BOTH come from the host working tree mounted at
# /opt/phoebe-engine (container/compose.yml), which is the entire point of the
# dogfood: run exactly what is checked out. That also sidesteps npm still only
# publishing the `phoebe-agent@0.0.0` stub, which has no `boot` at all.
#
# So the image carries no Phoebe code, and nothing here needs rebuilding when
# `src/` or `bootstrap/` changes. Compose overrides the entrypoint to run the
# mounted bootstrapper: `node /opt/phoebe-engine/bootstrap/cli.ts boot`.

# Consumer install command, kept as an ARG so it lands in the image metadata
# and can be inspected with `docker image inspect`. The engine re-runs the
# command inside each worktree; this is just documentation for operators.
ARG PHOEBE_INSTALL_COMMAND="pnpm install --frozen-lockfile"
LABEL phoebe.install-command="${PHOEBE_INSTALL_COMMAND}"

# Execution-gate marker: the engine refuses to mutate a clone, launch an agent,
# or push unless `/.phoebe-container` exists (src/execution-gate.ts). Without it
# the container refuses every non-dry-run unit.
RUN touch /.phoebe-container

# No ENTRYPOINT here: compose supplies it, because the bootstrapper this image
# runs lives on the mount rather than in the image (see the deviation above).
