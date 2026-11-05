---
"phoebe-agent": minor
---

A work kind's definition can now declare `unitKey: "issue" | "pr" | "none"`, and the tracker sweeps read it in place of the five built-in names. A custom or catalog kind that declares `"issue"` gets the stranded-unit, quarantine, stale-stack and feature-close sweeps that `issues` and `research` get. One that declares `"pr"` gets the PR half of the quarantine sweep. Leaving the field out means `"none"`, which is what every custom kind got before, so no existing kind changes behaviour until it opts in. The built-ins declare theirs. Tickets without the research label count as belonging to every issue-keyed kind except `research`, so keep `issues` and an issue-keyed custom kind in the same pipeline.
