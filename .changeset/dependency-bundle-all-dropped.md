---
"phoebe-agent": patch
---

A dependency ticket whose bumps all drop is now parked under `phoebe:blocked` instead of being re-run until quarantine. With every bump dropped the implementer opens no PR, so the stranded sweep used to re-arm the ticket and burn `maxUnproductiveRuns` runs, and the detector never saw the failure. The `dependencies` prompt now has the agent put the `## Dropped` section in its issue comment and end it with the `<!-- phoebe-blocked -->` line. `dependency-updates` reads that comment as well as PR bodies, so a retry that fails counts as the second failure and stops being filed. The agent tags a bump the package manager refused only for its release age as `(too new)`. That bump counts no failure, and a later scan that still plans a ticket parked only for that reason lifts the label itself, at most once per scan.
