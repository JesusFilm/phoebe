---
"phoebe-agent": minor
---

The bootstrapper now runs `phoebe doctor` itself, and the deployment report
carries what it found. A run happens when the fleet comes up, after a reconcile
lands, on request, and every six hours (jittered per deployment). One run happens
at a time: a trigger arriving mid-run joins it and receives that run's result,
and a trigger arriving mid-reconcile waits for the relaunch, then runs once
against the engine that is actually running. `state/deployment.json` gains a
`doctor` section holding the last report, the trigger that produced it, when it
was taken, a marker while a run is in flight, and the last attempt that produced
nothing. `DoctorReport` now lives in `phoebe-agent/contracts`, so a console can
render one without importing the engine.

Those runs are spawned as a child process and handed the installation tokens the
supervisor already holds for its tenants, so `repo`, `labels` and
`stray-members` are real checks on an App-arm deployment instead of "not probed".

Every doctor run, manual ones included, now answers within five minutes. A check
that has not finished by then reports `unknown` with "deadline passed", and the
rest of the report still lands. One unreachable tenant costs you that tenant's
answers rather than the whole report. The bootstrapper kills its own doctor child
thirty seconds past that as a backstop; the last completed report stays in the
deployment report with its age, and the failed attempt is recorded beside it.
