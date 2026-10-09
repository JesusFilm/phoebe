---
"phoebe-agent": minor
---

`prScope` now takes a list of branch prefixes beside `"phoebe"` and `"all"`, and each of the `conflicts`, `checks` and `reviews` kinds can carry its own. `prScope: ["renovate/"]` on the `checks` block alone is how a dependency bot's red PRs get fixed up without letting the other two janitors near them; `[]` admits nothing. The draft rule still calls a branch Phoebe's own by `branchPrefix` alone, env overrides stay enum-only (`PHOEBE_PR_SCOPE`, `PHOEBE_<KIND>_PR_SCOPE`), and every existing config value means what it did. The console offers the list as a third choice on the pull-request-scope row, and `phoebe config set` takes a JSON array for it.
