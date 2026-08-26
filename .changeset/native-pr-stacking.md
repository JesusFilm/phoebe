---
"phoebe-agent": minor
---

Stacked work rides GitHub's native stacked pull requests (#311). A PR opened
for an issue blocked by an open blocker PR now targets the blocker's branch and
is added to the blocker's stack — created when the blocker has none — so merge
ordering, post-merge rebase, and retargeting are GitHub's job instead of a
⛓️ do-not-merge banner and a lazy catch-up merge.

The Stacks API is a public preview, so unavailability is an outcome rather than
an error: when any stacking call fails, the freshly created PR is retargeted
back onto the default branch and the banner arrives as a comment, which is the
flow as it was. The PR body's strong warning became a neutral "stacked on"
note either way, because the body is written before the outcome is known.
