# The relay

`phoebe relay serve` runs the relay: one process, shipped in `phoebe-agent`,
that an operator signs into with Google and that deployments dial over a
WebSocket. It also serves the **console**, the web pages an operator reads the
fleet on — built from `apps/console` and published inside the same package, so
there is no second thing to install. You sign in, you mint a pairing token, a deployment
spends it and then holds its connection open, pushing its whole **deployment
report** whenever anything in it moves. The relay keeps the latest report per
deployment, lists the fleet as connected, disconnected for so many seconds, dark
or unseen, answers one deployment with both halves of that picture, and streams
the changes as they happen. You can forget a deployment from the relay and a
deployment can leave from its own side. It also
alerts: when a deployment crosses into or out of a named condition, the relay
sends one message about it.

The relay is a separate image, a separate compose file and a separate volume
from any deployment, all three written by `phoebe relay init`. A deployment
that names no relay never dials one and runs exactly as it does now, and the
deployment container still has no inbound listener. That is a property worth
keeping, so a test guards it.

Its version is the bootstrapper's version, and one changelog covers both.

## Configuration is four environment variables, and an optional fifth

| Variable               | What it is                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `RELAY_HOST`           | The public hostname, `relay.example.com`. The Google redirect URI is built from it, and the TLS sidecar is keyed on it. |
| `GOOGLE_CLIENT_ID`     | The Google "Web application" OAuth client id.                                                                           |
| `GOOGLE_CLIENT_SECRET` | Its secret. Keep it out of the image and out of git.                                                                    |
| `ALLOWED_EMAILS`       | Comma-separated addresses merged into the allowlist at every start.                                                     |
| `RELAY_ALERT_WEBHOOK`  | Optional. Where one message per alert edge is POSTed. Unset means nothing is posted.                                    |

The first four must be set. `phoebe relay serve` refuses to start otherwise, and the
error names every variable it did not get rather than making you find them one
restart at a time. The first three must also be non-blank, because a blank
hostname or a blank secret is no better than an absent one.

`ALLOWED_EMAILS` is the exception among the four, and the difference matters.
Blank is an answer: nobody is seeded, and the first verified Google sign-in
claims the relay. Set it in production and that window never opens.

`RELAY_ALERT_WEBHOOK` is the one variable you may leave out entirely. Leaving it
out means no webhook — it does not mean no alerting. See below.

There is no `relay.config.ts`, and there will not be one. The port (8787), the
heartbeat interval, the dark threshold and the pairing-token lifetime are
constants in the code, and so is the five-minute wait before silence becomes an
alert. An operator who tunes them is making the fleet's timing disagree with the
relay's.

Two flags exist for running `phoebe relay serve` somewhere other than its
container: `--port` and `--data-dir`. Both default to what the scaffolded
compose file gives it. `phoebe relay leave`, which runs on a deployment host
rather than here, takes neither.

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

### The People page maintains it

The console's **People** page is where the list is kept: add by email, remove
anyone else, and mint a pairing token from the same page. There are no roles.
Everyone on the list can read every deployment, mint tokens, and edit this very
list, so the page carries no permissions column and never will.

Two rows have no Remove beside them, and neither is a privilege:

- **Yourself.** Nobody can put you back — there is no role above you and no
  console for someone who is not on the list — so removing yourself is a
  lockout with extra steps.
- **Anything from `ALLOWED_EMAILS`.** That entry is not in the file to delete
  and would return at the next start. The page says "from environment" and
  leaves it; the way out is the variable and a restart.

**Removing someone ends their sessions.** The relay closes every session that
person holds, so a console open in front of them goes dead at its next request
rather than at their next reload — and the answer says how many sessions ended,
because that is the half of a removal an operator cannot otherwise see. A relay
holds nothing else of theirs: no refresh token was ever requested, so a person
off the list has no way back in.

## Routes

Paths live in `phoebe-agent/contracts` as `RELAY_ROUTES`, so the console imports
them instead of copying strings.

