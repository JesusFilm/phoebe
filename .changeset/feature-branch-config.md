---
"phoebe-agent": minor
---

Two config fields for the feature-branch arm (#341): `featureLabel` (default `phoebe:feature`, env `PHOEBE_FEATURE_LABEL`) is the opt-in label a parent issue wears to put its children on one branch, and `featureBranchCatchUp` (default `true`, env `PHOEBE_FEATURE_BRANCH_CATCH_UP`) governs whether the `conflicts` kind keeps a live feature branch current with the default branch. Both are additive with behaviour-preserving defaults, and the env overlay gains boolean support — validated as `true`/`false` so a typo cannot silently switch a janitor off.
