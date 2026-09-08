---
"phoebe-agent": patch
---

`phoebe upgrade` no longer refuses a config whose only `engine` is a word in a comment (#478). The guard that catches an engine bound in a shape the rewriter cannot read tested the raw file for the bare word `engine`, so a config with no `engine` field at all — but with prose about the engine in its comments, which the scaffolded template ships — was told "`engine` is present but not a plain `engine: { ... }` block", naming a field its owner could not find.

The guard now looks for `engine` in a property position (`engine:`, `"engine":`, `["engine"]:`), with comments blanked out first. A quoted or computed key still refuses rather than letting `upgrade` insert a second block; prose stays prose.