| Method | Path                             | What happens                                                |
| ------ | -------------------------------- | ----------------------------------------------------------- |
| `GET`  | `/auth/google/start`             | Redirects to Google.                                        |
| `GET`  | `/auth/google/callback`          | Google's redirect back. The only URI Google knows.          |
| `POST` | `/auth/sign-out`                 | Drops the session. 204.                                     |
| `GET`  | `/api/me`                        | `{ sub, email }` for a signed-in caller, 401 otherwise.     |
| `POST` | `/api/pairing-tokens`            | Mints one pairing token. Shown once; 401 otherwise.         |
| `GET`  | `/api/deployments`               | Every link, where the relay holds it, and its last alert.   |
| `GET`  | `/api/deployments/<fingerprint>` | One link's row, plus the last report it pushed.             |
| `POST` | `/api/deployments/forget`        | Forgets one deployment, named by fingerprint in the body.   |
| `POST` | `/api/deployments/config-set`    | Sets one config field on one deployment.                    |
| `POST` | `/api/deployments/doctor-run`    | Runs doctor on one deployment, or on every one.             |
| `GET`  | `/api/events`                    | The event stream: reports and connection changes.           |
| `POST` | `/api/alerts/test`               | Sends one `{ kind: "test" }` body to every alert sink.      |
| `GET`  | `/api/people`                    | Everyone who may sign in.                                   |
| `POST` | `/api/people`                    | Adds one, by email in the body.                             |
| `POST` | `/api/people/remove`             | Removes one, by email in the body, and ends their sessions. |
| `GET`  | `/` and `/assets/…`              | The console's build. Public, and the only paths that are.   |

A successful sign-in lands on `/`, the console. The pages are public on purpose:
the sign-in control is part of the bundle, and every read behind it answers 401
on its own. A path with no file behind it is still a JSON `no-such-route` — the
console routes on the URL hash, so the relay needs no catch-all and keeps being
able to say a route does not exist.

The fingerprint rides in the forget and config-set bodies rather than in the path
so each route stays one constant a console imports. No fingerprint spells `forget`, and the
per-deployment read that shares the prefix is a `GET`. That read only matches a
real fingerprint — 32 characters of base64url — so a path segment that is not one
is a `no-such-route` and never reaches the volume the reports are named on.

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
that came back. The link backs off and dials again, and there is no last
attempt.

### Staying connected

Every twenty seconds the relay pings each connection and sends a visible
`heartbeat` beside the ping. Two mechanisms, because neither side can do the
other's job: the relay counts the pong Node's built-in client sends without
being asked, and the deployment counts the message, because that same client
cannot see a ping arrive.

A minute of silence — three missed beats — means something to both sides.

- The deployment redials. Nothing inbound for a minute is a socket that died
  with the network it rode, and no close frame is coming.
- The relay terminates that socket rather than reporting a half-open connection
  as connected, and calls the deployment **dark**.

The dark clock counts from the later of the last heartbeat and the relay's own
start, so restarting the relay does not paint a healthy fleet dark. Before the
minute is up the relay's word is **disconnected for N seconds**: a fact with a
duration, not a fourth state and not a prediction. The relay cannot know
whether a deployment is reconnecting; it knows how long it has been quiet. A
link the relay has never completed a handshake with is **unseen**, and a console
that showed that as dark would accuse an operator of losing a deployment they
have never booted.

The deployment's ladder is built to fit inside that minute. The first retry
lands uniformly in the first five seconds, and the ceiling doubles from there to
thirty seconds and stays. Every delay is jittered, so fifty deployments whose
relay restarted come back spread over the window instead of in one wave, and
the thirty-second ceiling sits under the dark threshold so a knock always beats
it. The delay comes from `src/backoff.ts` — the same retry rulebook the engine's
child-process calls use, in its async, never-terminal form.

### Requests in flight are refused, not queued

A request to a deployment — a config write, a secret, a doctor run — lives in
memory for as long as its socket does. When that socket closes, everything
still waiting comes back **undelivered**, and a deployment the relay is not
holding is refused the same word up front. Nothing is replayed on reconnect:
the operator re-issues, and the deployment-side ledgers make a re-issue
idempotent.

### Run doctor

A person presses **Run doctor** on a deployment, or once for the whole fleet. The
relay sends one `doctor-run` per deployment and collects the receipts; there is no
second message type and no fleet-wide verb on the wire.

