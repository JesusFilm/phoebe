---
"phoebe-agent": minor
---

`dependency-security` now takes `prConcurrentLimit`, default `5`, and stops filing routed issues once that many of its own bundles are open. It used to file every one at once, which on a repository with a backlog meant twenty pull requests against one lockfile. A bundle with a critical advisory is still filed whatever the count, tracking issues hold no slot, and the bundles `dependency-updates` has open are not counted. Set `prConcurrentLimit: 0` to file everything as before.
