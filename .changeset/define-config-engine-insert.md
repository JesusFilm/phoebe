---
"phoebe-agent": patch
---

`phoebe upgrade` can now insert a missing `engine` block into a config written as `defineConfig({ ... });` (#479). The insert branch only recognised a top-level object closed by a column-0 `};`, which is the shape the templates scaffold — a `defineConfig` config, the documented modern form and the one this repo's own root config uses, closes with `});` and always fell through to the "apply the edit yourself" advisory instead.

Both closings now count, and the strictness is unchanged: exactly one closing of exactly one shape, or the upgrade refuses. A file carrying both is as ambiguous as one carrying two of either.
