---
"phoebe-agent": minor
---

Per-unit isolation under concurrency (#423): the caveat on `concurrency` is gone. Two units of one row can now hold worktrees, scratch directories and read-only trees at the same time without touching each other's, and the log says which unit every line came from.

**The worktree lease is per unit.** Its owner widens from `<pipeline>` to `<pipeline>#<kind>:<ref>`, so a unit finding a tree held by a sibling unit of its own row skips the cycle rather than tearing the tree down — the same treatment a tree held by another row already got, with the skip line naming the holder. The boot-time lease break still reads the pipeline segment alone, so a row keeps clearing its own leases after a kill and never anyone else's. A lease skip now waits a poll interval instead of waking the loop, since the holder will be minutes rather than microseconds.

**`scratch/<kind>` and `worktrees/readonly/<kind>` gain a ref segment.** A ref is a kind's own string and nothing in the engine parses one, so it is percent-encoded into the path — everything outside `[A-Za-z0-9._-]`, `%` included, which keeps the mapping injective and stops a ref from naming a directory that is not its own. `issue:88` becomes `issue%3A88`. Materialization is still lazy, and cleanup still removes only what was materialized.

**Every workspace handle carries a `scratch` directory beside its git shape.** A `readonly` kind now has both a reading room and somewhere to write its drafts, in the same run, and both go with the unit. `workspace` still names only the git shape, which leaves `workspace: "scratch"` reading a little oddly — "no git shape, plus the scratch every kind now has", with `dir` and `scratch` the same directory. The mode is not renamed; nothing a kind declares today changes.

**Git and install output is attributed.** The calls that inherited the engine's stdout now pipe, and every line is stamped `[phoebe:<slug>:<row>][<kind> <ref>]` — the shape `ctx.log` already used. Install output still streams as it is produced; git's arrives when the command ends. The agent bracket gains the unit too: `[owner/repo:claude][issues issue:88]`. A host parser matching agent lines on `[owner/repo:<provider>]` should match it as a prefix.
