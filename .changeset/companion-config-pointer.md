---
"phoebe-agent": patch
---

The companion follows a pointer config. A workspace child whose root `phoebe.config.ts` only declares `configDir` now shows the config in that directory on its gear, takes its slug from it on the rail, and saves a field into it, where each used to read and write the pointer. "Run it on its own too" moves the tenant's config into `.phoebe/` and leaves a pointer at the root, so the folder ends up with one config for the workspace and the new deployment. It used to copy the top-level settings into a second file, which had no pipelines or kind tuning and drifted from the first edit. The move is refused, and the copy made instead, for a config that names files relative to itself, a config already in `.phoebe/`, a `configDir` naming another folder, or a workspace above on an older `phoebe-agent` than the companion.
