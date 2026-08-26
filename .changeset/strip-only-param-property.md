---
"phoebe-agent": patch
---

Replaces the constructor parameter property in `ConfigRefusal` with an explicit field so `phoebe migrate` loads under Node's strip-only type stripping. Parameter properties are the one TypeScript construct in the codebase strip-only mode rejects, and `config-handle.ts` sits on the migrate import path — so every `phoebe upgrade` failed its migration gate with "TypeScript parameter property is not supported in strip-only mode" and refused to flip `engine.ref`.
