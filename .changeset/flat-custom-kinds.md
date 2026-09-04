---
"phoebe-agent": minor
---

Custom work kinds flatten into their `kinds` block (#465). The reserved `custom` sub-block is retired: a `kinds` (or deprecated top-level `workKinds`) key naming a built-in is that kind's tuning block, and any other key declares a tenant-authored kind — the same three arms as before (inline definition, module path string, `{ module, options }` wrapper). Declaration and tuning now share one key, so the wrapper arm additionally carries the six tuning knobs (`provider`, `model`, `effort`, `promptFile`, `runTimeoutMs`, `disabled`); the string arm graduates to the wrapper when it needs tuning, and an inline definition's knobs live on the definition itself, as they always did.

This is a breaking config change with a migration: `phoebe migrate` gains m006 (`flatten-custom-kinds`), which byte-moves each `custom.<name>` entry up one level — under `workKinds` and under every `pipelines.<name>.kinds` — and drops the emptied block. A config that also tunes a custom kind through a sibling block is refused with the manual instruction, since folding those knobs into the wrapper is a value edit. m006 is ordered before m005 on purpose: m005's verify resolves the config with the current engine, which now rejects a leftover `custom` block outright with an error pointing at the flattening.

The typo net the reserved key used to provide survives: an object under an unknown kind name that is neither a `{ module }` wrapper nor an inline definition (no `fetch`/`select`/`run`) is rejected at validation, naming the legal kinds and the three declaration arms.
