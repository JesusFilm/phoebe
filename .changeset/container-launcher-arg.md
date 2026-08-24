---
"phoebe-agent": patch
---

Adds migration m003: lifts the bootstrapper version pin in `container/Dockerfile` from a hardcoded install line to a named `ARG PHOEBE_AGENT_VERSION`, making it overridable at build time with `--build-arg` and reachable by bump automation without a regex over prose.
