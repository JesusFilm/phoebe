---
"phoebe-agent": minor
---

`conflicts` and `checks` now catch a PR up with its **own base** rather than always the default branch (#392). Every merge either kind runs — the agent-free `cleanMerge`, the tree `prWorkflow` primes for the agent, and the `conflict` prompt's instructions — read the base off `mergeInfo`, which now carries `baseRefName`. For an ordinary PR and for a feature's integration PR that is still the default branch, so nothing changes. For a feature **member**, whose base is `<branchPrefix>feature-<M>`, it is the feature branch — and that is the merge GitHub was reporting a conflict against all along. Merging the default branch there resolved a different merge, left the reported conflict in place, and grew the member's diff by however far `main` had moved. The `conflict` prompt names the base through a new `{{BASE_BRANCH}}` placeholder; it defaults to the default branch, so a tenant prompt override written against `{{DEFAULT_BRANCH}}` still renders unchanged.
