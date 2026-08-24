---
"phoebe-agent": minor
---

`phoebe doctor` now checks the launcher version against `phoebe.minBootstrap`. A launcher below the engine's declared floor deadlocks the deployment — boot throws on startup and no work runs. Doctor names both versions, explains the situation plainly, and gives the one-line fix. No floor declared means the check does not apply.
