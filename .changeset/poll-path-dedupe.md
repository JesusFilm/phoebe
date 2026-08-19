---
"phoebe-agent": patch
---

Fewer GitHub calls per poll cycle (#200). The open-PR list is fetched once per
cycle and shared by the `conflicts`, `checks`, and `reviews` kinds, and each
PR's merge-info is fetched once (with the existing `UNKNOWN`-mergeability retry)
instead of once per kind. Behaviour is unchanged; a fleet's per-tenant API
budget stretches further, which matters most under App-installation rate
limits.
