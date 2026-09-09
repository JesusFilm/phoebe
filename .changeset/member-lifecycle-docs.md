---
"phoebe-agent": patch
---

Docs: the feature-member lifecycle now reads end to end (#489). `feature-branches.md` is the canonical home — it says where a landed member is visible (its label, the idle line's `3 landed on feature #400`, `phoebe doctor`, never `phoebe list`), and it names the **stray member**: an open member still wearing a Phoebe label under a feature that has ended, the four ways one arises, the `stray-members` check's two repair hints, and the fact that a lifecycle label on a closed issue is archaeology rather than a bug.

`operating.md` keeps the levers and points at that account: the `processingLabel` section now says each automatic re-arm counts as an unproductive run and `maxUnproductiveRuns` of them quarantines the issue, the unit-hang paragraph cross-references it, the `featureLabel` section says what a member wears between the two merges, and the cancel row of the quick reference ends in `phoebe doctor`. The unit-hang paragraph also stops naming the deprecated `PHOEBE_MAX_UNIT_TIMEOUTS`.
