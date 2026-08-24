---
"phoebe-agent": patch
---

Issue bodies survive every work order. A cycle gathers issue bodies per work
kind and merges them into one map, which the stack selectors then read to tell a
real conflict or a real CI failure from an expected divergence. The `conflicts`
kind assigned that map where `checks` and `reviews` merged into it, so any
`workOrder` fetching conflicts second discarded every body gathered before it.

A body the selectors cannot find reads as "not stacked", so the effect was a
pull request stacked on an open blocker being worked instead of left alone —
its divergence from the base branch treated as something to fix. The shipped
default order hides this, because conflicts fetches first into a map that is
empty anyway; only a reordered `workOrder` reaches it.

Every kind that gathers issue bodies now merges, and the map is a `const` so
assigning over it is a compile error rather than a silent loss.
