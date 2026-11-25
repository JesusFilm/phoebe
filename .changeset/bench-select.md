---
"phoebe-agent": minor
---

Add `phoebe bench select`, the first verb of the offline replay benchmark. It builds a suite of fixtures from issues Phoebe already solved and prints it as JSON on stdout. Name the issues with `--issues 12,34`, or query merged PRs on `phoebe/issue-<n>` branches with `--since` and `--limit`. A fixture needs one PR, merged into the default branch, with a single git author. Feature-branch issues, stacked PRs, PRs with commits from more than one author, and issues blocked mid-way are skipped, each with its reason. Each fixture pins the issue's title, body and the comments posted before the PR opened, the PR's head and merge commits, and `baseSha`, which is computed in the hub clone. On the host the verb runs in a one-off container from the deployment's image. `--tenant` picks the tenant in a workspace. The verb reads GitHub and never writes to it.