A receipt comes back within the moment and says which run the press belongs to,
not what the run found:

- **started** — nothing was in flight, so this press is the run.
- **joined** — a run was already under way, or a reconcile had already parked one.
  Doctor is a read of the same world, so two presses spend one tenant's API
  budget, not two.
- **refused** — the deployment will not run one now, and says why. A container on
  its way down is the case this exists for.
- **undelivered** — the relay is not holding that deployment's connection. It is
  refused up front rather than queued, the same as every other request.

What doctor found arrives afterwards, as the next report: the deployment's own
model moves its doctor section and pushes it, and the console's open stream
carries it. That is why the console's button never sits spinning for five
minutes, and why a deployment that is dark shows its last-known report with an
age beside a disabled button.

The relay answers **none** of doctor's checks. Every one of them reads the
deployment's files, env, clone or credentials, or calls GitHub with them. What
the relay knows — connected since, last heard, the last close code — is the
connection panel beside doctor and is never a check.

### Forget, and leave

Two verbs end a pairing, one on each side, and neither needs the other.

**Forget** is the relay's. It deletes the link, then closes any live connection
with `unlinked`, in that order, so a redial racing the close finds no link to be
admitted by. The deployment stops dialling and says so through its report;
`phoebe doctor` reports `relay: refused`.

**Leave** is the deployment host's: `phoebe relay leave` deletes
`state/relay-key` from the data volume, which is the only thing that could prove
who this deployment is. It reads the volume from `PHOEBE_DATA_DIR` the way
`phoebe doctor` does, and it takes no flags. Two things it does not do, and it
says both: removing `relay.url` from the root config is what stops boot dialling
at all, and the relay still holds the link until someone forgets it there.

An operator locked out of their relay can still stop a deployment dialling it.
An operator whose deployment is gone can still clear it off the console. There
is no key rotation anywhere: re-keying is leave, forget, pair again.

A data-volume wipe is the same story with nobody deciding it. `docker compose
down -v` takes the key, the operator mints a new token, and the relay records a
**new link** because the key is the identity. The old record stays dark, marked
"replaced?" beside a newer one of the same name, and a person forgets it. A
dark record is evidence, not garbage, and the relay guesses rather than merging:
two deployments are allowed to share a name.

### What a deployment reports about its relay

`state/deployment.json` carries a `relay` section the bootstrapper owns:
`configured`, `state` (`connected`, `reconnecting`, `unpaired`), `nextRetryAt`
and `lastClose`. Its identity section gains `keyFingerprint` and `relayUrl`. A
deployment with no relay still carries the section, saying `configured: false`.
"This deployment dials nothing" is a fact a console states rather than infers.

`phoebe doctor` folds the same evidence into one `relay` check: `unpaired`,
`paired`, `token-stale`, or `refused`. Only `refused` fails, because only a
refusal is a state that will not change on its own.

## Reports

A connected deployment pushes its whole **deployment report** — the same
`state/deployment.json` `phoebe status` reads — and pushes it again whenever any
section of it moves. On connect it goes up entire, before anything asks for it.
There are no deltas: the report is a few kilobytes of current facts and a diff
would be a second model to keep in step with the first.

Nothing is pushed on a timer. A fleet sitting still writes no report, so it sends
none, and the liveness between reports is the pong to the relay's twenty-second
ping. Silence from a working deployment is a deployment with nothing to say.

The relay writes each report to `reports/<fingerprint>.json` on its volume,
through a temp file and a rename, and keeps the latest only. That file is why a
restarted relay shows last-known and **dark** rather than **unseen**: the link
and the report both survive the process that took them, and only the live
connection facts start again.

**The relay does not read the report.** It lifts the `schema` integer out of the
envelope so a console can branch on it, stores the body as it arrived, and hands
it back the same way. Deriving a pipeline's state is the deployment's job, done
once, in `src/pipeline-listing.ts` — so a console and a `phoebe status` cannot
disagree about what a pipeline is doing. A test reads the relay's own source and
fails if anything in it so much as names the deployment's model.

A push while the socket is down is dropped, not queued. The next connection opens
with the whole report anyway, and a queue would only deliver an older version of
the same truth.

## What a console reads

