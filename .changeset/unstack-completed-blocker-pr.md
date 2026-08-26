---
"phoebe-agent": minor
---

Add a stale-stack sweep that unblocks a natively stacked PR when its blocker issue closes as completed without merging a Phoebe PR. The sweep detects the dead stack layer each cycle, calls the GitHub Stacks unstack endpoint, and retargets the dependent PR onto the default branch.
