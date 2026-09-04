---
"phoebe-agent": patch
---

`docs/pipelines.md` is the home of the pipelines model (issue #428). It opens with who the page is for, then takes one section per design decision: what a pipeline is, declaring one and which of the six knobs cost a relaunch, supervision and the universality rule, units in flight, the two ceilings on concurrency, what a row owns on disk, credentials per pipeline, the stale-state sweep, reading `phoebe list`, units the engine cannot see, and the intake example the framework was validated against — Slack-to-issues and AFK bug triage — walked end to end with the wake seam named and the connectors marked out of scope.

Every other doc keeps the seam it already owns and gains a pointer. `configuration.md` stays the sole home of the six-knob field table; `work-kinds.md`'s intro and poll loop are now explicitly the view from inside one pipeline, and its kind-contract additions gain a patterns section covering draft handback, handover, label partitioning, the kind-owned quarantine filter, and self-checking factory prompts. `CONTEXT.md` gains Pipeline, Admission, In-flight set, Worktree lease, Declared key, Wedged, Stale and the engine log tag, and corrects Fleet, Engine, Work order, Cycle, Work unit and Drain for a world where a tenant is a matrix of rows rather than one loop.
