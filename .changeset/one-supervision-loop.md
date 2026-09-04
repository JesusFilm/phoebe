---
"phoebe-agent": patch
---

One supervision loop and one slot broker for solo and workspace (#416). Solo deployments used to run a dedicated single-child loop with their own broker beside the fleet's; both arms now run on `superviseFleet`, with solo as a one-tenant fleet, and `phoebe boot` creates exactly one broker per container. Nothing an operator sees changes: a solo engine exit still ends the container with its own status, a solo fast crash still feeds the crash-loop guard on the same threshold, and the drain is verbatim — SIGTERM to every child in parallel, exit raced against the grace ceiling, SIGKILL on timeout.

The two semantics that genuinely differed are now injected policy on the shared loop rather than a second code path: a `RowExitPolicy` says what a row dying on its own means for the container, and `onRunEnd`/`onRunTick` carry the guard's bookkeeping. The arm still decides discovery and whether the child inherits the supervisor's ambient env; it no longer decides which loop runs. Groundwork for pipelines (#400), where the loop supervises a flat tenant × pipeline matrix.
