---
"phoebe-agent": patch
---

Introduce nominal (branded) types for git SHAs, branch refs, and PR numbers
(`Sha`, `BranchRef`, `PrNumber`) with `asSha` / `asBranchRef` / `asPrNumber`
constructors applied at the `gh`/config trust boundary. These were previously
bare `string` / `number` that could pass each other's parameter slot silently.
Internal-only hardening — no consumer-facing API or runtime behaviour change.
