---
"phoebe-agent": minor
---

The container template `phoebe init` scaffolds now installs Renovate, pinned to `44.210.0` by `ARG RENOVATE_VERSION`. The dependency kinds will run it as one of their sources. Renovate is built in a `node:26-bookworm` stage so its `re2` engine compiles against bookworm's glibc, and it adds about 460 MB to the image. An existing `container/Dockerfile` is left alone. To pick the install up, copy the new `renovate-build` stage and the `COPY` and `ln` lines after the bootstrapper install from a fresh `phoebe init`. On a repo the size of `JesusFilm/core` a run uses about 3 GiB of memory, so a container limit under 4 GiB will kill it.

The engine side is the Renovate source in `kinds/dependencies/sources/renovate.ts`. It runs Renovate over the read-only checkout on the local platform at `--dry-run=lookup`, with nothing from the engine's environment except `PATH` and `HOME`, under a 20-minute timeout, and reads the report file into candidates. A non-zero exit, a timeout, a missing or unreadable report, or an error in the report comes back as a failed source and a log line. Nothing is thrown.
