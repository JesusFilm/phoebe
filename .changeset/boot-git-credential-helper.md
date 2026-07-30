---
"phoebe-agent": patch
---

Authenticate git against private repos at boot. When `GH_TOKEN` is set,
`phoebe boot` runs `gh auth setup-git --hostname github.com` once before
supervising the engine, so `ensureClone`, engine fetch/push, and the agent
child's own `git push`/`fetch` all authenticate via a live credential helper
— no token is written to disk.
