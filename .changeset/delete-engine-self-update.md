---
"phoebe-agent": minor
---

The engine's self-update machinery is gone, and `phoebe init` scaffolds the
bootstrapper model. With `phoebe boot` owning engine updates, the engine no
longer diffs its own code on every cycle and exits for a supervisor re-exec:
`selfUpdatePaths` is removed from the config, and the shell `supervisor.sh` the
scaffold used to write is removed with it.

**The engine version moved out of the image and into the config.** It is now
`engine: { source: "github", ref }` in `phoebe.config.ts`, and `PHOEBE_VERSION`
is gone from the scaffolded compose and `.env`. Editing `ref` upgrades a running
deployment: within one reconcile interval boot drains the engine at a work-unit
boundary and relaunches it on the new commit — no image rebuild, no container
restart. A tag or SHA pins exactly; a branch follows its tip, guarded by the
crash-loop fallback.

**If you already scaffolded a runtime** (nothing is published yet, so this
breaks no released version), migrate it:

- `selfUpdatePaths` is no longer a config field. Remove it — an unknown field is
  a type error.
- Your `phoebe.config.ts` must import **nothing at runtime**. Replace
  `import { defineConfig } from "phoebe-agent"` with
  `import type { PhoebeUserConfig } from "phoebe-agent"` and a plain default
  export. Boot loads the config from the container mount, where no
  `node_modules` is reachable, so a value import fails to resolve.
- Add an `engine` field (it defaults to `{ source: "github", ref: "main" }` —
  pin it) and set `PHOEBE_ENGINE_DIR` at a persistent volume so engine checkouts
  survive a restart.
- Re-scaffold `container/`: the Dockerfile's `ENTRYPOINT` is now
  `["/usr/bin/tini", "--", "phoebe", "boot"]`, `compose.yml` describes the
  long-lived container directly, and `compose.daemon.yml` is replaced by a
  dev-only `compose.local.yml` for running an engine checkout from your host.
