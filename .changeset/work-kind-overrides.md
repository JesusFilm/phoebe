---
"phoebe-agent": minor
---

New `workKinds` config field (#300): each work kind can carry its own `provider`, `model`, and `effort`, falling back to the repo-level defaults when unset, plus per-kind env variants of the runtime trio (`PHOEBE_<KIND>_AGENT` / `_MODEL` / `_EFFORT`). Each knob resolves independently — per-kind env → per-kind config → global env → repo defaults — and a provider-mismatch guard keeps a block's `model`/`effort` silent when the run's effective provider differs from the one the block speaks for. Unknown kind keys, provider values, and knob names are boot-time config errors.
