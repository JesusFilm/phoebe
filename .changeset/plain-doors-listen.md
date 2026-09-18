---
"phoebe-agent": minor
---

`phoebe relay serve` starts the relay, the self-hosted process an operator signs
into with Google. Nothing dials it yet; this is the door.

Sign-in is OpenID Connect's authorization-code flow through `openid-client`, with
`state`, a `nonce` and PKCE, scope `openid email`, and a required
`email_verified`. People are keyed on Google's `sub`. The session lives in memory
behind a `__Host-` cookie. `allowlist.json` on the relay volume decides who gets
in: the first verified sign-in seeds it when it is empty, and `ALLOWED_EMAILS`
merges in at every start so a production relay is never unclaimed.

Four environment variables configure it, `RELAY_HOST`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and `ALLOWED_EMAILS`, and a missing one stops the start
with an error naming it. Route paths live in `phoebe-agent/contracts` as
`RELAY_ROUTES`. See `docs/relay.md`.

The relay is a separate image with its own volume. The deployment container
gains no listener, and a test holds that line.

`phoebe-agent` gains its first runtime dependency, `openid-client`. The
bootstrapper's materialization step now links runtime dependencies into the copy
it runs from, which has no `node_modules` of its own.
