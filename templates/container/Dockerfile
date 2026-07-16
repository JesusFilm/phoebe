# Phoebe runtime image — scaffolded by `phoebe init`.
#
# Consumer-owned: commit this file, tweak it as you need. Phoebe treats the
# resulting image as both orchestrator and execution environment. The engine
# itself is installed from npm (`{{CLI_BIN}}`) — the source is not vendored.
#
# What ships in this image:
#   * Node.js (LTS) + git + GitHub CLI (`gh`) — the runtime the engine drives.
#   * A globally installed `{{CLI_BIN}}` pinned by the compose file.
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

# PHOEBE_VERSION is set by the compose file so consumers can pin the engine
# without editing the Dockerfile. `latest` is only a build-time default; the
# compose files should always pass an explicit version.
ARG PHOEBE_VERSION=latest
RUN npm install -g {{CLI_BIN}}@${PHOEBE_VERSION}

# Consumer install command, kept as an ARG so it lands in the image metadata
# and can be inspected with `docker image inspect`. The engine re-runs the
# command inside each worktree; this is just documentation for operators.
ARG PHOEBE_INSTALL_COMMAND="{{INSTALL_COMMAND}}"
LABEL phoebe.install-command="${PHOEBE_INSTALL_COMMAND}"

COPY supervisor.sh /usr/local/bin/phoebe-supervisor
RUN chmod +x /usr/local/bin/phoebe-supervisor

# Compose's `command:` fully replaces `CMD` (it does not append to
# `ENTRYPOINT`), so the supervisor path must live in `ENTRYPOINT` — otherwise
# compose.yml's `command: ["--run-once"]` (or the daemon overlay's `command: []`)
# strips the supervisor away and tini exits with no child to exec. Keeping
# `CMD []` here means the compose files only ever contribute engine flags.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/phoebe-supervisor"]
CMD []
