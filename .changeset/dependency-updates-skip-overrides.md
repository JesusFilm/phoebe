---
"phoebe-agent": patch
---

`dependency-updates` no longer files a bump for an override entry. That covers `overrides` in `package.json` or `pnpm-workspace.yaml`, `pnpm.overrides`, and yarn `resolutions`. An override holds a transitive package where its dependents need it, often at a security fix. Proposing that package's newest release would carry those dependents past the range they declare, as when a js-yaml 4.3.2 fix override became a 5.x upgrade under packages declaring `^4.1.0`. The scan log now says how many override entries it skipped. `dependency-security` still moves an override, to the fix an advisory names. The Renovate source marks these entries with a new optional `override` field on the candidate.
