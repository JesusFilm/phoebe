# The console

Phoebe runs unattended, which is the point of it and also the problem. A
container that needs no babysitting gives you nothing to look at, and the two
questions an operator has are "is it alive" and "why did that unit fail". Until
now the honest answer was to shell into the host and read `phoebe status`.

The **console** is the answer for a deployment you cannot shell into. It is a web
page listing every deployment you have paired, what each one is doing right now,
and the settings each one resolved. A self-hosted **relay** serves it. Deployments
dial the relay from inside, so nothing listens on the deployment container and
nothing reaches into it.

Three pieces, and you can stop after any of them:

| Piece           | What it is                                                                           | You need it when                                   |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `phoebe status` | The deployment report, read on the host. No relay, no network, no sign-in.           | You have a shell on the machine.                   |
| The relay       | One more container. Serves the console over HTTPS behind Google sign-in.             | You do not, or there is more than one deployment.  |
| The companion   | A desktop app. The same console window, plus the local installs on your own machine. | You run Phoebe on your laptop, or you want alerts. |

A deployment that names no relay never dials one. It behaves exactly as it did
before any of this existed, and a test guards that.

This page is the map. The mechanism lives next door in
[`relay.md`](relay.md): routes, close codes, the handshake, the envelope. Config
fields are in [`configuration.md`](configuration.md). Labels, drafts and
watermarks are in [`operating.md`](operating.md). The words are in
[`CONTEXT.md`](../CONTEXT.md).

## Standing up a relay

The relay ships in `phoebe-agent`. There is nothing else to install.

```sh
RELAY_HOST=relay.example.com \
GOOGLE_CLIENT_ID=<client id> \
GOOGLE_CLIENT_SECRET=<client secret> \
ALLOWED_EMAILS=you@example.com \
  npx --yes phoebe-agent relay serve --data-dir ./relay-data
```

Four environment variables, all required, and an optional fifth
(`RELAY_ALERT_WEBHOOK`) for alerting. There is no `relay.config.ts` and there
will not be one. The port, the heartbeat, the dark threshold and the
pairing-token lifetime are constants in the code, because an operator who tunes
them is making the relay's timing disagree with the fleet's.

Two things to decide before you start it.

