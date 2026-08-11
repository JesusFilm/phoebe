---
"phoebe-agent": patch
---

Two CLI guards against misleading errors: an unknown bare subcommand is now rejected with the installed version and the `pnpm dlx phoebe-agent@latest upgrade` hint (instead of falling through to the engine-run path and dying in config validation), and the engine-run path refuses a workspace-root config with "run from a tenant directory, or `phoebe boot`" (instead of the five-required-fields error about tenant fields a root never carries).
