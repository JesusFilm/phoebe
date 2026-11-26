---
"phoebe-agent": patch
---

The container template `phoebe init` scaffolds now pins Renovate to `44.263.5`, up from `44.210.0`. An existing `container/Dockerfile` is left alone. To pick the new version up, change `ARG RENOVATE_VERSION` in the `renovate-build` stage to `44.263.5`.
