---
"phoebe-agent": minor
---

Set a secret on a remote deployment from the console, without the relay ever
seeing the value (#550).

Every deployment now carries an X25519 **box key** beside its Ed25519 signing key
in the one `state/relay-key` file, with one lifecycle: minted together, saved
together, forgotten together. A key file written before box keys existed gains
one on the next boot and keeps its link, because the signing key — and so the
fingerprint the relay is keyed on — does not move. The `hello` carries both
public halves and its signature covers `nonce ‖ boxKey`, so the key a console
encrypts to is as attested as the key that identifies the deployment;
`links.json` and the deployment endpoint hand back both.

The console's **secrets tab** shows which keys each tenant reads, whether each
one is set, which tier the value came from, and who set it last. Never a value,
a last four, a hash or a length: the deployment's report carries none of those,
so there is nothing on the page to redact. Keys a console may not set — the
GitHub App credentials, anything no work kind declares — are listed with the
sentence `phoebe secret set` would refuse with, rather than hidden.

Setting one seals the value in the browser to that deployment's box key and posts
the envelope to `POST /api/secrets`. The relay forwards it unopened and adds one
field, `by`, from its own Google session — so a console cannot choose whose name
lands in the deployment's ledger. The deployment opens the envelope with the
private half that has never left its volume, applies exactly the checks
`phoebe secret set` applies, writes the value to the tenant secret store, and
records `{ id, key, at, by }`. A write triggers a doctor run and a fresh
inventory. The receipt ends at `written` or `refused`; a deployment whose socket
closed with the request in flight comes back `undelivered`, and the console shows
the `phoebe secret set` command to run on the host instead, value on stdin.

Clearing is the same request with no envelope: the entry goes and the tenant's
`.env` or the ambient value governs again, with no tombstone.

The deployment report grows a `secrets` section carrying that inventory, taken
when the tenant set moves and when an edit lands rather than on every poll.
`docs/relay.md` documents the whole trip, and `docs/trust.md` states the promise
and its limit: the relay never _holds_ a secret, which is not a defence against a
hostile relay.
