---
"phoebe-agent": minor
---

A unit that ends with its issue still claimed and no pull request no longer reads as `completed` in the unit history. The engine now settles an issue-keyed unit's claim as soon as the unit ends, instead of waiting for the stranded-unit sweep on the next pass. It re-arms the issue, posts the timeout marker, and quarantines on the K-th run, the same as the sweep does. The unit's record carries the result: a run that returned normally is recorded with the new outcome `unproductive`, and whichever record's run reached K has `quarantined: true`, whether that run was unproductive, failed or timed out. The sweep still covers claims that a crash or restart left behind.

The observer flags `unproductive` units. `phoebe history` accepts `--outcome unproductive` and shows the count in its footer. `phoebe status` counts these units among the ones that did not complete, and so does the console, which also gives them their own chip and a "Quarantined" row in a pipeline's breakdown. Records keep `v: 1`. A reader older than this release counts an `unproductive` record under no outcome rather than skipping it. A quarantine comment from the stranded-unit sweep now names the ticket's own kind, so a research ticket reads `research` rather than `issues`.
