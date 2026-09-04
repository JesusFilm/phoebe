---
"phoebe-agent": patch
---

Pipeline drains driven by a reconcile now race their graces together instead of one after another. The container-stop and engine-relaunch paths already fan out through `drainAll`, but the pipeline axis awaited `drain(record)` a pipeline at a time, so removing or relaunching N pipelines in one poll could serialize N drain graces — an hour each by default — with the stale-state sweep and every respawn waiting behind the sum. The drains a poll asks for are collected and joined with `Promise.all`; the sweep and the respawns still sit behind that join, because both are only sound once every pipeline the reconcile takes down is down.
