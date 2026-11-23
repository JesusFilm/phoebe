---
"phoebe-agent": patch
---

The issues prompt now covers a ticket whose work is already on the default branch, as when someone fixed it by hand and the PR never said `Fixes #N`. The agent comments with the commit or PR that did it and what it checked, and ends the comment with the `<!-- phoebe-blocked -->` line, so the ticket is parked under `phoebe:blocked` after one run for a person to close. Before, such a run left no comment, read as a crash, and repeated until quarantine. If you keep your own copy of `prompts/issues-prompt.md`, copy the new rule across from the shipped prompt.