`GET /api/deployments` is the fleet: one row per link, each with where the relay
holds it. `GET /api/deployments/<fingerprint>` is one deployment, and it answers
two things side by side that are never merged:

- `deployment` — the relay's own facts. Connected since, disconnected for so many
  seconds, dark, unseen; how the last connection ended; whether a newer link has
  taken this one's name.
- `report` — what the deployment last said about itself, with the `schema` it
  carried and when the relay took delivery. Null for a link that has never
  reported.

Both are behind the session cookie and answer 401 without it.

### The event stream

`GET /api/events` is one server-sent-events stream, so pages update without
polling. Four event names, each with the payload a reader would otherwise have
fetched:

| Event          | Payload                                         |
| -------------- | ----------------------------------------------- |
| `report`       | `{ at, fingerprint, schema, report }`           |
| `connected`    | `{ at, deployment }` — the row, as it now reads |
| `disconnected` | `{ at, deployment }`                            |
| `dark`         | `{ at, deployment }`                            |

A connection event's name is the word the row now carries, and each is said once
per change rather than once per check. `unseen` is never an event: it is where
every link starts, so nothing ever becomes it.

There is no replay and no resume cursor. Every event has a read behind it that
answers the same question in full, so a page that missed one refetches
`/api/deployments` and is whole again. An idle stream writes a comment on the
heartbeat's cadence, which is what keeps a proxy from reaping it, and a session
that ends mid-stream ends the stream with it.

## Alerting

The console is not the pager. An operator who is not looking at a tab cannot
answer "is it alive", so the relay says something when a deployment crosses into
or out of one of five conditions:

| Condition       | Raised when                                         | Cleared when                       |
| --------------- | --------------------------------------------------- | ---------------------------------- |
| `dark`          | Five minutes with no heartbeat.                     | The next completed handshake.      |
| `wedged`        | A pipeline's wedged verdict turns true in a report. | It turns false in a later report.  |
| `crash-looping` | The bootstrapper's crash-looping flag turns true.   | It turns false.                    |
| `doctor-fail`   | The report's overall doctor verdict becomes `fail`. | A later report is not `fail`.      |
| `replaced`      | A newer link has taken a dark link's name.          | The old deployment turns up again. |

**Unseen is silent.** A link nothing has ever connected on is setup in progress,
not an incident.

**Darkness waits five minutes, not sixty seconds.** The fleet page says "dark"
from the 60 s mark, because that is when the relay stops believing the socket.
The alert waits out the next four minutes, so the most common cause of darkness
— someone restarting a container — is usually over before anything is sent.

**A dark deployment sends no other clears.** Its reports are stale, so
`wedged`, `crash-looping` and `doctor-fail` hold where they were until it
reconnects and reports. Then each is re-read against the fresh report.

An alert is a transition, not a record. There is no list, no acknowledge, no
mute and no history page: the fleet row already says what is true now, and
`alerts.json` on the volume holds only the last state actually sent per
(deployment, condition). Forgetting a deployment deletes its entries, and sends
no clear on the way out — forget is the mute for a dead key.

That file is why a restart never wakes you twice. On boot the relay re-evaluates
everything and compares against what it last sent, so a still-dark deployment
stays quiet and one that recovered overnight gets its clear.

### The message

One condition per message, no digest:

```json
{
  "schema": 1,
  "kind": "alert",
  "condition": "wedged",
  "state": "raised",
  "deployment": { "name": "acme-site", "keyFingerprint": "…" },
  "pipeline": "acme-site/sentry",
  "since": "2026-09-18T11:12:00Z",
  "detail": "no pass for 17 min",
  "text": "acme-site: pipeline sentry wedged (no pass for 17 min)",
  "url": "https://relay.example/#/d/…"
}
```

`pipeline` is present on `wedged` and `crash-looping` only. `text` is there so
a generic incoming webhook renders something readable with no integration
written; anything that knows what Phoebe is reads the fields beside it.

Delivery is one attempt with a five-second cap and no retry queue. A failure is
logged at warn naming the condition, and `alerts.json` is written after the
attempt rather than after the success — otherwise a webhook outage would come
back as a storm of everything it missed. A lost alert is visible in the relay's
log and in the fleet page's own state.

