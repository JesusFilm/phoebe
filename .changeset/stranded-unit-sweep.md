---
"phoebe-agent": minor
---

Each cycle sweeps open issues that carry `processingLabel` but have no open or merged Phoebe PR. The sweep removes the stale claim and puts the issue back in the queue, so a killed or crashed run cannot strand an issue indefinitely.
