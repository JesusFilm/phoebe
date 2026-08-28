---
"phoebe-agent": patch
---

Fix stale-stack sweep to retarget every orphaned stack member, not only the PR whose blocker completed (#360): the GitHub stacks `unstack` endpoint dissolves the whole stack, leaving all other members with stale Phoebe-branch bases. The sweep now falls through to `retargetPr` when `unstackPr` reports `not-in-stack`, so a PR whose stack was dissolved earlier in the same cycle (or in a prior one) still gets moved onto the default branch when its blocker has completed.
