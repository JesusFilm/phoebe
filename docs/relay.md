# The relay

`phoebe relay serve` runs the relay: one process, shipped in `phoebe-agent`, that
an operator signs into with Google. Eventually deployments dial it over a
WebSocket and a web console reads from it. Today it is the door and nothing
more. You sign in, you land on the allowlist, and you read one authenticated
endpoint that tells you who you are.

The relay is a separate image, a separate compose file and a separate volume
from any deployment. A deployment that names no relay never dials one and runs
exactly as it does now, and the deployment container still has no inbound
listener. That is a property worth keeping, so a test guards it.

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

In a container the relay will listen on plain HTTP on port 8787 with a Caddy
sidecar in front of it terminating TLS, keyed on `RELAY_HOST`. Operators who
run their own proxy delete the sidecar and point theirs at the relay; the relay
never terminates TLS itself. That scaffold is not written yet, so for now you
run the command above.

## Not here yet

`phoebe relay init`, which scaffolds the relay's Dockerfile, compose file and
`.env.example`. The WebSocket endpoint deployments dial, pairing tokens, the
links file, stored deployment reports, the events stream, and the console's
pages. All of it joins this same process. See
[the relay's shape](https://github.com/JesusFilm/phoebe/issues/506).
