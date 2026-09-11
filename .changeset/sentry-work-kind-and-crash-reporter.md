---
"phoebe-agent": minor
---

The `sentry` catalog kind and a crash reporter for Phoebe's own faults (#469).

- **Catalog kinds.** A kind module path under `phoebe-agent/` resolves against the engine checkout instead of the config's directory, and a kind factory now receives the block's options as its second argument. A catalog kind ships in the engine but registers only when a tenant declares it.
- **`sentry`.** Declare `pipelines.intake.kinds.sentry` with `path: "phoebe-agent/kinds/sentry"`, `org` and the numeric `project`; add `SENTRY_AUTH_TOKEN` (scope `event:read`) to the tenant `.env`. Each cycle it lists the project's unresolved groups inside a window and above an event floor, skips the ones already on the tracker through an HTML marker read back by one search, and triages the loudest new one with a read-only agent run that writes a draft to scratch. The kind files the issue from the draft: symptom block from Sentry, cause, change and test from the agent, `sentry` plus `triaged` (or the ready label under `applyReadyLabel`) for a ready verdict, and a new "Regression of #N" issue when a fixed group is seen again. GlitchTip is supported through `collector: "glitchtip"`.
- **`reporting`.** A block beside `engine` sends Phoebe's own install and upgrade faults (a failed engine clone, a fast-exiting engine child, a crash-loop quarantine, `upgrade`/`migrate`/`init`/`doctor` throwing) to the maintainers' Sentry project (`maintainers: true`), your own (`dsn`), or both; `includeRef` gates the tenant slug. Nothing is sent until you turn it on: `phoebe init` asks once on a terminal, `phoebe upgrade` asks once for a config with no block. The work loop never reports, and there is no SDK dependency.
