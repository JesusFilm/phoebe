---
"phoebe-agent": patch
---

Quarantine now works in a repo that has no `phoebe:quarantined` label. Before, adding the label failed with "not found", so a unit that kept producing nothing went back into the queue on every pass and never stopped using agent time. Phoebe now creates the label the first time it needs it, the same way it already did for `processingLabel` and `mergedLabel`. `phoebe doctor`'s labels check also lists `phoebe:quarantined`, so a repo missing it shows up there.
