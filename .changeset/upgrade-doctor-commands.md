---
"phoebe-agent": minor
---

New operator commands: `phoebe upgrade` advances the pinned engine ref (a
strict-literal, in-place rewrite of `engine.ref` in the deployment-root
`phoebe.config.ts` — refs validated before the pin moves, rollback command
printed) and/or the npm CLI, with `--check [--json]` as a scriptable
behind-detector; `phoebe doctor [--json]` reports deployment health (cli and
engine versions, config, repo reachability, crash-loop quarantine state,
supervisor liveness) and sweeps every tenant's token and repo reachability.
