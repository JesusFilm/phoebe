---
"phoebe-agent": minor
---

A unit whose pipeline process died before it settled now shows up in the unit history. When the next process boots and drops that unit from `status.json`, it appends an `abandoned` record to `units.jsonl` with the unit's provider, model and effort, `settledAt: null`, `durationMs: null` and no agent runs. To make that possible, each unit in `status.json`'s `currentUnits` now carries `provider`, `model` and `effort` from the moment it starts. A snapshot written by an older engine reads them as `null`.
