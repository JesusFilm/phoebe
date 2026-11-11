---
"phoebe-agent": patch
---

The engine copy that the bootstrapper materializes now includes `kinds/`. Without it, anything running from that copy could not load a catalog kind such as `phoebe-agent/kinds/sentry`, so doctor reported `declared-env` as `unknown` for every tenant that scheduled one. A copy already on disk for the same version that lacks a part the package ships is copied again on the next start, so it picks up `kinds/` without waiting for another release.
