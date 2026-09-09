---
"phoebe-agent": patch
---

A **landed member** — an open feature member wearing `mergedLabel`, its own PR already merged into the feature branch — is now finished work as far as the engine is concerned (#485). Selection skips it, the unresolved-blocker report never names it, and the stranded-unit sweep leaves it untouched instead of reading it as a claim that died before producing a PR and re-arming it. `readyLabel` stays on it; that label is the human's.

On a quiet cycle the issue producer's idle line stops folding landed members into the misleading `(blocked or waiting on blocker PR)` fallback. It counts them apart and names the feature they wait on — `(2 in progress, 5 landed on feature #400)` — one phrase per feature, blockers still named first.

Nothing applies `mergedLabel` yet, so this changes no live behaviour on its own. It lands first on purpose: skipping a label nobody wears is harmless, and it means the sweep that starts applying it can never hand a finished member back out.
