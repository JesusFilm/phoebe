---
"phoebe-agent": patch
---

`phoebe init` now scaffolds the dependency kinds as a commented `pipelines` block in `phoebe.config.ts`, with a note in each `.env.example` that they need no credential. The scaffolded `compose.yml` says the Renovate source needs a container memory limit of at least 4 GiB on a large repo. `docs/configuration.md` lists every option of `dependency-updates`, `dependency-security` and `dependencies` with its default.
