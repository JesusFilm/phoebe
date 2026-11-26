---
"phoebe-agent": minor
---

The `observer` kind now flags units by what became of their pull requests, as well as by their records. Once a PR has merged or closed, each unit that worked it can earn these flags: `changes-requested`, `review-threads`, `outside-commits`, `closed-unmerged`, `reverted`, `actions-failed` and `slow-merge`. `outside-commits` means another git identity pushed a content commit after Phoebe's first. `slow-merge` means the PR took more than seven days to merge. A record with no PR number is matched to its PR by branch. Reverts are found from the revert PR or from the revert commit on the default branch. Units on an observer proposal are never flagged. For 20 PRs the reads come to about four GraphQL queries plus one Actions REST call per settled PR. `statusCheckRollup` is not read.
