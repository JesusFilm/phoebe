---
"phoebe-agent": patch
---

The post-stamp push after `appendTrailerToCommits` now uses `--force-with-lease`. The rebase that stamps co-author trailers rewrites every SHA, so the plain push that followed was always rejected as non-fast-forward — the co-author credit was silently lost. The lease still surfaces any concurrent writer rather than silently overwriting them.
