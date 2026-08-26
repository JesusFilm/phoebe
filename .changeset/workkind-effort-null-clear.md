---
"phoebe-agent": patch
---

`workKinds` blocks can now set `effort: null` to suppress the effort flag for that kind even when `defaultEfforts` names one for the active provider. Previously the only escape from a global effort default was to drop `defaultEfforts` entirely and repeat the setting in every other block — an impossible tradeoff when one kind runs a model that has no effort knob (e.g. `claude-haiku-4-5`). A per-kind env var (`PHOEBE_<KIND>_EFFORT`) still wins over the null clear.
