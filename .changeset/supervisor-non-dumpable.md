---
"phoebe-agent": patch
---

Make the supervisor non-dumpable in the consumer image — chmod 0711 the system node.

`templates/container/Dockerfile` now applies `chmod 0711 "$(command -v node)"` unconditionally,
matching the dogfood image's long-standing deviation. The supervisor (`phoebe boot`) and every
engine child run on this system node; without the execute-only bit, those long-lived processes
holding `GH_TOKEN` stayed dumpable and a same-uid sibling could read `/proc/<pid>/environ`. The
dogfood has run exactly this in production — evidence it does not break the shebang shims or
execute-only ELF loading.

`docs/trust.md` updated: the "what is isolated" list now names both the vendored cursor node
(protecting the agent process) and the system node (protecting the supervisor and engine
children), so the full non-dumpable set is documented.

`docs/upgrading.md` adds a one-time image-rebuild note for existing deployments that predate
this change.
