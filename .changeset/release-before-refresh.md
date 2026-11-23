---
"phoebe-agent": patch
---

`dependency-updates` and `dependency-security`: a scan that refreshes a ticket parked under `phoebe:blocked` now lifts the label before it saves the new body. Before, the body was saved first. If the label then failed to come off, the next scan saw nothing to refresh and the ticket stayed parked until a person removed the label. A refresh whose label will not lift now waits for the next scan, which tries both again.
