---
"phoebe-agent": minor
---

Plain-directory workspaces for work kinds (#358): `workspace: "scratch"` is the second member of the workspace union, and `ctx.workspace` in a kind's `run` is now `{ mode: "worktree" | "scratch", dir }`. A scratch workspace is one empty directory — no clone, no branch, no git state — for kinds that only need somewhere to write files. It is created on first read of `ctx.workspace.dir` and removed with the unit, the same laziness the worktree arm has, and lives at `/data/repos/<owner>/<repo>/scratch/<kind>`, cleared before each run so a directory left by a killed run is never inherited. `PathsConfig` gains the derived `scratchDir`. The reference kind in `examples/custom-kind/` runs on the new mode: it posts a comment and never needed a checkout, and its prompt now passes `gh` an explicit `-R`.
