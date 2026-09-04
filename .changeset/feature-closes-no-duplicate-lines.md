---
"phoebe-agent": patch
---

The feature-closes sweep now treats a `Closes #N` line anywhere in the integration PR body as already said, not just one between the `phoebe:closes` markers, and reads a line a hand edit left trailing blanks on. Integration PR #430 carried three lines below the block — for stacked members #418, #422 and #423, whose PRs merged into the blocker branch `phoebe/issue-415` rather than the feature branch, so the sweep never saw them. Phoebe's own lines have always landed inside the markers and now have a test saying so; what could go wrong was the sweep later attributing one of those members and writing a second line for an issue the body already closed. `docs/feature-branches.md` notes both the stacked-member blind spot and the new rule.
