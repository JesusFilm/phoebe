---
"phoebe-agent": minor
---

Stacked work rides GitHub's native stacked pull requests (#311). A PR opened
for an issue blocked by an open blocker PR now targets the blocker's branch and
is added to the blocker's stack — created when the blocker has none — so merge
ordering, post-merge rebase, and retargeting are GitHub's job instead of a
⛓️ do-not-merge banner and a lazy catch-up merge.

The agent's own `gh pr create` (issues prompt, step 7) targets the same base
via a new `{{PR_BASE}}` placeholder, so both creation routes produce the
stack's shape. A blocker buried under another open layer is not joined —
`/add` appends to the top, which would stack the PR on a sibling it does not
build on — and falls back instead.

The Stacks API is a public preview, so unavailability is an outcome rather
than an error: when the PR cannot be stacked, the ⛓️ do-not-merge banner is
posted as a comment (once) and the PR is retargeted onto the default branch,
which is the flow as it was. The PR body's strong warning became a neutral
"stacked on" note either way, because the body is written before the outcome
is known.
