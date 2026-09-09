---
"phoebe-agent": patch
---

New config field `mergedLabel`, default `merged-to-feature`, names the label a **landed member** wears — a feature member whose own PR has merged into the feature branch and now waits on the integration PR (#449). It sits in the same family as `processingLabel`: plain, lowercase, overridable in the config file or through `PHOEBE_MERGED_LABEL`, and created by the engine the first time it needs it, so a repo that has never heard of the label needs no setup. `phoebe doctor`'s `labels` check lists it beside ready, processing and opt-out, and names the `gh label create` fix when it is missing.

The add-then-heal write that creates a missing label now lives in one place (`src/labels.ts`) and carries a description per label role, so the landed-member label is not created wearing "Phoebe is working this issue". Nothing applies the label yet — that is the sweep's job, in a later change.
