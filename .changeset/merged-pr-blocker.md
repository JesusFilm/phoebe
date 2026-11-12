---
"phoebe-agent": patch
---

A `Blocked by` line that names a merged pull request now counts as done. GitHub numbers issues and pull requests from one sequence, so a PR's number is an easy thing to write on that line. The engine only accepted an issue closed as completed, and GitHub reports a merged PR as `MERGED`, so the ticket waited forever. A PR that is still open, or was closed without merging, still blocks.
