---
"phoebe-agent": patch
---

Fix migrate post-apply validation falsely reverting workspace-root migrations.

`validateUserConfig` now skips the five tenant-field checks (`repoSlug`, `repoUrl`, `installCommand`, `checkCommand`, `testCommand`) when a `workspace` block is present. A workspace-root config carries that block instead of those fields by design, so demanding them was always wrong. The root preexisting-invalid probe is fixed as a consequence.
