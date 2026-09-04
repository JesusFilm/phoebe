---
"phoebe-agent": minor
---

What a pipeline owns on disk (#418): the runtime half of the pipelines model, so two engine processes can work one tenant without fighting over its clone, its worktrees, or its status file.

**The stdout tag gained a third segment.** Every engine line is now `[phoebe:<owner>/<repo>:<pipeline>]`, including the implicit `work` row's — one grammar, not two. **A host log parser matching the exact old `[phoebe:<owner>/<repo>]` string must become a prefix match**, or it stops matching. The bootstrapper's own `[phoebe]` lines are unchanged.

**The status snapshot moved to `state/<pipeline>/status.json`**, exclusively owned by one process, and carries a `pipeline` field. It holds a single `currentUnit`, so two processes sharing one file would blank each other's on every event. `phoebe list` reads the `work` row's snapshot for its existing tenant-level status line. An existing `state/status.json` is not migrated: the row rewrites its own on the first unit event, and the stale file is inert. There is a new `skipped` unit event, for a unit deferred to another pipeline's lease.

**The four tracker sweeps are scoped to the kinds their pipeline schedules.** The stranded-unit sweep partitions issue by issue, on the research label, so a row can never re-arm a ticket another row has an agent on. The quarantine sweep lists issues only from a row with an issue producer and PRs only from a row with a janitor. The stale-stack and feature-closes sweeps, both of which maintain what the issue producers create, run only from a row that schedules one. A row scheduling none of a sweep's kinds runs it empty. Exactly-once coverage across rows, with no leader election.

**The origin clone is conditional and lock-guarded.** A pipeline clones only when one of its kinds declares a `worktree` or `readonly` workspace — a row of `scratch` kinds never clones and never touches git. On a fresh tenant the first clone is serialized by a `mkdir`-style lock under the tenant's `state/`; the second process waits, then finds the clone already there. The lock is clone-only and is broken with a log line if its holder dies. Fetch and worktree administration share the clone unlocked, on git's own ref locking and the existing fetch backoff.

**Worktrees are leased.** `prepareWorktree` takes `git worktree lock` with reason `pipeline=<name> pid=<n>` and drops it on teardown; `pid=` is diagnostic. `removeWorktree` now propagates git's refusal on a locked tree instead of falling back to a recursive delete, which could take a sibling's live tree out from under a running agent — the fallback survives only for an unlocked leftover directory. A pipeline breaks its own leases at boot, unconditionally and never another's, since a lease outlives the process that took it. A unit whose tree another pipeline leases is skipped for the cycle with a logged reason rather than failed.
