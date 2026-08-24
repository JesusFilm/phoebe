---
"phoebe-agent": patch
---

Replaces the `KINDS` registry object in `src/main.ts` with a `switch` on `picked.kind`, letting the compiler narrow each branch to the concrete payload type and eliminating five unchecked casts. No behaviour change.
