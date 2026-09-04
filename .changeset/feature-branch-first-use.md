---
"phoebe-agent": patch
---

The feature-branch arm now survives its first live use. Three faults, one PR: the captured `gh` executor dropped the `input` option, so every `gh api --input -` write (feature-branch creation and native stacking) posted an empty body and drew a 422; the branch-creation catch read any 422 as "reference already exists", hiding that; and GitHub refuses a pull request whose head and base share a commit, so the draft integration PR could never open on a branch cut straight from the default branch. `createFeatureBranch` now probes for the branch, and when it is absent seeds it with one empty commit on the default branch's tree before opening the draft PR. Stdin is forwarded on both executor paths, and only "Reference already exists" is treated as the idempotent success.
