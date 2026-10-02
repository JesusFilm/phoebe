---
"phoebe-agent": minor
---

The deployment report now carries every tenant's effective config. Section
`config` of `state/deployment.json` holds the same annotated object
`phoebe config --json` prints, each setting with its value and the source that
supplied it, so `phoebe status --json`, the relay and the console can show a
tenant's settings without asking the deployment a second question. The text
`phoebe status` leaves it out.

The running engine computes each row, per tenant, the way the bootstrapper
already asks it for a tenant's pipelines. So the report says what the engine
believes rather than what the bootstrapper would guess, and a relaunch onto a
different commit re-reads it. A tenant that is held, or whose file will not load,
carries its error instead of the resolution it had before it broke. A tenant is
re-asked only when its `phoebe.config.ts` or its `.env` moves, so a steady fleet
spawns nothing.

The section also carries a content hash of the root `phoebe.config.ts` it was
derived from, which is what a remote config edit will check itself against before
writing. And it is written to a byte budget, so a workspace with far more tenants
than any Phoebe runs today produces a report that stops growing instead of one
that does not. The tenants left out are counted in `config.omitted`.
