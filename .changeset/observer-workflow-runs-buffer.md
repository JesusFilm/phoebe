---
"phoebe-agent": patch
---

The observer no longer fails with `ENOBUFS` on a PR branch with more than about 58 GitHub Actions runs. The branch's runs are now trimmed to the four fields the observer reads (name, head SHA, conclusion, created time) before they leave `gh`, so a full page of 100 runs is about 13 KB instead of about 1.8 MB. Every captured `gh` read can also return up to 256 MiB now, up from Node's 1 MiB default, so full pages of search hits, comments and GraphQL results with long bodies fit as well.
