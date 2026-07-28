# Phoebe runtime image — scaffolded by `phoebe init`.
#
# Consumer-owned: commit this file, tweak it as you need. Phoebe treats the
# resulting image as both orchestrator and execution environment.
#
# The image carries the *bootstrapper* (`{{CLI_BIN}}` from npm), not the engine.
# `phoebe boot` is the container's long-lived main process: it reads the mounted
# `phoebe.config.ts`, materializes the engine from the source named there
# (`engine: { source: "github", ref }` by default), execs it, and keeps
# supervising it — relaunching on a config or ref change, falling back to the
# last engine commit that ran healthily if a new one will not boot, and draining
# it gracefully on `SIGTERM`. So changing engine version is a config edit, not
# an image rebuild; this image only changes when the toolchain around it does.
#
# What ships in this image:
#   * Node.js 24 + git + GitHub CLI (`gh`) — the runtime the engine drives.
#   * A globally installed `{{CLI_BIN}}` (the bootstrapper).
#   * Your agent provider's CLI.
#
# What lives on named volumes (see compose.yml):
#   * /data/repo       — Phoebe's private clone of the target repo.
#   * /data/worktrees  — Per-work-unit git worktrees.
#   * /data/state      — Lock, watermarks, logs, crash-loop record.
#   * /data/engine     — Engine checkouts, so a restart fetches instead of cloning.

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

# The bootstrapper. Unpinned on purpose: which *engine* you run is `engine.ref`
# in phoebe.config.ts, and this package is only the thin launcher around it.
# Pin it (`{{CLI_BIN}}@<version>`) if you want the launcher itself frozen too.
RUN npm install -g {{CLI_BIN}}

# Provider agent CLI. The engine spawns the selected provider's CLI as a child
# (`agent` for cursor, `claude`, or `codex`), so the one matching your
# `defaultProvider` / `PHOEBE_AGENT` must be on PATH — otherwise the run dies
# with `spawn <cli> ENOENT`. Default below installs Cursor: its executable is
# symlinked as `agent` into ~/.local/bin, which we add to PATH. Swap or add the
# commented lines for the provider you actually run.
RUN curl -fsSL https://cursor.com/install | bash
ENV PATH="/root/.local/bin:${PATH}"
# Claude Code:  RUN npm install -g @anthropic-ai/claude-code
# Codex:        RUN npm install -g @openai/codex

# Consumer install command, kept as an ARG so it lands in the image metadata
# and can be inspected with `docker image inspect`. The engine re-runs the
# command inside each worktree; this is just documentation for operators.
ARG PHOEBE_INSTALL_COMMAND="{{INSTALL_COMMAND}}"
LABEL phoebe.install-command="${PHOEBE_INSTALL_COMMAND}"

# Execution-gate marker: the engine refuses to mutate a clone, launch an agent,
# or push unless `/.phoebe-container` exists (src/execution-gate.ts). Without it
# the container refuses every non-dry-run unit.
RUN touch /.phoebe-container

# Compose's `command:` fully replaces `CMD` (it does not append to
# `ENTRYPOINT`), so the whole `phoebe boot` invocation must live in
# `ENTRYPOINT` — otherwise a compose `command: ["--run-once"]` would strip the
# bootstrapper away and tini would try to exec `--run-once` as a program.
# Keeping `CMD []` here means the compose files only ever contribute engine
# flags, which `boot` forwards to the engine it launches.
ENTRYPOINT ["/usr/bin/tini", "--", "phoebe", "boot"]
CMD []
