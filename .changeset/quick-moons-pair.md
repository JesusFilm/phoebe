---
"phoebe-agent": minor
---

A deployment pairs with a relay and holds the connection open.

The operator mints a pairing token on the relay (`POST /api/pairing-tokens`,
behind the session), sets `relay: { url, name? }` in the root `phoebe.config.ts`
and `PHOEBE_RELAY_TOKEN` in the root `.env`, and boots. The deployment dials out,
generates an Ed25519 **deployment key** at `state/relay-key`, presents it with
the token, and the relay records the public half as a **link** in `links.json`.
Every later connection signs a relay-issued challenge with that key and carries
no token; the token is single-use, held in the relay's memory, and never written
to either volume. A key whose pairing the relay refuses comes straight back off
the volume, so a mistyped token leaves nothing behind.

The transport is a WebSocket over TLS: Node's built-in client on the deployment,
`ws` on the relay. `ws` is the relay's second dependency; the deployment
carries none. The relay speaks first with `phoebe:relay:challenge` and the
deployment answers `phoebe:relay:hello`; every type on the rail is
`phoebe:relay:`-prefixed and declared in `phoebe-agent/contracts`, with one
integer `protocol` and the rule that a relay speaks every protocol up to its own.
Refusals are close codes in WebSocket's private range (`unlinked`, `protocol`,
`bad-signature`, `token-spent`, `replaced`), and three of them stop the link
rather than retrying it.

`state/deployment.json` gains a bootstrapper-owned `relay` section (`configured`,
`state`, `nextRetryAt`, `lastClose`) and its identity gains `keyFingerprint` and
`relayUrl`. `phoebe doctor` gains a `relay` check reading `unpaired`, `paired`,
`token-stale` or `refused`, and it keeps warning while a spent token lingers in
`.env`.

The `relay` block is bootstrapper-only: the engine never sees it, `resolveConfig`
drops it, and no `PHOEBE_*` variable overlays it. A deployment with no `relay`
block dials nothing and behaves exactly as before.
