---
"phoebe-agent": minor
---

Stale-state sweep and the doctor `stale-state` check (#426). Deleting a pipeline, renaming one, or retiring a work kind used to leave disk with no owner: `state/<pipeline>/` and its snapshot, `scratch/<kind>` and `readonly/<kind>` trees, and worktrees locked by a lease whose pipeline no longer existed and which nothing was allowed to break. A new one-shot engine command, `phoebe sweep-state`, reclaims them, and `phoebe boot` invokes it per tenant at two moments and never on a timer: at facility boot before any pipeline spawns, and after a pipeline-set change once the pipelines it took down have drained.

Orphanhood is a stateless diff of disk against the pipeline enumeration, re-derived every sweep. State is orphaned only when its pipeline name — or, for kind-keyed state, its kind — is absent from the enumeration, so a `disabled` pipeline is still enumerated and its state is stopped rather than orphaned, a rename is a delete plus a create, a kind that moved between pipelines keeps its scratch, and an enumeration that fails skips the sweep entirely instead of reading unknown as "everything is orphaned".

Deletion is tiered. Leases, orphaned state directories, unowned scratch and read-only trees, and clean worktrees are reclaimed. A worktree that is dirty, or that holds commits `origin` has not seen, is never auto-deleted — it is reported with its exact path and a one-line reclaim hint. Worktrees are classified by the lease rather than by name: locked by a live pipeline is untouchable, orphan-locked or unlocked is a candidate, which makes the sweep the second thing allowed to break a worktree lease after a pipeline breaking its own at boot.

The sweep is never load-bearing: per-item failures continue, and a whole sweep that fails is one log line while the pipelines spawn as if it had never run. `phoebe doctor` gains a per-tenant `stale-state` check — its first look at the repos data directory — reporting orphans by tier including the worktrees the sweep refused, always warn and never fail.
