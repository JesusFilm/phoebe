---
"phoebe-agent": patch
---

Warn at boot when the resolved login differs from the author on Phoebe's own newest unit-marker comment. A token swap, GitHub App identity change, or misconfigured `PHOEBE_GH_LOGIN` makes every marker Phoebe posts read as foreign activity, silently resetting the quarantine counter every rotation so quarantine never fires. The cross-check is best-effort — a lookup failure logs and boot continues. The mismatch decision is a pure function (`loginMismatchWarning`) with direct unit tests covering match, mismatch, no marker history, and deleted author.
