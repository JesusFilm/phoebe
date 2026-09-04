---
"phoebe-agent": minor
---

Supervisor pipelines: the `(tenant × pipeline)` matrix (#420). `phoebe boot` now supervises one engine child per pipeline rather than one per tenant. A pipeline is keyed `<tenant config dir>#<pipeline>`, and that id is also the concurrency broker's owner id and the credential lease's, so a pipeline reclaims its own slots and its own token when it dies. Each child is spawned with its own `--pipeline`. A tenant declaring `work` and `intake` therefore runs two children under distinct broker owners; a tenant declaring nothing runs one `work` pipeline, which is the one-child-per-tenant fleet unchanged.

Pipelines are re-read when a tenant's config or `.env` fingerprint moves, and the diff decides what happens: a new pipeline spawns, a vanished pipeline drains, and an existing pipeline relaunches only when its own cold config moved — so editing `intake.pollIntervalMs` touches nothing but the intake child. A fingerprint move that no pipeline accounts for is by elimination tenant-wide (a `gitIdentity`, a `repoSlug`, an edited `.env`) and relaunches every pipeline of that tenant. An engine upgrade drains the fleet, materializes once, and re-enumerates every tenant before respawning; the pre-upgrade pipeline list is never reused.

An enumeration that fails holds the tenant: nothing drains, the reason is warned once per poll, and the next poll tries again. At first boot a held tenant contributes no pipelines rather than a `work` pipeline against a config already known to be bad.

**The universality rule.** A pipeline's death alone is no longer fatal. The container comes down only when every supervised pipeline is crash-looping at once, and a fast crash counts toward the engine crash-loop guard only when every pipeline that ran that commit has fast-crashed on it — so one broken tenant cannot quarantine a commit the rest of the fleet is running happily. A solo deployment has one pipeline, so its exit status, its backoff and the guard's threshold are exactly what they were. Workspace deployments gain both halves: their runs now feed the crash-loop guard, and a wholly crash-looping fleet exits instead of respawning forever.

On an engine checkout with no `pipelines` subcommand every tenant still boots exactly one `work` pipeline, spawned without the `--pipeline` flag that engine would die on. Boot lines name a pipeline as `<slug>:<pipeline>`.
