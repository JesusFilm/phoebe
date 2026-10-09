# Phoebe relay image — scaffolded by `phoebe relay init`.
#
# Consumer-owned: commit this file, tweak it as you need. It is the deployment
# image (container/Dockerfile) minus everything the agent needs — no git, no
# `gh`, no provider CLI, no engine checkout. The relay never clones a repo and
# never runs an agent; it serves the console and, later, the socket deployments
# dial. Keeping those tools out keeps this image small and its blast radius
# small with it.
#
# The relay's version is the bootstrapper's version (#506 §1): the process is
# `phoebe relay serve` from the `{{CLI_BIN}}` package pinned below, and one
# changelog covers both. Upgrading the relay is an edit to that ARG plus a
# rebuild — there is no engine indirection here, because the relay has no
# engine.
#
# What lives on the named volume (see compose.yml):
#   * /data/relay — allowlist.json, and later the deployment links and reports.
#   * /data/caddy — the TLS sidecar's certificates and ACME account, written by
#                   the sidecar sharing this same volume.
#
# The workload runs as the unprivileged `phoebe` user, not root.

FROM node:24-bookworm-slim

# tini for signal handling, ca-certificates for the TLS the relay makes *out*
# to Google's token endpoint. Nothing else: no git, no gh, no build toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# The unprivileged user and the volume mount point, created *now* while we are
# still root.
#
# The ordering matters and is not cosmetic: Docker seeds a fresh named volume
# from the image's contents at that path, ownership included. The relay and the
# Caddy sidecar share one volume mounted at /data, and whichever container
# starts first is the one that seeds it — which is why compose.yml has Caddy
# depend on the relay. The relay seeds /data phoebe-owned, and Caddy (root) then
# writes its own /data/caddy inside it. The other order would leave /data
# root:root and the relay unable to create its data directory at all.
#
# (`node:24` already ships a uid-1000 `node` user. We add our own so the name in
# `ps`, in log output, and on the volume says what it is, and so the uid is
# stable if the base image ever renumbers `node`. It is the same uid the
# deployment image uses; nothing requires that, but a fleet with one uid is
# easier to reason about on a host.)
RUN useradd --create-home --shell /bin/bash --uid 10001 --user-group phoebe \
 && mkdir -p /data/relay \
 && chown -R phoebe:phoebe /data

# The relay. Pinned to a named ARG so it is machine-editable: a plain `ARG` line
# is trivially and safely rewritable, overridable at build time with
# `--build-arg PHOEBE_AGENT_VERSION=x.y.z`, and visible in image metadata via
# `docker image inspect` — which answers "which relay is in this image?" with no
# need to run the container.
#
# `phoebe relay init` wrote the version of the CLI that scaffolded this file.
# To upgrade: bump it, then `docker compose up -d --build`. Check the changelog
# first — the relay speaks every protocol version up to its own, so the rule is
# upgrade the relay before the deployments that dial it.
ARG PHOEBE_AGENT_VERSION={{CLI_VERSION}}
RUN npm install -g {{CLI_BIN}}@${PHOEBE_AGENT_VERSION}

# The system node is made execute-only, as in the deployment image. This
# process holds GOOGLE_CLIENT_SECRET in its environment for its whole life.
# Root-owned 0711 (executable, not readable by others) makes every exec of this
# binary non-dumpable — the kernel's unreadable-binary path in fs/exec.c, not
# AT_SECURE — so nothing else running as this uid can read /proc/<pid>/environ
# and lift the secret. Execute-only ELFs load fine; the shebang shims (`npm`)
# are read by the *kernel*, not by node.
RUN chmod 0711 "$(command -v node)"

# The privilege drop. Everything past this line runs unprivileged, and
# everything it writes lives under /data (the volume above) or $HOME. HOME is
# set explicitly rather than left to the runtime, because a process whose home
# does not exist fails in ways that name anything but the home directory.
ENV HOME=/home/phoebe
USER phoebe

# No EXPOSE and no published port: the relay listens on plain HTTP on 8787 and
# only the Caddy sidecar on the compose network reaches it. TLS is Caddy's job
# (#506 §2) — the relay never terminates it.
#
# The whole invocation lives in ENTRYPOINT so a compose `command:` (which
# replaces CMD rather than appending to ENTRYPOINT) can only ever contribute
# flags — `--port` and `--data-dir` are the two that exist, and the relay's
# defaults (8787, /data/relay) are already what this compose file wants.
ENTRYPOINT ["/usr/bin/tini", "--", "phoebe", "relay", "serve"]
CMD []
