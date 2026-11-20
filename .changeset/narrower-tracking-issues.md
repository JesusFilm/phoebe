---
"phoebe-agent": minor
---

`dependency-security` no longer files a tracking issue for a transitive package whose advisories have no fix released, unless one of them is critical. Nobody could act on those. A direct dependency, a critical, and a package whose route is not known are tracked as before, and a transitive package is filed once its fix ships. Tracking issues already open for transitive highs are left as they are, so close them by hand.
