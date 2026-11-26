---
"phoebe-agent": minor
---

`phoebe observe [--tenant <owner/repo>] [--lookback <period>]` and `POST /api/observe` (scope `operate`) start an observer run now. The verb drops an ask that the bootstrapper answers within a second or two. The bootstrapper passes the ask to the observer's pipeline over IPC, which ends that pipeline's idle wait, so the run starts on its next pass whether or not `every` is set or due. `--lookback` applies to that run only. `--tenant` is needed only when more than one tenant declares the observer. The bootstrapper refuses with a reason, and queues nothing, when the fleet is stopped, when the tenant does not declare the observer, or when a run is already in flight for that tenant. That refusal gives the time the run started. `phoebe pipelines` now lists each pipeline's scheduled `kinds`, which is how the bootstrapper finds the observer's pipeline. `REMOTE_PROTOCOL` stays at 1, and a deployment from before the route answers 404.
