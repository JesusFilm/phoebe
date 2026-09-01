---
"phoebe-agent": minor
---

Each cycle, Phoebe now maintains a delimited `Closes #N` block in a feature's integration PR body, one line per member PR that has merged into the feature branch. GitHub honours closing keywords only on a PR bound for the default branch, so this is what makes merging the integration PR close the whole set of member issues at once — at the moment the work reaches the default branch, not while it sits on a branch. The sweep only ever appends, so a human's own prose in that body survives it.
