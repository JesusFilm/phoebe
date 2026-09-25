---
"phoebe-agent": minor
---

A local install's rail entry carries shortcuts. A stopped install shows a play icon; a running one shows pause, stop and restart. Pause is `stop` as it drains, the unit in flight finishing and no new one starting; stop is `stop --now`; restart is a drain and then a start. Each opens the install's page and starts the same run the install tab does, so the output lands there as always. While any run is in flight on an install, its shortcuts give way to a spinner until the run ends, on runs started from the page too. The icons are Lucide's, the set T3 Code draws from, which brings `lucide-react` into the console.
