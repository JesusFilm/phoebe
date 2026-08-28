---
"phoebe-agent": minor
---

The stranded-unit sweep now owns the unproductive-run counter for issue-shaped units, applying `phoebe:quarantined` after K runs that produce no PR — not just timeouts. `recordUnitTimeout` narrows to PR-shaped units (conflicts, checks, reviews), eliminating the double-count that existed when an issue both timed out and was found stranded. The escalation comment for quarantined issues now says "N consecutive runs produced no PR" instead of claiming a timeout. `maxUnitTimeouts` is renamed `maxUnproductiveRuns` (config field and `PHOEBE_MAX_UNPRODUCTIVE_RUNS` env var); the old names work as deprecated aliases and a `phoebe migrate` step rewrites them.
