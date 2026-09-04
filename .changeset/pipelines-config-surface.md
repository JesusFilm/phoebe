---
"phoebe-agent": minor
---

The `pipelines` block and `--pipeline` row selection (#415). A tenant config can now declare named rows of work, like `pipelines: { work: { order: ["checks"], concurrency: 2 }, intake: { pollIntervalMs: 15_000 } }`, each with six knobs: `order`, `kinds`, `concurrency` (1), `pollIntervalMs` (300000), `disabled` (false) and `priority` (0). Names reuse the custom-kind charset, so `#` is excluded. `work` is the reserved default row and exists whether or not a config declares it. The block is tenant-only; a workspace root carrying it is a config error. Unlike `engine`, `workspace` and `deployment`, it survives into the resolved config, because the row enumerator and the cross-row partition check both need to see every row at once.

`pipelines.work` is the new home of work-kind config. `order` replaces `workOrder`, `kinds` replaces `workKinds`, and a kind's prompt path moved onto its own tuning block as `kinds.<name>.promptFile`. The three top-level fields keep working as deprecated aliases, resolved as `pipelines.work.*` with one warning at load, but declaring both an alias and its replacement is an error rather than a merge. Tuning blocks also gained `runTimeoutMs`, resolved on the familiar ladder (`PHOEBE_<KIND>_RUN_TIMEOUT_MS`, then the block, then `PHOEBE_RUN_TIMEOUT_MS`, then the tenant field), and a row's declared `pollIntervalMs` now outranks `PHOEBE_POLL_INTERVAL_MS`.

`--pipeline <name>` selects the row on the engine child's argv. It defaults to `work` and resolves into the flat fields every existing module already reads, so no consumer was rewritten. An unknown name exits before any GitHub call. `--run-once` and `--dry-run` take the flag too.

One behaviour changed with the move: **`order` is priority, not membership.** Named kinds are polled first, in sequence, and every other kind the row owns follows in declaration order. Omitting a kind no longer disables it; `kinds.<name>.disabled: true` is now the only off-switch. A config whose `workOrder` already listed every kind, including the shipped default, behaves exactly as before. The work-order validator keeps rejecting an unknown name and stops rejecting an empty array.
