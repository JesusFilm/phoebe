---
"phoebe-agent": patch
---

A member issue whose PR has merged into its feature branch now says so. The feature-closes sweep, which already appends the member's `Closes` line to the integration PR body each cycle, marks the member in the same pass: `mergedLabel` on, then `processingLabel` off (#486). The member is left wearing `mergedLabel` and `readyLabel`, which reads everywhere as done-awaiting-integration rather than as work in flight.

Add first, remove second, so a failure between the two leaves the member wearing both labels — a stale claim, not a finished ticket back in the pool. A member already wearing `mergedLabel` is skipped, so later cycles write nothing, and a feature whose integration PR is no longer open is out of the sweep's sight entirely. Nothing clears the label: merging the integration PR closes the members through GitHub's `Closes` cascade, and a label on a closed issue is inert.
