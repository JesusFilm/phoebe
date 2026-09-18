# The relay

`phoebe relay serve` runs the relay: one process, shipped in `phoebe-agent`,
that an operator signs into with Google and that deployments dial over a
WebSocket. A web console reads from it; that part is still being built. What
works today is the door and the fleet's side of it — you sign in, you mint a
pairing token, a deployment spends it, and the relay lists that deployment as
connected.

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
| `POST` | `/api/pairing-tokens`   | Mints one pairing token. Shown once; 401 otherwise.     |

A successful sign-in lands on `/api/me` today, because who you are is the only
thing the relay can show you yet. The console's own page takes that over.

## Pairing a deployment

A deployment joins by dialling out and proving who it is. Nothing dials in, and
no long-lived bearer token exists anywhere. The credential an operator handles is
spendable once; the identity that outlives it is a key the deployment generated
itself and has never sent.

From the operator's side it is three steps.

1. Mint a token on the relay: `POST /api/pairing-tokens` while signed in. It is
   good for fifteen minutes and shown once, and the relay keeps it in memory, so
   a restart voids it.
2. Put the relay's address in the root `phoebe.config.ts` and the token in the
   root `.env`:

   ```ts
   // phoebe.config.ts
   export default defineConfig({
     // ...
     relay: { url: "wss://relay.example.com/deployments", name: "the-fleet" },
   });
   ```

   ```sh
   # .env. Compose carries this into the container the way GH_TOKEN travels.
   PHOEBE_RELAY_TOKEN=<the token>
   ```

3. Boot. The deployment dials, generates an Ed25519 **deployment key**, presents
   it with the token, and the relay records the public half as a **link** in
   `links.json`. Then remove `PHOEBE_RELAY_TOKEN` from `.env`: it is spent, and
   `phoebe doctor` reports `relay: token-stale` until it is gone.

The key lands at `state/relay-key` on the data volume, mode `0600`. It is
written as it is presented, so a container killed a second later comes back with
the key the relay just recorded. If the relay refuses the pairing, the key comes
straight back off the volume. A mistyped token therefore leaves nothing behind:
fix the `.env` and boot again. Every later connection signs a challenge with that
key and carries no token at all.

`relay.name` is what a console displays. Omit it and the deployment answers to
its solo `repoSlug`, or to the workspace root's directory name. The relay keys
on the public key and never on the name, so two deployments may share one.

The `relay` block is bootstrapper-only and root-only: the engine never sees it,
`resolveConfig` drops it, no `PHOEBE_*` variable overlays it, and a deployment
with no block never dials and behaves exactly as it did before the block
existed.

### The handshake

The relay speaks first. On every connection it sends a challenge; the deployment
answers once, and a refusal comes back as a close code rather than a message.
Nothing rides on the upgrade request itself, which keeps the token out of every
proxy log between the two.

| Direction          | Type                     | Payload                                                   |
| ------------------ | ------------------------ | --------------------------------------------------------- |
| relay → deployment | `phoebe:relay:challenge` | `{ nonce, protocol }`                                     |
| deployment → relay | `phoebe:relay:hello`     | `{ protocol, publicKey, name, signature ⎮ pairingToken }` |

Every type on the rail is `phoebe:relay:`-prefixed and declared in
`phoebe-agent/contracts`, so neither end can invent a field the other does not
read. Anything that wants an answer carries an `id` and is answered by a
`receipt` bearing the same one.

`protocol` is one integer and it is not the package version. A relay speaks
every protocol up to its own and refuses anything above it, so the rule is
**upgrade the relay first**.

### Refusals

The relay's close codes live in WebSocket's private range. What a deployment
does with each one is the point of having them:

| Code | Name            | What the deployment does                                     |
| ---- | --------------- | ------------------------------------------------------------ |
| 4001 | `unlinked`      | Stops. The relay forgot this deployment; a human has to act. |
| 4002 | `protocol`      | Retries slowly. Someone is about to upgrade the relay.       |
| 4003 | `bad-signature` | Stops. The key on the volume and the link disagree.          |
| 4004 | `token-spent`   | Stops. Unknown, expired, or already used. Mint another.      |
| 4005 | `replaced`      | Stops. A newer connection from the same key superseded it.   |

Anything else is the ordinary case: a dropped socket, a relay restart, a network
that came back. The link backs off with jitter and dials again. A relay that is
down for an hour is worth a knock once a minute, so the last rung of the ladder
repeats.

### What a deployment reports about its relay

`state/deployment.json` gains a `relay` section the bootstrapper owns:
`configured`, `state` (`connected`, `reconnecting`, `unpaired`), `nextRetryAt`
and `lastClose`. Its identity section gains `keyFingerprint` and `relayUrl`. A
deployment with no relay still carries the section, saying `configured: false`.
"This deployment dials nothing" is a fact a console states rather than infers.

`phoebe doctor` folds the same evidence into one `relay` check: `unpaired`,
`paired`, `token-stale`, or `refused`. Only `refused` fails, because only a
refusal is a state that will not change on its own.

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

The heartbeat and the dark threshold, `forget` on the relay and
`phoebe relay leave` on the host, reports pushed over the socket and stored on
the volume, the events stream, and the console's pages. All of it joins this
same process. See
[the relay's shape](https://github.com/JesusFilm/phoebe/issues/506).
