---
"phoebe-agent": patch
---

Something now applies `mergedLabel` (#486). When a member PR merges into its feature branch, the feature-closes sweep marks the member in the same pass that appends its `Closes` line to the integration PR body. `mergedLabel` goes on, then `processingLabel` comes off. One sweep owns both writes, so the label and the line cannot drift apart.

Add first, remove second. A write that fails between the two leaves the member wearing both labels, which every reader treats as landed. The other order would leave it wearing neither, and that is finished work handed back out. `readyLabel` is untouched; that one is the human's.

So a done-but-open member stops looking stuck in `processing`. It reads as landed, waiting on the integration PR, and the queue's idle line counts it that way. A member already wearing the label is skipped, so later cycles write nothing. A feature whose integration PR is no longer open is never read at all, which is why nothing has to clear the label when the feature merges.
