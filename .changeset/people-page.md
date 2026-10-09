---
"phoebe-agent": minor
---

The console gains a **People** page: who may sign into this relay, and where a
new deployment's pairing token comes from.

Add someone by email — the only thing a human knows — and their first Google
sign-in fills in the `sub` the relay matches on thereafter. Remove anyone but
yourself, and their open sessions end with the entry, so a console sitting in
front of them goes dead at its next request instead of at their next reload.
Addresses that came from `ALLOWED_EMAILS` are shown as "from environment" and
cannot be removed here: they are recomputed at every start and never written to
the volume, which is what keeps editing that variable a real way out of a
lockout.

There are no roles. Everyone on the list can read every deployment, mint a
pairing token, and edit the list, so the page is a list of addresses rather than
a permissions matrix. The two rows without a Remove beside them say why they
have none.

Minting lives on the same page, because adding a person and pairing a deployment
are the same act. The token is shown once, with the two settings it is useless
without: `relay.url` in the root `phoebe.config.ts`, spelled out with this
relay's own address, and `PHOEBE_RELAY_TOKEN` in the root `.env`.

The relay grew `GET`/`POST /api/people` and `POST /api/people/remove` behind the
session, and `POST /api/pairing-tokens` now answers with the deployment URL
beside the token. The console's pages are hash routes — `#/fleet` and
`#/people` — so nothing new reaches the relay and it keeps being able to say a
path does not exist.