There is no signing. The URL is the secret, the way every incoming-webhook
product treats it, which is also why the relay never logs it.

### Leaving `RELAY_ALERT_WEBHOOK` out

Unset means **no webhook**, not no alerting. The relay still evaluates every
edge and still keeps `alerts.json`, because the webhook is one of two sinks: the
other is an `alert` event on the events stream, which the desktop companion
turns into an OS notification and the browser ignores. That sink is not
configurable, so evaluation cannot be.

`phoebe relay serve` logs one line at start saying which of the two you have.

The edge rule itself is a pure function in `phoebe-agent/contracts`
(`src/contracts/alerts.ts`), shared rather than reimplemented: the relay runs it
over the fleet, and the companion runs it over a local install's report, where
there is no relay and so no `dark` and no `replaced`.

## The console

The console is the operator's view of the fleet: a **rail** down the left listing
every deployment, and a **grid** beside it with one card per deployment and one
bar segment per pipeline. It is one React bundle in `apps/console`, built into
`console/` at the root of this package, which is how `phoebe relay serve` hands it
out of the single install. The same bundle is what the desktop companion will load
from disk.

The rail is always on screen, because "is everything alive" is the question the
console exists to answer. Rows are sorted dark first, then anything with a wedged
pipeline, a crash-looping child or a failing doctor check, then by name. There is
no health score and no "needs attention" word: every line is a count of something
an operator can go and look at.

The four connection words each get their own mark, not four shades of one — a
filled dot for connected, a ring for disconnected with the seconds the relay
counted, a square for dark with its age, a dashed outline for unseen with when it
was paired. `replaced?` rides beside the word rather than instead of it. Light and
dark themes follow the OS.

Updates arrive over `GET /api/events`. The page reads the fleet once, subscribes,
and then only applies events; there is no polling loop and no reload. Everything
it asks the relay for goes through one **relay client** seam — in a browser that is
the session cookie plus `EventSource`, and in the companion it will be the desktop
bridge with main holding the device token.

A report whose `schema` this console does not know is not read at all. The card
says so and still shows the relay's own connection facts, which never came from the
report.

Beside the fleet is **People**, reached from the tabs in the top bar and from
`#/people` — the pages are hash routes, so none of them reaches the relay and the
relay keeps being able to say a path does not exist. Minting a pairing token lives
on that page, because adding a person and pairing a deployment are the same act.
The token comes back once, and the panel says the two settings to make —
`relay.url` in the root `phoebe.config.ts`, spelled out with this relay's own
address, and `PHOEBE_RELAY_TOKEN` in the root `.env` — while the characters are
still on screen.

### One deployment

Selecting a deployment from the rail or the grid opens its tabs. The console
routes on the hash, so a deployment is a URL an operator can send someone:
`#/d/<fingerprint>` is the overview, and `/pipelines`, `/doctor` and `/config`
hang off it.

**Overview** leads with three panels. The **connection** panel is the relay's own
facts and nothing else — connected since, last heard, who paired it, how the last
socket closed. Doctor answers none of those and never will, so they stay in their
own panel rather than reading as checks about the deployment. Beside it, the
engine ref and the running SHA, whether the deployment is deliberately behind its
own config on a quarantined commit, what a reconcile is relaunching onto and why,
and the slot broker's numbers. Under the panels, every enumerated pipeline with
its two lines, the tenants discovery is holding and the errors holding them, and
any config edit that is in a file and not yet in a commit.

**Pipelines** is one row per pipeline: the process line (a child, since when,
restarts, crash-looping), the state line the report derived, the units in flight
against the budget each was given, and the wedged clause when there is one. A
tenant that fills no row — held before its config was ever readable, or declaring
no pipeline — is still a row, because it is exactly the tenant worth seeing.

**Doctor** is the last report the bootstrapper's run produced: the deployment's
checks, then each tenant's, with the trigger that produced them, how long ago,
whether a run is in flight right now, and the last attempt that produced nothing.
A deployment that has never run doctor says so; that is a fact about the
deployment, not a verdict about it.

