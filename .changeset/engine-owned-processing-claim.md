---
"phoebe-agent": minor
---

Engine applies `config.processingLabel` to the GitHub issue before handing it to the agent, and `selectIssue` / `unresolvedBlockerNumbers` filter out issues already carrying that label so a unit in flight is invisible to selection.
