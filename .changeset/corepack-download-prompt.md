---
"phoebe-agent": patch
---

Corepack's download confirmation can no longer hang a work unit. The `pnpm` and
`yarn` shims `corepack enable` installs default `COREPACK_ENABLE_DOWNLOAD_PROMPT`
to `1`, so the first use of a version Corepack has not cached yet asks "Do you
want to continue? [Y/n]" — and blocks on stdin whenever it is a TTY and `CI` is
unset, which is exactly the case for a deployment started with `docker compose
run`. The engine spawns `installCommand` with inherited stdio, so that question
reached a terminal with no operator watching it and the unit stalled at install
rather than failing; the run-timeout deadline cannot interrupt a blocked
`execSync`, so it stalled indefinitely. `installCommand` and the prompt `!`
expansions now default the variable to `0`, which answers the confirmation
without changing what gets downloaded — the version still comes from the repo's
own `packageManager` field. An operator who sets the variable themselves keeps
their value. (The expansions were never at risk of hanging — `execSync`'s default
stdio gives them a piped stdin — but they would still have logged Corepack's
download notice, and both spawns now build their env the same way.)

This removes the need for a consumer image to set it: the fix holds for any image
whose toolchain runs through Corepack, not just those that thought to add the
`ENV` line.
