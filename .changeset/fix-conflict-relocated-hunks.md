---
"phoebe-agent": patch
---

Let the conflict-resolution agent drop relocated or superseded hunks (#89)
instead of forcing every hunk to apply, so a rebase whose changes have moved or
already landed upstream resolves cleanly.
