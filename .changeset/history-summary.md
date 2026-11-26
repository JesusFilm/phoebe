---
"phoebe-agent": minor
---

The deployment report now carries a unit history summary for every pipeline and for the fleet: units by outcome, API spend and the subscription estimate as separate totals, token sums, units without cost and units with partial usage, over the last 24 hours and the last 7 days, stamped `asOf`. The bootstrapper recomputes it at boot, when a pipeline settles a unit, and hourly. `phoebe status` prints one history line for the deployment, and `--verbose` adds one under each pipeline. `phoebe status --check` is unchanged, and neither `DEPLOYMENT_SCHEMA` nor `REMOTE_PROTOCOL` moves.
