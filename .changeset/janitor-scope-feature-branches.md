---
"phoebe-agent": minor
---

The janitors now see feature-branch members (#341). Each cycle's PR listing covers the default branch as before, plus the branch of every live feature — one `gh pr list` per feature, all of it through the same scope filter. A member PR with red CI, a conflict, or unresolved review feedback is picked up like any other PR, where before it was invisible: nothing merges a member PR that nobody fixes, so the whole feature stalled in silence. A feature retires when its integration PR merges or closes, and `prOptOutLabel` on that PR now takes the feature's members out of scope with it, which is what makes the label the per-feature opt-out the config docs promise.
