---
"phoebe-agent": minor
---

A read-only workspace mode for work kinds (#397): `workspace: "readonly"` is the third member of the workspace union, so `ctx.workspace` in a kind's `run` is now `{ mode: "worktree" | "scratch" | "readonly", dir }`. A readonly workspace is the same worktree the `worktree` arm prepares, detached at `origin/<defaultBranch>` and living at `/data/repos/<owner>/<repo>/worktrees/readonly/<kind>`. That gives a kind repo context with no branch to commit onto, nothing created or moved in the clone, and a bare `git push` that fails for want of a refspec. It is materialized on first read of `ctx.workspace.dir` and removed with the unit, the same laziness the other two arms have.

The don't-push contract is that shape rather than a guard. A kind holds `ctx.env` and is trusted as the tenant, so the mode covers accident, not intent. The engine's one check runs at the unit boundary: a readonly tree left dirty or carrying commits is warned about as it is discarded, so work with nowhere to go is not lost silently. The unit still succeeds. `OriginHub` gains `addWorktreeDetached` and `dirtyFileCount`.
