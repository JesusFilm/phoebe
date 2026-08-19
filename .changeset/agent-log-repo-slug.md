---
"phoebe-agent": patch
---

Agent log lines now carry the repo slug in a multi-tenant container:
`[owner/repo:provider]` (and `[owner/repo:provider:stderr]`) instead of the
bare `[provider]`, so interleaved agent output is attributable to a tenant.
`docs/operating.md` is corrected to describe the actual `[<slug>:<command>]`
prefix shape.
