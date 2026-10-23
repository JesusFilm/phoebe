# Remote access over Tailscale

**Who this is for:** anyone who wants to see a Phoebe deployment from another
machine. It covers what the deployment serves, how to pick between the two
Tailscale arms, how a device pairs, what a session is and how it ends, and what
`phoebe doctor` says when any of it is wrong. For the companion's own screens
see [`console.md`](console.md); for the fields see
[`configuration.md`](configuration.md#remote-access-remote).

Until this feature, the deployment container listened on nothing. The console
read a local install through `compose exec`, and a deployment anywhere else was
out of reach. This changes one policy, and only one: with a `remote` block in
the root config, the container listens, on loopback or on a Unix socket, behind
your Tailscale, and answers only a device that has paired with it. Nothing off
the tailnet reaches it. Nothing on the LAN reaches it. Funnel is never used.
With no `remote` block the container is byte for byte the container it was.

## What a remote deployment is

A **remote** is a deployment the companion reaches over the deployment API
instead of over `compose exec`. The deployment serves two things and nothing
else:

- An open **descriptor** at `/.well-known/phoebe/deployment`, so a device can
  tell what answers at a link before it spends a code.
- `/api`, every route behind a bearer token the device got by pairing.

There is no console served from the deployment, no sign-in page, and no cookie.
A browser that opens the deployment's URL gets one plain line saying what it is.
The companion is the client; a mobile companion is a later effort and will
speak the same API.

A **route** is one way of reaching a deployment. A folder on this machine is the
local route, read over `compose exec`. A paired record is the remote route, read
over the API. One deployment can have both, and the companion shows both.

## The two arms

Tailscale has to run somewhere, and the `remote` block says where.

| Arm       | Where Tailscale runs                                    | Pick it when                                                                                                     |
| --------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sidecar` | A `tailscale/tailscale` container beside the deployment | The host is a server with no Tailscale of its own, or you want the deployment to be its own node on the tailnet. |
| `host`    | The machine's own Tailscale                             | The host already runs Tailscale: a laptop, a desktop, a box you log into.                                        |

On the sidecar arm the deployment is a node of its own, named after the Compose
project (`phoebe` unless you set `TS_HOSTNAME` or `COMPOSE_PROJECT_NAME`), at
`https://<name>.<tailnet>.ts.net`. The listener is a Unix socket Serve proxies
to; no TCP port exists at all, because in Tailscale's userspace mode an
unserved tailnet port is forwarded to loopback and a loopback listener would
answer every device around Serve.

On the host arm the deployment is reached through the machine's own node, at
`https://<machine>.<tailnet>.ts.net`, with a port on the end when `httpsPort`
is not 443. The container publishes its listener on the host's loopback and
nowhere else, and `tailscale serve` on the host proxies to it. Two deployments
on one host take two `httpsPort`s.

## The `remote` block

```ts
remote: { tailscale: "sidecar" },
// or
remote: { tailscale: "host" },
remote: { tailscale: "host", port: 7463, httpsPort: 443 },
```

| Field       | Arm    | Default | Meaning                                                                                           |
| ----------- | ------ | ------- | ------------------------------------------------------------------------------------------------- |
| `tailscale` | both   | none    | Where Tailscale runs: `"sidecar"` or `"host"`.                                                    |
| `port`      | `host` | `7463`  | The loopback port the host publishes the container's listener on.                                 |
| `httpsPort` | `host` | `443`   | The tailnet-side port Serve listens on. Change it when 443 on this machine serves something else. |

Both port fields are refused on the sidecar arm, where
`container/tailscale/serve.json` is that arm's truth. Inside the container the
port is always 7463.

The block is root-only and boot-time. The engine never reads it, no `PHOEBE_*`
variable overlays it, a config edit from the console refuses it, and a change
takes effect at the next `phoebe stop` and `phoebe start`. The doctor `remote`
check says so while the running services do not match the file.

## Setting it up

`phoebe init` scaffolds three files beside `compose.yml`, all inert until the
block appears:

- `container/compose.tailscale-sidecar.yml`, the sidecar arm's overlay.
- `container/compose.tailscale-host.yml`, the host arm's overlay.
- `container/tailscale/serve.json`, what the sidecar's Serve proxies.

`compose.yml` itself is unchanged. An install scaffolded before this feature
re-runs `phoebe init`, which creates the three files and leaves everything
that exists alone.

### The sidecar arm

Three lines in `.env`, which `.env.example` carries commented out:

```sh
TS_AUTHKEY=tskey-client-xxxxx?ephemeral=false&preauthorized=true
TS_EXTRA_ARGS=--advertise-tags=tag:phoebe
# TS_HOSTNAME=            # the node's name; defaults to the Compose project name
```

The key is tagged and non-ephemeral. The simplest source is an OAuth client in
the Tailscale admin console with the `auth_keys` scope and `tag:phoebe` among
its tags; its secret goes in as shown, with the query string on the end, which
is what Tailscale's own examples do. The tag has to exist under `tagOwners` in
your tailnet policy:

```json
"tagOwners": { "tag:phoebe": ["autogroup:admin"] }
```

Tagging moves the node from a person's identity to the tag, which also turns
node-key expiry off, so the deployment does not fall off the tailnet in six
months. Then:

```sh
phoebe stop
phoebe start
```

`phoebe start` adds the sidecar overlay to the Compose argv. The sidecar joins
the tailnet, applies `serve.json` once the node has a certificate domain, and
the bootstrapper learns the node's name over the daemon's socket, which the two
containers share. `phoebe status` prints the URL on its remote line once it has
one. The first HTTPS request to the node orders its certificate through Let's
Encrypt, which takes tens of seconds; after that it is instant.

### The host arm

Nothing in `.env`. `phoebe start` adds the host overlay, which publishes the
container's listener on `127.0.0.1:<port>` and nowhere else (inside the
container it listens on all of its own interfaces, since Docker forwards a
published port to the container's address, not its loopback), waits up to
thirty seconds for the bootstrapper to start listening, and then reconciles
Serve:

1. Finds the `tailscale` CLI: on `PATH`, then the macOS App Store bundle at
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, then `tailscale.exe`
   through WSL interop.
2. Reads `tailscale status --json`. Anything but `Running` is refused with the
   state named; a logged-out node is reported as logged out, not as a MagicDNS
   problem.
3. Reads the deployment's own descriptor off the loopback port, so it knows
   which deployment it is about to serve.
4. Reads the existing Serve mappings. **A mapping on `httpsPort` that points
   anywhere other than this deployment's loopback port is refused and named.**
   `tailscale serve --bg` would silently replace it; on one of our machines it
   did, so `phoebe start` never does.
5. Probes `https://<machine>.<tailnet>.ts.net[:httpsPort]`. Nothing answering,
   or a 502, 503 or 504 (a stale mapping to a backend that is gone), means it
   runs `tailscale serve --bg --https=<httpsPort> http://127.0.0.1:<port>`. The
   deployment's own descriptor means the mapping is already right and is left
   alone. Anything else answering is refused and named.
6. Waits up to a minute for the first-request certificate, probing each second,
   then prints the URL.

The URL is handed into the container, where the bootstrapper's report carries
it from then on. `phoebe pair` runs the same reconcile before minting, so a
link never names a URL nobody can open.

Platform notes:

- **Linux with Docker Engine.** Works as described, nothing extra.
- **macOS with Docker Desktop.** Works on the App Store, standalone and
  open-source builds; Docker Desktop honours the `127.0.0.1` bind. The App
  Store build keeps its CLI inside the bundle, which the ladder above finds.
- **Windows with Docker Engine inside WSL2.** In the default NAT networking
  mode, WSL forwards the container's `127.0.0.1:7463` publish to Windows
  loopback and the Tailscale service reaches it through `tailscale serve`; no
  Tailscale client inside the distro is needed, and you should not run one
  alongside the Windows client. Confirmed on a Windows 11 machine with Docker
  Engine in an Arch distro. Mirrored networking mode is untested and not
  supported, since Microsoft documents a published-port failure under it.

Stderr from the `tailscale` CLI is classified (logged out, permission denied,
no handler, unknown) and never quoted, because it can carry an auth key.

## Pairing

A device pairs by spending a one-time **pairing code**. A code is twelve
characters of Crockford base32, shown as `XXXX-XXXX-XXXX`, spendable once,
for five minutes. At most eight can wait at a time.

### From a shell

```sh
phoebe pair              # a read-only session
phoebe pair --operate    # a session that may also change the deployment
```

prints the pairing link, the code on its own for typing, the scopes, and when
it stops being spendable:

```text
https://beast.tail4f2c.ts.net/pair#code=7QW2-9XK4-M3PR

  code    7QW2-9XK4-M3PR
  scopes  read
  spendable for 5 minutes, until 14:05
```

`--json` prints the same as one object. Nothing serves `/pair`; the path exists
so the companion can take the whole link in one paste, and so a future mobile
app can claim it. The fragment never reaches the deployment.

The verb runs as root inside the container, through
`docker compose exec -u root`, and refuses otherwise. That is the gate that
keeps a tenant agent from minting itself a session: the code's hash passes to
the bootstrapper through `/run/phoebe-mint`, a root-owned directory the image
carries on no volume, and uid 10001 cannot write there. The bootstrapper picks
the file up, acknowledges it, and the root process prints. The reasoning is
recorded in
[ADR 0002](adr/0002-pairing-codes-are-minted-root-only-through-a-file-drop.md).
Under a `deployment` block with custom lifecycle commands the host verb refuses
and prints the `docker exec -u root <container> phoebe pair` line to run by
hand.

### From the install tab

On a local install's install tab, a **Remote** step follows Run. With no
`remote` block it says what to add to `phoebe.config.ts`. With one, once the
install runs, it offers two buttons. **Pair this companion** mints with
`--operate` and spends the code itself; nobody sees it, and the deployment's
host appears on the rail. **Link for another device** mints a read-only code
and shows the link, the code in large type, a copy button for each, a QR of
the link, and when it stops being spendable. The run's lines say "code minted"
and never the code.

### In the companion

**+ add remote** at the foot of the rail opens one modal with one field, which
takes the pairing link or a bare address; a bare address shows a code field.
Plus a label for this device, which is what the deployment's devices list will
show. The companion reads the descriptor first, then spends the code, and says
where the row landed: a new host section, an existing one, or a second route
for a folder already on this machine.

What can go wrong, one line each: nothing answered (is the host on your
tailnet, and is Phoebe started with a `remote` block; or Tailscale is off on
this machine); something answers but is not a Phoebe deployment; the code was
not accepted (single use, five minutes, mint another); the deployment speaks a
newer protocol than this companion (update it).

**Pair again** on a blocked row opens the same modal with the address filled
in. The record keeps its label, its last report and what it has already
notified you about.

## Scopes and sessions

A **session** is one paired device's standing with one deployment: a bearer
token, a scope, an expiry. Scopes are fixed when the code is minted:

| Scope     | May                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `read`    | Read the report and the stream, see its own session, sign out.                                                    |
| `operate` | Everything `read` may, plus edit a config field, set or clear a secret, run doctor, and list and revoke sessions. |

A session lasts 30 days. The token exists once, in the pair response; the
deployment keeps its SHA-256 in `state/sessions.json` on the data volume, and
the companion keeps the token in the OS keyring. From three days before expiry
the row says so; after it, the row is blocked until you pair again.

### The devices list

Every session shows in the **Devices** panel on the deployment's overview, on
remote routes and on local installs that carry a `remote` block: label, device
and OS, who paired (the Tailscale login Serve supplied, when it did), scopes,
last seen, expiry. Each row has a revoke, which needs `operate`; your own row
has sign out instead. Expired rows stay listed until the next write, greyed,
and can still be revoked.

### Ending a session

| Who            | How                                                                     |
| -------------- | ----------------------------------------------------------------------- |
| The device     | **Sign out** in the companion. The row goes.                            |
| Another device | **Revoke** on the devices list, with `operate`.                         |
| A shell        | `phoebe sessions` lists; `phoebe sessions revoke <id>` or `--all` ends. |

A revoked device gets a 401 on its next request and its stream closes at that
moment. Revoking yourself through the list is refused; sign out is for that.

`phoebe sessions` runs as the container's unprivileged user, never root. A
revoke from a shell is carried out by the bootstrapper, through a request file
under `state/`, so the sessions file keeps one writer. That matters for the
next paragraph.

### The forgery limit

Everything in the container shares uid 10001, so a tenant agent that has
decided to misbehave can read `state/sessions.json`, and could append a row
whose token hash it chose. No key or signature mends that in this model;
anything the bootstrapper could check with, a child can read. What the
deployment does instead is make it visible. The bootstrapper keeps the last
bytes it wrote, and a file that differs on the next read sets `tampered` in the
report, fails the doctor `remote` check, and puts a red banner over the devices
list. Across a relaunch it cannot tell, and says nothing. Every row shows in the
list, so a forged one is on the page you look at.
[`trust.md`](trust.md#one-container--one-trust-domain) records it beside the
other model-A limits.

## The API, for another client

Everything is JSON. The descriptor is open; everything under `/api` takes
`Authorization: Bearer <token>`.

| Route                                | Scope     | Answers                                                                                |
| ------------------------------------ | --------- | -------------------------------------------------------------------------------------- |
| `GET /.well-known/phoebe/deployment` | open      | `{ deploymentId, name, protocol, version, arm }`                                       |
| `POST /api/pair`                     | open      | `{ token, expiresAt, scopes, deploymentId }`, or `400 { error: "code-rejected" }`      |
| `GET /api/report`                    | `read`    | `{ report, builtAt }`; `report` is null before the first write                         |
| `GET /api/events`                    | `read`    | Server-sent events: the latest report on connect, one per change, a comment every 25 s |
| `GET /api/session`                   | `read`    | This session: `{ id, label, scopes, issuedAt, expiresAt }`                             |
| `DELETE /api/session`                | `read`    | Sign out, idempotent, 204                                                              |
| `GET /api/sessions`                  | `operate` | `{ sessions, self }`                                                                   |
| `DELETE /api/sessions/:id`           | `operate` | 204; `409 { error: "revoke-self" }` for your own                                       |
| `POST /api/config-set`               | `operate` | `{ receipt }` for `{ id?, path, value, fingerprint }`; a refusal is still 200          |
| `POST /api/doctor-run`               | `operate` | `{ outcome: "started" \| "joined" \| "refused", detail? }`                             |
| `POST /api/secrets`                  | `operate` | `{ outcome, tenant, key, editId?, detail }` for `{ tenant, key, value \| null }`       |

The pair body is `{ code, client: { label, deviceType: "desktop" | "mobile", os } }`.
A missing, malformed, unknown, revoked or expired bearer is
`401 { error: "unauthenticated", reason: "expired" | "unknown" }` with
`WWW-Authenticate: Bearer`; the right token on the wrong scope is
`403 { error: "forbidden", needs: "operate" }`. Bodies are capped at 64 KiB.
Ten rejected pair attempts in a minute put every attempt on 429 for a minute.
Sixteen streams may be open at once; the seventeenth gets 503. No body carries
`by`; the deployment stamps it from the session, as the Tailscale login when
Serve supplied one and `device:<label>` otherwise.

`protocol` is the integer that moves only for a change an older client would
misread. A client that finds a newer one than it knows stops and says so.

## Reachability, as the companion reads it

The deployment never says whether it can be reached; the companion derives it
from its own stream:

| State          | Fact                                                       | The row                     |
| -------------- | ---------------------------------------------------------- | --------------------------- |
| `connected`    | The stream is open and something arrived in the last 60 s. | Looks like a local row.     |
| `disconnected` | The stream dropped or a request failed, under 60 s ago.    | The counts, and a spinner.  |
| `dark`         | Unheard for 60 s or more.                                  | `dark · 3 min`, error tone. |
| `blocked`      | A 401, or a descriptor that rules the pairing out.         | The reason, and pair again. |

Before every stream open the companion reads the descriptor, which is how it
tells the four endings apart: `expired` from the 401, `revoked` when the
stored id still answers, `replaced` when a different id does (a wiped data
volume, or another deployment on the name), `protocol` when the deployment is
newer than the companion. Blocked retries nothing until you act. Everything
else climbs a ladder of 3, 4, 8, 16 and 30 seconds with a little jitter, and
the network coming back, the machine waking, or the window gaining focus tries
at once. There is no polling: each attempt opens the stream, whose first event
is the latest report.

The dark alert waits five minutes, as it does for a local install, and its
detail reads "unreachable for 5 min". A deployment reachable two ways is two
rows, and counts twice on the badge while both routes can see it.

## The doctor `remote` check

One check, from whichever side you run it, with `detail` saying which:

| Vantage          | What it reads                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No block         | `unknown`: nothing listens, read locally.                                                                                                                                                                                                                         |
| In the container | The listener answers the descriptor; on the sidecar arm, LocalAPI answers on the shared socket, the node is `Running`, Serve proxies to the socket; `/run/phoebe-mint` exists and is root's; the sessions file is not tampered; the pair budget is not exhausted. |
| From the host    | The arm's overlay files exist; the running services and published ports match the arm (a sidecar left from the other arm, or a port the arm never publishes, is named); on the host arm the same Serve inspection `phoebe start` runs, reading only.              |

A block that will not parse fails rather than reading as "no block", so a typo
does not hide behind the behaviour it causes.

## A consumer on `deployment.startCommand`

A config with its own lifecycle commands owns its Compose argv, so add the
arm's overlay yourself:

```sh
docker compose -f container/compose.yml -f container/compose.tailscale-sidecar.yml up -d
# or, on the host arm, with the loopback port if you changed it
PHOEBE_REMOTE_PORT=7463 docker compose -f container/compose.yml -f container/compose.tailscale-host.yml up -d
```

and run `tailscale serve --bg --https=443 http://127.0.0.1:7463` on the host
arm by hand. `phoebe pair` and `phoebe sessions` refuse under such a block and
print the `docker exec` line to run instead.

## Not here

Funnel, and anything else that would expose the deployment off the tailnet. A
console served by the deployment. A mobile companion, which is the next
effort; it will scan the same QR and speak the same API. Operator verbs over
the API beyond the three above. Alerting with no client running.
