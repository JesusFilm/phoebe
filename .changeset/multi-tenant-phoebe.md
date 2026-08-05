---
"phoebe-agent": minor
---

Multi-tenant Phoebe: run one container that supervises many repos (map #57). A
single deployment can now discover a fleet of tenants from
`/etc/phoebe/repos/<owner>/<repo>/` — each with its own `phoebe.config.ts` and
`.env` — and run one supervised engine child per tenant behind a global
concurrency cap, per-tenant `[phoebe:<slug>]` log tagging, per-tenant
`state/<slug>/status.json`, and `phoebe list`. Env-scrub isolation hands each
child only its own secrets. The flat single-tenant layout still works
unchanged; nested discovery is additive.
