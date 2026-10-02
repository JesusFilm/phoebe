---
"phoebe-agent": minor
---

`phoebe config set`: a field patch into the root config (#536).

- **One verb, one field, in place.** `phoebe config set <path> <value>` changes a single leaf of the root `phoebe.config.ts`. The path is the one `phoebe config` printed; the value reads as JSON when it is JSON and as a plain string otherwise. The file is parsed and one literal is replaced, so your comments, key order and formatting survive byte for byte.
- **The deployment directory stays `:ro`.** A new single-file mount in the scaffolded compose makes the root config, and only the root config, writable — over the same read-only directory mount everything else keeps. Writes land on the same inode, never through a rename, because a rename would break a file bind mount.
- **Validated before anything is written.** The bootstrapper spawns the _materialized_ checkout's `config set --validate`, so the patch is checked by the loader the deployment is actually running. A value the config rejects is a message and an untouched disk.
- **Refusals name what is somebody else's.** The fleet declaration, the engine pin, the `relay` and `deployment` blocks, a work kind's declaration, derived `paths`, a leaf a `PHOEBE_*` variable already sets, and a value in the file that is not a plain literal. Each refusal says which of those it is, and every one of them prints the exact edit to make by hand.
- **Optimistic concurrency, no merge.** An edit carries the `sha256:` the deployment report showed it; a file that moved in between is refused with both hashes rather than overwritten.
- **Idempotent by edit id.** Applied edits are recorded in `state/config-edits.json` on the data volume, so a redelivered id returns its original receipt instead of writing twice. The record rolls off whole the moment an operator edits or commits the file themselves.
- **A write reconciles at once.** The writer breaks the reconcile poll's wait, so the fleet drains onto the new config immediately instead of up to an interval later; the report's reconcile section gains `lastEditId`, tying a reconcile back to the edit that caused it.
- **In a workspace, only the root is editable.** Tenant configs live in their own checkouts and stay shell-side: a refusal names the checkout rather than reaching into it.
- `EditReceipt` and `ConfigEdit` are exported from `phoebe-agent/contracts`.
