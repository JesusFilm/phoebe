---
"phoebe-agent": patch
---

`phoebe doctor` now checks `declared-env` for a workspace tenant whose root `phoebe.config.ts` is a pointer (`{ configDir: ".phoebe" }`). It reads the governing config the pointer names, the same file boot runs the tenant on. Before this the check always came back `unknown` for those tenants. When the check still can't be evaluated, the `unknown` line now carries the first line of the error that stopped it.
