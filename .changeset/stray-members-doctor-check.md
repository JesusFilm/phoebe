---
"phoebe-agent": patch
---

`phoebe doctor` gains a per-tenant `stray-members` check. When a feature ends — its integration PR merged or closed, or its parent issue closed — routing stops seeing the members underneath it, so whichever of `readyLabel`, `researchLabel`, `processingLabel` or `mergedLabel` a member was wearing at that moment stays on it, and nothing is coming to take it off. The check names each one with its feature and the one repair Phoebe deliberately does not make: close it when the integration PR merged, and when the feature was cancelled either close it or strip the label, which routes it back onto the default branch as an ordinary ticket. Report-only, warn and never fail, like `stale-state`, and the exit code stays 0.

The membership walk now reports the feature parent's own state (`resolveFeatureMembership`) rather than folding a retired feature into "no feature", so a stray can be told from an issue that never belonged to a feature at all. `resolveFeature` and everything that routes through it are unchanged. The cost is one tracker query per watched label plus the issue graph above whatever those return, paid when you run doctor and never per cycle.
