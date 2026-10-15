---
"phoebe-agent": patch
---

Fixes for the `prScope` prefix lists. A `PHOEBE_<KIND>_PR_SCOPE` set to anything but `phoebe` or `all` now stops the engine at startup with an error naming the variable, the way `PHOEBE_PR_SCOPE` already did. It used to be skipped without a word while `phoebe config` reported it as the value in effect. A list entry holding whitespace, like `"  "` or `" renovate/"`, is now refused, because it could never match a branch. `phoebe config set` and the console write a list as `["a", "b"]` rather than `["a","b"]`. Retyping a list with different spacing no longer turns Save on. When `branchPrefix` is computed, a fresh prefixes box now opens empty instead of on `phoebe/`. The docs now warn that a list leaving out your `branchPrefix` takes Phoebe's own PRs away from that kind.