**The Google client.** One Google Cloud project, one "Web application" OAuth
client, `openid` and `email`. Both scopes are non-sensitive, so there is no
billing account, no verification and no review. The redirect URI is built from
`RELAY_HOST`.
[`relay.md` → Setting up the Google client](relay.md#setting-up-the-google-client)
has the click path.

**Who gets in.** `ALLOWED_EMAILS` is merged into the allowlist at every start and
cannot be removed from the People page. Leave it blank and the first verified
Google sign-in claims the relay, which is convenient on a laptop and wrong in
production. Set it.

The relay wants TLS in front of it. It listens on plain HTTP on 8787 and
terminates nothing itself, so put Caddy or your own proxy there, keyed on
`RELAY_HOST`. Persistence is one volume holding the allowlist, the links and one
stored report per deployment. Pairing tokens and sessions live in memory, so a
restart costs you a re-login and an unspent token.

The relay's version is the bootstrapper's version, and one changelog covers both.
Upgrade the relay before the things that talk to it. It serves every console
protocol up to its own, so a newer console is told to move the relay rather than
half-working against it.

## Pairing a deployment

Pairing is a one-time token, spent once, replaced by a key the deployment keeps.

1. Sign in to the console and mint a pairing token. It is shown once.
2. On the deployment, add the relay's address to the **root** config:

   ```ts
   relay: { url: "wss://relay.example.com/deployments", name: "the-fleet" }
   ```

3. Put the token in the root `.env` as `PHOEBE_RELAY_TOKEN`.
4. `docker compose --env-file ../.env up -d`. The `.env` is Compose's
   create-time input, so a reconcile will not pick it up. The container has to be
   recreated.

On its first boot the deployment generates an Ed25519 **deployment key** and an
X25519 **box key** at `state/relay-key` on its data volume, spends the token, and
the relay records the public halves as the **link**. Every connection after that
signs a challenge. The token is never stored, and doctor warns while it is still
sitting in your `.env`.

Two ways to undo it, one from each end. **Forget** is the console's. It deletes
the link, and the deployment stops dialling once the relay refuses it as
`unlinked`. **Leave** is the deployment's. `phoebe relay leave` deletes the key on
the host. Neither reaches across.

Wipe the data volume and you lose the key, so the deployment re-pairs as a new
record. The old link stays dark and flagged `replaced?` until somebody forgets
it. That flag is deliberate. A name arriving on a new key is either a volume
wipe or somebody else's deployment, and the relay will not guess which.

`relay` is bootstrapper-only and root-config only. The engine never reads it, no
`PHOEBE_*` variable overlays it, and a console cannot edit it. A console that
could move the address it is reached at could strand a deployment where nobody
can find it.

## What the console shows

The console is one React bundle in `apps/console`, built into the package and
served by `phoebe relay serve`. The companion loads the same bundle from disk. A
page an operator sees is never written twice.

A **rail** runs down the left with every deployment on it, always, whatever page
you are on, because "is everything alive" is the question this thing exists to
answer. Rows sort dark first, then anything with a wedged pipeline, a
crash-looping child or a failing doctor check, then by name. No health score and
no "needs attention": every line is a count of something you can go and look at.

Four connection words, four marks rather than four shades of one. Filled dot for
connected. Ring for disconnected, with the seconds the relay counted. Square for
dark, with its age. Dashed outline for unseen, with when it was paired.
Disconnected is a fact about a socket; dark is a verdict about a deployment, and
the console does not blur them.

The fleet page puts one card per deployment beside the rail, with one bar segment
per pipeline. Selecting a deployment opens its five tabs. The route is in the
hash, so a deployment is a URL you can send someone.

| Tab           | What it answers                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**  | Connection facts in their own panel, the engine ref and running SHA, reconcile state, slots, every pipeline's two lines, held tenants. |
| **Pipelines** | One row per pipeline: the process line, the state line, units in flight against their budgets, the wedged clause.                      |
| **Doctor**    | The last run's checks with the trigger that produced them and how long ago. A deployment that has never run one says so.               |
| **Secrets**   | Which keys each tenant reads, whether each is set, and where the value came from. Never a value.                                       |
| **Config**    | Every effective-config leaf, filterable, with the source that supplied it and a shadowed value under the one that beat it.             |

Two of the tabs write. The config tab sends one `{ path, value }` patch against
the fingerprint its page was drawn from, and the deployment answers `written` or
`refused`, a refusal always carrying the exact manual edit. The secrets tab seals
the value in your browser to the deployment's box key, so what the relay carries
is an envelope it cannot open.
[`relay.md`](relay.md#setting-one-config-field) has both routes.

Updates arrive on one event stream. The page reads the fleet once, subscribes,
and then only applies events. There is no polling loop and no refresh button. A
report whose schema the console does not know is not read at all. The card says
so and still shows the connection facts, which never came from the report.
Guessing would be worse than a blank cell.

Everything here is a rendering of `state/deployment.json`, which the deployment
wrote and the relay stored without opening. Derivation happens in the deployment,
once. `phoebe status` reads the same file on the host and reaches the same
verdicts, which is what stops the two from disagreeing about a wedged pipeline.

## Alerting

Nobody watches a tab. The relay sends one message when a deployment crosses into
or out of one of five conditions, and one when it crosses back:

`dark`, `wedged`, `crash-looping`, `doctor-fail`, `replaced`.

One message per edge. No digest, no daily summary, no list of past alerts and
nothing to acknowledge. An alert is a notification rather than a record. The
fleet row already says what is true now, and `alerts.json` on the relay's volume
holds only the last state actually sent per deployment and condition. That file is why a
relay restart never wakes you twice for something that was already true.

Darkness waits five minutes before it alerts, though the fleet page says "dark"
from sixty seconds. The gap is deliberate. Sixty seconds is when the relay stops
believing the socket; five minutes is long enough that the usual cause, somebody
restarting a container, is over before your phone buzzes.

A link nothing has ever connected on stays silent. That is setup in progress, not
an incident.

Two sinks, and you configure one of them. `RELAY_ALERT_WEBHOOK` takes a generic
incoming webhook URL; the body carries a readable `text` field so a chat product
renders something without an integration, and the structured fields beside it for
anything that knows what Phoebe is. Leaving the variable out means no webhook,
not no alerting. The relay still evaluates every edge, because the other sink is
an `alert` event on the console's own stream, which the companion turns into an
OS notification. A browser ignores it.

The edge rule is one pure function in `phoebe-agent/contracts`, shared rather
than reimplemented. The relay runs it over the fleet; the companion runs it over
a local install's report, where there is no relay and therefore no `dark` and no
`replaced`.

## The companion, and its two arms

The companion is the desktop app. Its window is the console bundle, so the remote
half is the page you already know. What it adds is everything a browser cannot
reach.

**The remote arm** is a client of the relay's API. Sign-in runs in your own
browser, because Google's Web client refuses embedded webviews and redirects only
to the relay; the relay hands back a one-time code over `phoebe://auth`, and main
exchanges it for a device token it keeps behind `safeStorage`. The renderer never
sees the token. On a machine with no keyring the companion refuses to persist the
session at all and says so, rather than writing a bearer token to disk in the
clear.

**The local arm** is the part with no relay in it. A **local install** is a
repository folder on this machine that the companion drives through Docker
Compose. You point it at a folder, and an **install** tab runs the host verbs in
place with their output streaming into the window: `init`, `start`, `stop`,
`upgrade --check`, `doctor`. The same five tabs sit beside it, fed by a local read
loop rather than a socket. Docker is checked, never installed.

The local arm still adds no listener to the deployment container. Main spawns
`docker compose` exactly as you would at a shell, and reads through
`compose exec`. Its three states are running, stopped and not initialised.
There is no dark here, because dark is a remote reader's guess about silence and
Compose answers directly.

One rail holds both, under "This machine" and "Relay". A group rather than a
mode, because a switch would hide half your fleet and the rail exists so nothing
is hidden. Pair a local install and it appears once, not twice.

Alerts become OS notifications, tagged by deployment and condition, so a clear
replaces the raise it is about instead of piling up beside it. The dock badge
counts deployments and installs in a raised condition. There is no tray icon and
no login item, on purpose. The badge is a number on an icon you went looking for,
which is a different thing from being interrupted.

Distribution is CI artifacts on the `phoebe-agent@x.y.z` GitHub Release, mac
arm64, Windows x64 and Linux x64. **Unsigned, this round.** `electron-updater`
checks once at launch and installs on quit, and the macOS updater is switched off
until there is a Developer ID to notarise with. Signed in, the companion follows
the relay. Its update feed is pinned to the relay's own version, so one relay and
its companions never drift apart. Self-building from source stays documented and
supported.

## What stays at a shell

The console is deliberately narrower than the CLI, and the line is not where you
might guess.

**Not editable from the console, by design.** The fleet declaration in
`workspace`, because adding or removing a tenant is a git edit. `engine.ref`,
because moving it runs the migrations for the new ref and that belongs with
`phoebe upgrade`. The `relay` block itself. The `deployment` block, whose
lifecycle commands run outside the container. `paths`, which is derived. Any leaf
a `PHOEBE_*` variable already sets, since writing the file would change nothing
you would see. Every one of these refuses with the exact edit to make by hand and
the `phoebe config set` line to make it with, read from the same table the
deployment refuses from. The console cannot offer an edit the deployment would
turn away.

**Tenant configs in workspace mode.** Child checkouts sit under the same
read-only mount as the root, so only the root config has a read-write pen. A
tenant's row names the checkout its config lives in and gives you the command.
Tenant _secrets_ are a different story and do go through the console, because
they land in a store on the data volume rather than in a file.

**Deployment-scope secrets.** The GitHub App key and the engine-clone token stay
in the env-file. The root `.env` is masked with `/dev/null` inside the container
on purpose, and the console does not get to undo that. Rotating one is an edit to
`.env` and a `compose up -d`, because `.env` is Compose's create-time input.

**Operator verbs.** Pause a pipeline, release a quarantined unit, abort a running
unit, trigger an upgrade or a migration remotely. None of these exist yet. The
console reads, and writes exactly two things.

**Anything after `undelivered`.** Nothing is queued. If the socket closed with a
request in flight, the console says `undelivered` and shows you the command that
does the same thing over a shell, with the value on stdin where a secret belongs.
Re-issuing is yours to decide, because a write that lands ten minutes later
without anyone watching is worse than one that did not land.

## Not here yet

The People page, where the allowlist is managed and each person's devices are
listed with a remove beside them. The reads and the revoke are implemented; the
page is not.

Running doctor from the console. The rail carries the message and the relay will
deliver it and wait for a receipt exactly as it does for a config edit, and
nothing sends one yet.

Pairing a local install from inside the companion, which today means minting the
token in the console and editing the config and `.env` by hand.

Unit history and cost, live engine output over the relay, muting one deployment's
alerts without forgetting it, and a mobile app. All recorded against
[the console map](https://github.com/JesusFilm/phoebe/issues/497).

## Trust, briefly

The relay is one more place your fleet's state lives, and worth a paragraph
before you stand one up.

It holds the last report from each deployment, which names your repositories,
your pipelines and your resolved settings. It does not hold secret values. A
console-set secret is sealed in the browser to the deployment's own key, and the
relay forwards an envelope it cannot open. That promise is about a relay
operator, a backup of its volume and a passive compromise of it. It is **not** a
defence against a hostile relay, which serves the browser the JavaScript that
does the sealing. Run your own.

A console-set secret rests in plaintext on the deployment's data volume, at mode
`0600`, joining the residual [`trust.md`](trust.md#one-container--one-trust-domain)
already describes. Sign-in is Google OIDC against an allowlist you seed and
extend, with no roles. Every deployment in one relay is one trust domain, the
same way every repository in one container is.
