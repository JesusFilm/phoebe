---
"phoebe-agent": patch
---

Bound `superviseFleet.drain` with a SIGKILL escalation (#79). Draining the fleet
on shutdown no longer hangs indefinitely on a child that ignores SIGTERM — the
supervisor escalates to SIGKILL after a bounded grace period.
