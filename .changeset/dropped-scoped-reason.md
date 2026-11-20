---
"phoebe-agent": patch
---

A dropped bump is now read correctly when its reason quotes a scoped package, as in ``- `tar@7.5.4`: `@scope/parent` pins it``. Before, the entry was misread, so the bump was neither filed on its own nor counted as a failure.
