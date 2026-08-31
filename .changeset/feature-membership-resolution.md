---
"phoebe-agent": minor
---

Feature membership resolution for the feature-branch arm (#341): given an issue, the engine can now name the live feature it belongs to. The walk climbs GitHub's native sub-issue parent chain to the nearest ancestor wearing `featureLabel`, falling back per hop to a hand-authored `Part of #M` in the body (configurable as `partOfPattern`, env `PHOEBE_PART_OF_PATTERN`), and names the branch `<branchPrefix>feature-<M>`. A feature stops resolving once its integration PR is merged or closed, or its parent issue closes, so stragglers become ordinary tickets again and a late one never resurrects a merged branch. Reads are memoized per cycle — siblings share one walk — and a failed read leaves that issue unaffiliated rather than ending the cycle. Nothing routes on the answer yet; that is the base arm itself.
