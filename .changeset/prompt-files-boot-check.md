---
"phoebe-agent": patch
---

Validate `promptFiles` at engine startup (#164). Prompt loading was fail-at-use:
a tenant whose runtime root was missing one prompt kind booted clean, polled
happily, and only died when the first work unit of that kind was dispatched —
which for a rare kind meant weeks later, one failed unit at a time. The engine
now checks, before it starts, every entry the tenant's `workOrder` can actually
dispatch, and refuses to run with a single error naming the tenant and every
missing kind with its resolved path. A kind you dropped from `workOrder` needs no
prompt file — it was never going to be loaded.

Being a loadable file is the whole rule — a regular file, since a directory would
pass an existence check and then throw `EISDIR` at dispatch — so a `promptFiles`
key may point outside the runtime root. That is what a `configDir` tenant wants:
`issue: "../prompts/issues-prompt.md"` reaches the prompts at the repo root
instead of keeping a second copy under `<configDir>/prompts/` that silently
misses every prompt improvement merged afterward.
