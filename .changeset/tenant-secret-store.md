---
"phoebe-agent": minor
---

A tenant's secrets can now be set without editing a `.env`. `phoebe secret set
<KEY>` reads the value from stdin and writes it to that tenant's **secret
store**, `<data>/<owner>/<repo>/state/secrets.json` at mode `0600`, with `phoebe
secret ls` for presence and `phoebe secret clear` to hand the key back to the
file. The value is never an argument, never logged, and never printed back.
`ls`, `phoebe config` and the deployment report all report presence and
provenance, nothing else.

The store is the tier above the tenant's `.env`, and neither reader lets a
collision pass quietly. `phoebe config`'s `env` section flags the key
`shadowed`, and `phoebe doctor` gains a per-tenant `secret-store` check that
warns and names it. Clearing an entry drops it, so the `.env` or ambient value
governs again. There is no tombstone, because revoking a secret means rotating
it.

What may be set is derived from the tenant's own config: every `requiredEnv` key
its scheduled work kinds declare, plus `GH_TOKEN`, plus the names in
`providerEnv`. Write a custom kind and its key is settable the same day. The
GitHub App credentials are refused at every scope, so the store stays tenant
scope only and the masked deployment env-file keeps the guarantee it had.

Delivery reuses the two paths that already existed. The credential lease re-reads
the store on every request, so a `GH_TOKEN` rotation lands in a running child in
place. Every other key counts toward the reconcile digest, so setting one
relaunches the children that would hold it, in solo too, where the store is the
only channel a secret has. A successful set then runs `phoebe doctor`, which is
what says the key is where the child will look for it. `--no-doctor` skips that.

`docs/trust.md` records the cost. The store holds plaintext at rest in the same
place, with the same readers, as the tenant `.env` it sits above. It joins the
accepted residual rather than widening it.
