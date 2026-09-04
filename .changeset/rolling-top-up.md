---
"phoebe-agent": minor
---

Rolling top-up (#422): a pipeline's `concurrency` now does something. The loop keeps an in-flight set capped at the pipeline's declared number, and each pass wakes on whichever comes first — a unit settling or the poll interval. A pass with a free slot gathers once and admits up to `concurrency − inflight` units; a pass with none skips the gather and still runs the sweeps. At concurrency 1, which is still the default, this is the serial loop it has always been, with one named exception: a failed unit is reconsidered immediately instead of sleeping out a poll interval first.

**`select` may now be called more than once per cycle.** The walk goes depth-first by `order`, so priority still means priority: the first kind is asked until it runs out before the next is asked at all. `ctx` gains `inFlight`, a read-only set of that kind's refs currently running, including the ones admitted earlier in the same pass. **A kind honouring it can fill several slots; a kind ignoring it offers a running ref again, the engine drops the repeat and stops asking that kind this pass** — so the cost of ignoring it is one unit at a time, never two agents on one unit. Custom kinds need no change to keep working.

**Two units never share a GitHub object.** A unit whose `github` target is already in flight is refused at admission. A unit that declares no target gets no exclusion, and says so in the log.

**All four tracker sweeps skip units this pipeline is running**, on top of the per-pipeline kind filter. That closes a live bug concurrency exposes: the stranded-unit sweep re-arms any issue wearing the processing label with no PR yet, which is exactly a running `issues` unit between its claim and its first push. Note that the sweeps now also run on a pass that admits nothing, so a long unit no longer holds tracker repairs behind it — a pipeline with a slow kind will make more `gh` calls per unit than it used to.

**The credential lease is pipeline-scoped**: one live lease per process, refreshed in place, checked at admission ahead of the slot request. A failed refresh blocks new admissions and leaves the token cell alone, so units already running finish on the credential they were handed.

**`status.json` holds `currentUnits[]` instead of `currentUnit`.** Each entry carries `startedAt` and the per-kind `runBudgetMs`, and the snapshot gains `waitingForSlot` for a pass parked on the broker. A snapshot written by an older engine is read back on the new shape, so an upgrade across a retained state dir needs no migration; `phoebe list` names every running unit.

Per-unit worktree and stdio isolation is a separate ticket. Until it lands, two `worktree` kinds in one pipeline at concurrency 2 can still collide over a workspace — raise the number for pipelines whose units cannot share a tree.