The tab also carries **Run doctor**, and the fleet page carries one for every
deployment at once. A deployment the relay is not holding a connection for has
the button disabled with the reason on screen rather than a press that comes back
refused — the relay already said it is disconnected, dark or never booted, and
saying it twice in two vocabularies helps nobody. The fleet press is never
disabled: the deployments it cannot reach are part of the answer, each named with
the word that came back.

**Config** is every effective-config leaf in one filterable table: the value, and
which of the six sources supplied it. Filter by a path or a value — "what is
`model` set to" and "who set it to `opus`" are the two questions that bring an
operator here — and the chip beside the filter counts the leaves each source won,
so clicking `overlay` narrows the table to what env decides. The source chip is
on every row; the env name or file path behind it is in the row's disclosure,
because which source won is what an operator scans for and the name behind it is
what they read once they have found the row. A value that lost sits under the
value that beat it, so "why isn't my file value taking effect" is answered where
the question is asked. Deprecated aliases are listed above the table rather than
row by row, and the fingerprint of the config file heads the tab — that is the
text a later edit checks itself against.

The last column is the edit. A leaf `phoebe config set` accepts carries an
**Edit** button; every other leaf carries a sentence saying why not, with the
exact change to make by hand and the `phoebe config set` line to make it with.
The closed set is the deployment's own — the fleet declaration, the engine pin,
the relay block, the host's `deployment` block, `paths`, a work kind's
declaration, an opaque value, and any leaf a `PHOEBE_*` variable already sets —
read from the same table the deployment refuses from, so the console cannot start
offering an edit the deployment would turn away. In a workspace only the **root**
config is editable: a tenant's row says which checkout its config lives in and
gives the command for that file.

Saving sends `{ path, value }` with the fingerprint the page was drawn from, and
the answer is the deployment's receipt — `written` or `refused`, the refusal
always carrying the manual edit. After `written`, the panel follows the report:
the fleet drains onto the new config and comes back idle with `lastEditId` naming
the edit, and the leaf above turns `file` with the new value. Nothing is applied
except through the file.

The table is section 5 of the report, which the running engine computed. A
deployment whose engine is older than that section says so; its settings are
unknown from here, which is not the same as having none, and `phoebe config` on
the host still answers.

A deployment that has never connected says that instead of showing four empty
tabs — the pairing token was spent, nothing has booted since, and there is nothing
to show until it does.

### Setting one config field

`POST /api/deployments/config-set` with
`{ fingerprint, id, path, value, configFingerprint }`:

- `fingerprint` is the deployment; `id` is the edit's idempotency key, so the
  same id twice is one write and the second call gets the first receipt back.
- `path` is a dotted path into the config, the one the config tab printed.
- `value` is a literal. An object or a list is a `400`: a leaf holds one value,
  and rewriting a block is a file edit.
- `configFingerprint` is the `sha256:` the report's config section carried. A
  file that moved since is refused `stale` rather than merged.

The relay stamps the signed-in address as the edit's `by` — that is the one field
it authors, and a `by` in the body is ignored, so a browser cannot sign somebody
else's name to an edit. Then it carries the patch down the rail and hands the
receipt back without reading it.

The answer is `{ outcome, receipt? }`. `outcome` is the deployment's own word or
the relay's `undelivered`, and it is a `string` rather than a closed union
because a deployment newer than its relay is quoted, not translated. A deployment
the relay has no link for is a `404`; one it knows but cannot reach is a `200`
carrying `undelivered` — in flight is never a queue, and the operator re-issues.

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

One verb: sealed secrets. The rail carries it and the relay will deliver it the
way it delivers a config edit or a doctor run; nothing sends one yet. On the
console's side the fleet page, the People page, a deployment's four tabs, the
config edit and the doctor run are here; the secrets tab joins this same
process. See
[the relay's shape](https://github.com/JesusFilm/phoebe/issues/506).

Alerting is here but only partly fed. The webhook, the edge rule, `alerts.json`
and the test button all work; `dark` and `replaced` are evaluated against the
relay's own clocks on every sweep. `wedged`, `crash-looping` and `doctor-fail`
are implemented in the rule and have nothing to read until the relay stores
reports, and the `alert` event rides the same stream. Both wait on
[reports over the relay](https://github.com/JesusFilm/phoebe/issues/542).
