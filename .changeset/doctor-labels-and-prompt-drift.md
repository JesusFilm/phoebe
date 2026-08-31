---
"phoebe-agent": minor
---

`phoebe doctor` gains two per-tenant checks: `labels` verifies that `readyLabel`, `processingLabel`, and `prOptOutLabel` exist in the repo (naming the missing ones and the exact `gh label create` fix for each); `prompt-drift` warns when a vendored issues prompt lacks the blocker-recording rule, so operators learn before their agents quarantine blocked issues instead of parking them.
