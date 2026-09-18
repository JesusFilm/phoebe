# The relay

`phoebe relay serve` runs the relay: one process, shipped in `phoebe-agent`, that
an operator signs into with Google. Eventually deployments dial it over a
WebSocket and a web console reads from it. Today it is the door and nothing
more. You sign in, you land on the allowlist, and you read one authenticated
endpoint that tells you who you are.

The relay is a separate image, a separate compose file and a separate volume
from any deployment, all three written by `phoebe relay init`. A deployment
that names no relay never dials one and runs exactly as it does now, and the
deployment container still has no inbound listener. That is a property worth
keeping, so a test guards it.

Its version is the bootstrapper's version, and one changelog covers both.

## Configuration is four environment variables

| Variable               | What it is                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `RELAY_HOST`           | The public hostname, `relay.example.com`. The Google redirect URI is built from it, and the TLS sidecar is keyed on it. |
| `GOOGLE_CLIENT_ID`     | The Google "Web application" OAuth client id.                                                                           |
| `GOOGLE_CLIENT_SECRET` | Its secret. Keep it out of the image and out of git.                                                                    |
| `ALLOWED_EMAILS`       | Comma-separated addresses merged into the allowlist at every start.                                                     |

All four must be set. `phoebe relay serve` refuses to start otherwise, and the
error names every variable it did not get rather than making you find them one
restart at a time. The first three must also be non-blank, because a blank
hostname or a blank secret is no better than an absent one.

`ALLOWED_EMAILS` is the exception, and the difference matters. Blank is an
answer: nobody is seeded, and the first verified Google sign-in claims the
relay. Set it in production and that window never opens.

There is no `relay.config.ts`, and there will not be one. The port (8787), the
heartbeat interval, the dark threshold and the pairing-token lifetime are
constants in the code. An operator who tunes them is making the fleet's timing
disagree with the relay's.

Two flags exist for running the relay somewhere other than its container:
`--port` and `--data-dir`. Both default to what the scaffolded compose file
gives it.

## Setting up the Google client

One Google Cloud project, one OAuth client, no billing account and no
verification. `openid` and `email` are non-sensitive scopes, so none of the
verification machinery applies.

1. In the Google Auth Platform console, create a project and fill in Branding.
2. Choose the External user type. Keep it in Testing and add yourself as a test
   user. Testing caps you at 100 test users and expires refresh tokens after
   seven days, and neither touches the relay: it never asks for a refresh token,
   and sign-in scopes are exempt from the expiry anyway.
3. Create a client, application type Web application.
4. Add one authorized redirect URI: `https://<RELAY_HOST>/auth/google/callback`.
   Google requires HTTPS here. Localhost is the one exemption, so for local work
   add `http://localhost:8787/auth/google/callback` as a second URI.

Copy the client id and secret into the relay's environment. Press **Publish app**
later if the allowlist outgrows 100 people; these scopes still need no
verification.

## Standing it up

`phoebe relay init` writes the relay's container files into `relay/`, beside
wherever you run it. Three files, all yours to commit and edit:

| File           | What it is                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`   | The relay image: the deployment image minus git, `gh` and every agent CLI. `ARG PHOEBE_AGENT_VERSION` pins the version of the CLI that scaffolded it. |
| `compose.yml`  | Two services, `relay` and a Caddy sidecar, and one named volume.                                                                                      |
| `.env.example` | The four variables. Copy it to `.env`, which the scaffold gitignores.                                                                                 |

Then, in this order:

1. `cp .env.example .env` and fill in all four variables. `ALLOWED_EMAILS` may
   be empty, but read what that means above before you leave it that way.
2. Create the Google client as the section above describes. Its one authorized
   redirect URI is `https://<RELAY_HOST>/auth/google/callback`.
3. Point `RELAY_HOST` at this host in DNS and let ports 80 and 443 reach it.
   Caddy answers the certificate challenge on 80, so a name that does not
   resolve yet means no certificate.
4. `docker compose up -d --build`, then `docker compose logs -f` until Caddy
   says it has a certificate and the relay says which port it is on.
5. Open `https://<RELAY_HOST>/auth/google/start` and sign in.

### The sidecar

The relay listens on plain HTTP on 8787 and nothing publishes that port. Caddy
is the only front door: `caddy reverse-proxy --from $RELAY_HOST --to relay:8787`
is its whole configuration, and it gets the certificate for that name itself.
There is no Caddyfile to keep in step with `.env`.

Already running a proxy? Delete the `caddy` service, publish the relay's 8787
however you normally do, and point yours at it. The relay never terminates TLS,
so nothing else changes.

### One volume

