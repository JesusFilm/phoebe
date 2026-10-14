---
"phoebe-agent": patch
---

A pipeline no longer reads `wedged? unit past its budget` forever after its engine is killed mid-unit. A starting engine now drops the units and the slot wait its `status.json` inherited from the process before it, and logs each unit it drops.
