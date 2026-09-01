---
"phoebe-agent": minor
---

Feature base arm (#379): unblocked members of a live feature are routed onto `origin/<branchPrefix>feature-<M>` instead of the default branch, and their PRs target that branch. The first member creates the feature branch (idempotent on 422) and a draft integration PR via the GitHub REST API; subsequent members reuse both. `PHOEBE_BASE` and stacked routing bypass the arm. `IssueGraphNode` and `Feature` now carry a `title` field so the integration PR is named after the parent issue without an extra API call.