`relay-data`, mounted at `/data` in both containers. The relay writes
`/data/relay`; Caddy writes `/data/caddy`, which is where the official image
keeps certificates. One volume is one thing to back up, and persisting Caddy's
half is what makes a restart reuse the certificate it has rather than ask Let's
Encrypt for another one and walk into the weekly duplicate limit.

Caddy starts after the relay, and that ordering is load-bearing. Docker seeds a
fresh named volume from the image of whichever container mounts it first,
ownership included. The relay image carries a `phoebe`-owned `/data` and the
Caddy image carries no `/data` at all, so the relay has to be the one to seed
it — the other way round leaves `/data` root-owned and the unprivileged relay
unable to write.

### Re-running init, and upgrading

`phoebe relay init` never overwrites a file that is already there. It reports
what it created and what it skipped, and says in as many words that the skipped
ones were left alone. Run it again whenever you like; to regenerate a file you
have edited, delete that file first.

Upgrading is an edit to `ARG PHOEBE_AGENT_VERSION` and a
`docker compose up -d --build`. Upgrade the relay before the deployments that
dial it: a relay speaks every protocol version up to its own, and one older than
a deployment refuses the connection.

## What the relay does with a sign-in

The flow is OpenID Connect's authorization-code flow, run by
[`openid-client`](https://github.com/panva/openid-client). `GET /auth/google/start`
mints a `state`, a `nonce` and a PKCE verifier, parks them behind a short-lived
`__Host-` cookie, and redirects to Google with the verifier's SHA-256 hash.
Google redirects back to `/auth/google/callback`, the relay exchanges the code
for an ID token over TLS straight from the token endpoint, and `openid-client`
checks `state`, `nonce`, the PKCE verifier, and the token's `iss`, `aud`, `exp`
and `iat`.

Then the relay applies its own two rules. `email_verified` must be true, because
Google's word for false is that it took no steps to confirm the address. And the
address must reach the allowlist. A refusal on either is a 403 with a sentence
saying which.

What survives is a session in memory behind a second `__Host-` cookie, marked
`Secure`, `HttpOnly` and `SameSite=Lax`. Lax rather than Strict is deliberate:
Google's callback is a cross-site top-level navigation, and Strict would
withhold the pre-auth cookie on exactly that request and fail every sign-in.

Nothing of Google's is kept. No refresh token is requested, the userinfo
endpoint is never called, and the ID token is read once and dropped. A relay
restart signs everyone out, which costs one redirect.

## The allowlist

`allowlist.json` on the relay volume, holding `{ sub, email, addedBy, addedAt }`
per person. People are keyed on Google's `sub`, never on their address: Google
is explicit that `sub` is unique and never reused and that email is not an
identifier. An address can change hands.

You add people by email, because that is the only thing a human knows. Their
first sign-in fills in the `sub` beside it, and every later sign-in matches on
the `sub`.

When the list is empty, the first verified sign-in seeds it and gets in. That is
the unclaimed-relay case, and it is the reason `ALLOWED_EMAILS` exists: between
deploying the relay and signing into it, whoever reaches the URL first owns it.
Filling that variable closes the window, and keeping the Google project in
Testing with only your account listed closes it again from the other side. Do
both.

Entries from `ALLOWED_EMAILS` are never written to the file. They are recomputed
at every start, which is what makes editing the variable and restarting a real
way out of a lockout.

## Routes

Paths live in `phoebe-agent/contracts` as `RELAY_ROUTES`, so the console imports
them instead of copying strings.

| Method | Path                    | What happens                                            |
| ------ | ----------------------- | ------------------------------------------------------- |
| `GET`  | `/auth/google/start`    | Redirects to Google.                                    |
| `GET`  | `/auth/google/callback` | Google's redirect back. The only URI Google knows.      |
| `POST` | `/auth/sign-out`        | Drops the session. 204.                                 |
| `GET`  | `/api/me`               | `{ sub, email }` for a signed-in caller, 401 otherwise. |

A successful sign-in lands on `/api/me` today, because who you are is the only
thing the relay can show you yet. The console's own page takes that over.

## Running it by hand

```sh
RELAY_HOST=localhost:8787 \
GOOGLE_CLIENT_ID=<client id> \
GOOGLE_CLIENT_SECRET=<client secret> \
ALLOWED_EMAILS= \
  npx phoebe-agent relay serve --data-dir ./relay-data
```

That is the local-development shape: no container, no proxy, no certificate.
`localhost` is the one host Google exempts from its HTTPS rule for redirect
URIs, which is what makes it work at all. Anywhere else, run the scaffold.

## Not here yet

The WebSocket endpoint deployments dial, pairing tokens, the links file, stored
deployment reports, the events stream, and the console's pages. All of it joins
this same process. See
[the relay's shape](https://github.com/JesusFilm/phoebe/issues/506).
