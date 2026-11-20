---
"phoebe-agent": minor
---

`minSeverity` on `dependency-security` and `dependency-updates` now takes `{ prod, dev }` as well as one severity, and the default for development dependencies moves from `high` to `critical`. A high on a dev dependency is no longer filed as a security issue; on a direct dependency its fix goes out with the daily pass and skips the maturity wait. Set `minSeverity: "high"` to keep the old behaviour.
