---
"phoebe-agent": patch
---

Corrects the documented mechanism behind the `chmod 0711` node guard: the kernel makes an exec of an unreadable binary non-dumpable (`would_dump()` in `fs/exec.c`), not `AT_SECURE`, which stays `0` for a plain unprivileged exec. Verified against the shipped image — the same-uid environ read really is denied. `trust.md` now also states the residual the old text omitted: readable helpers (`git`, `gh`, shells) spawned with secrets in their environment run dumpable, so the guard narrows in-memory exposure to those helper windows rather than eliminating it.
