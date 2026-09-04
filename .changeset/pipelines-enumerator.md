---
"phoebe-agent": minor
---

The `pipelines` enumerator and the bootstrapper's capability probe (#417). `phoebe pipelines --config <tenant config>` prints one JSON object describing the rows a tenant declares: for each, its `name`, the hot `disabled` and `priority` knobs, `concurrency`, whether the row's kinds want the tenant's git clone (any kind declaring a `worktree` or `readonly` workspace), and an opaque per-row `fingerprint`. It is the seam the supervisor will spawn from, so the bootstrapper never learns to read the `pipelines` block itself — which would pin what a supervisor understands to the installed launcher version and force an npm release per knob.

The fingerprint is the row's own cold config, hashed, with `disabled` and `priority` stripped at every nesting level: both are hot, so a digest that moved with them would relaunch a row the supervisor meant to adjust in place. Changing a row's cadence moves that row's fingerprint and no other. Custom kind modules load during enumeration, so a factory kind that checks its own prompt files and throws fails the enumeration rather than surfacing a spawn later.

`phoebe boot` probes a materialized engine checkout once for whether it supports enumeration at all (`pipelines --probe`) and says so in its startup line. A checkout without the subcommand means every tenant runs one implicit `work` row and enumeration never runs — byte for byte today's behaviour, so an existing deployment migrates as a no-op. On a checkout that does support it, enumeration runs per tenant and only when that tenant's config stat fingerprint moves; a failure is a tenant-level fault, never a fleet one. Nothing spawns from the rows yet.
