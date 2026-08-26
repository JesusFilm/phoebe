---
"phoebe-agent": patch
---

`phoebe upgrade` now runs the *target* checkout's migrations, not the current pin's. `upgradeEngineHalf` handed `runMigrations` the config's existing engine source verbatim, so the materialize step fetched the old ref and spawned *its* `phoebe migrate` — the upgrade gate was exercising the code being upgraded away from. Any deployment pinned to a ref whose migrate cannot load (v0.7.x–v0.8.0's parameter property under strip-only stripping) was stuck: every upgrade re-ran the broken old migrate and refused the flip, no matter how fixed the target release was.
