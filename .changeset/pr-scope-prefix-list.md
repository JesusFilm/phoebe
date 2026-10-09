---
"phoebe-agent": minor
---

`prScope` now takes a list of branch prefixes beside `"phoebe"` and `"all"`, and each PR janitor can carry its own. The list is the literal set of prefixes a janitor admits, matched the way `branchPrefix` is, so `"phoebe"` is sugar for `[branchPrefix]` and `[]` admits nothing; a `conflicts`, `checks` or `reviews` block takes the same field and inherits the tenant's when it has none. A tenant on `"phoebe"` with `checks: { prScope: ["renovate/"] }` has Phoebe chase the bot's red CI while the other two janitors never see it. Phoebe's _own_ branch is still `branchPrefix`, so a draft on an admitted prefix stays someone else's draft under `draftPrs: "skip-non-phoebe"`. Env reaches both paths — `PHOEBE_PR_SCOPE` and the new `PHOEBE_<KIND>_PR_SCOPE` — and takes `phoebe` or `all` only: the list is a config-file value. Existing configs are unaffected.
