---
"phoebe-agent": minor
---

A repository that runs as a workspace tenant and as its own deployment can keep one `phoebe.config.ts` instead of two. Put the config in the asset directory and leave a pointer at the root, a `phoebe.config.ts` that declares `configDir` and no `repoSlug`. When `<configDir>/phoebe.config.ts` exists, that file governs the tenant: the bootstrapper reads its `repoSlug`, `gitIdentity` and pipelines, reconciles on it, and runs the engine child on it. `phoebe config`, `phoebe config set`, `phoebe secret` and `phoebe pipelines` run in the tenant's directory follow the pointer, and `phoebe --run-once` from there names the directory to run from. A root that declares its own `repoSlug` still governs itself, so a tenant with two whole configs runs on the same file after the upgrade as before it. See `docs/configuration.md`, "One config for a repo deployed two ways".
