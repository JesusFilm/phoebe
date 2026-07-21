# Phoebe runtime image — scaffolded by `phoebe init`.
#
# Consumer-owned: commit this file, tweak it as you need. Phoebe treats the
# resulting image as both orchestrator and execution environment. The engine
# itself is installed from npm (`phoebe-agent`) — the source is not vendored.
#
# What ships in this image:
#   * Node.js (LTS) + git + GitHub CLI (`gh`) — the runtime the engine drives.
#   * A globally installed `phoebe-agent` pinned by the compose file.
#   * A `supervisor.sh` that keeps the engine restarted and self-updating.
#
# What lives on named volumes (see compose.yml):
#   * /data/repo       — Phoebe's private clone of the target repo.
#   * /data/worktrees  — Per-work-unit git worktrees.
#   * /data/state      — Lock, watermarks, logs.

FROM node:22-bookworm-slim

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

# Enable corepack so `pnpm` (pinned via package.json `packageManager`) is on
# PATH for the engine's installCommand and the agent's check/test gates. The
# target repo is a pnpm + vite-plus toolchain, not npm.
RUN corepack enable

# Install the Cursor agent CLI. The shipped template installs NO provider CLI,
# so the engine's `spawn("agent", …)` dies with ENOENT — another gap this
# dogfood surfaced. Cursor's installer symlinks its executable as `agent` (the
# exact name the engine spawns) into ~/.local/bin; put that on PATH so both the
# engine and the locked-down agent child (which inherits PATH) can find it.
RUN curl -fsSL https://cursor.com/install | bash
ENV PATH="/root/.local/bin:${PATH}"

# DOGFOOD DEVIATION FROM THE SHIPPED TEMPLATE:
# The scaffold installs `phoebe-agent@${PHOEBE_VERSION}` from npm, but npm only
# publishes the 0.0.0 stub today — that would dogfood old/empty code, not this
# working tree. Instead we install a tarball built from the local source by
# `.phoebe/build-engine.sh` (run it before `docker compose build`). Swap back to
# the npm line once a real `phoebe-agent` version is published.
#   ARG PHOEBE_VERSION=latest
#   RUN npm install -g phoebe-agent@${PHOEBE_VERSION}
ARG PHOEBE_VERSION=dogfood
COPY phoebe-agent.tgz /tmp/phoebe-agent.tgz
RUN npm install -g /tmp/phoebe-agent.tgz && rm /tmp/phoebe-agent.tgz

# Consumer install command, kept as an ARG so it lands in the image metadata
# and can be inspected with `docker image inspect`. The engine re-runs the
# command inside each worktree; this is just documentation for operators.
ARG PHOEBE_INSTALL_COMMAND="pnpm install --frozen-lockfile"
LABEL phoebe.install-command="${PHOEBE_INSTALL_COMMAND}"

# Execution-gate marker: the engine refuses to mutate a clone / launch an agent
# / push unless `/.phoebe-container` exists (src/execution-gate.ts). The shipped
# template Dockerfile omits this — a bug that makes the stock container refuse
# every non-dry-run unit. Create it here so the dogfood can actually work units.
RUN touch /.phoebe-container

COPY supervisor.sh /usr/local/bin/phoebe-supervisor
RUN chmod +x /usr/local/bin/phoebe-supervisor

# Compose's `command:` fully replaces `CMD` (it does not append to
# `ENTRYPOINT`), so the supervisor path must live in `ENTRYPOINT` — otherwise
# compose.yml's `command: ["--run-once"]` (or the daemon overlay's `command: []`)
# strips the supervisor away and tini exits with no child to exec. Keeping
# `CMD []` here means the compose files only ever contribute engine flags.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/phoebe-supervisor"]
CMD []
