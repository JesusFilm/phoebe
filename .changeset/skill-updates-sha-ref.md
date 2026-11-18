---
"phoebe-agent": patch
---

`skill-updates`: a lock entry whose `ref` is a commit SHA no longer fails its scan. The kind read that SHA as a branch name and tried to clone a branch that does not exist. It now treats the SHA as the pin, follows the default branch, and moves the `ref` along with `commit` when it syncs.
