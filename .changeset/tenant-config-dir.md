---
"phoebe-agent": minor
---

Add a bootstrapper-only `configDir` field (#98) so a fleet tenant can point at a
single asset directory instead of duplicating `.env`/`prompts/` at the repo
root. `configDir: ".phoebe"` makes the supervisor read the tenant's `.env` from
`<dir>/.phoebe/.env` and run its engine child with cwd `<dir>/.phoebe/` (so
relative `promptFiles` resolve there), while `phoebe.config.ts` stays at the
tenant root for discovery. Honored for workspace children and nested `repos/`
tenants; malformed values are held like a bad `repoSlug`. Default `"."` keeps
the co-located path byte-for-byte unchanged. Like `engine`/`workspace` it is
validated then dropped by `resolveConfig` — the engine never reads it.
