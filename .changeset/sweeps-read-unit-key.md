---
"phoebe-agent": minor
---

A work kind's definition can now declare `unitKey: "issue" | "pr" | "none"`, and the tracker sweeps read it in place of the five built-in names. A custom or catalog kind that declares `"issue"`, with its queue label in `unitLabel`, gets the stranded-unit, quarantine, stale-stack and feature-close sweeps that `issues` and `research` get. One that declares `"pr"` gets the PR half of the quarantine sweep. Leaving the field out means `"none"`, which is what every custom kind got before, so no existing custom kind changes behaviour until it opts in.

The stranded-unit sweep now decides which kind owns a claimed ticket by the queue label the ticket wears, so an issue kind can run in a pipeline of its own without either pipeline re-arming the other's tickets. One built-in behaviour changes with it. A claimed ticket that wears no queue label, because someone removed `readyLabel` while it was claimed, is now left claimed rather than re-armed with `readyLabel` put back, and a re-arm no longer adds any label.
