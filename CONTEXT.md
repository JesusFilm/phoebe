# Phoebe

The public engine for Phoebe, an AFK coding agent: it picks up labelled work in a
repository, does it in a container, and pushes the result as a pull request.

This file is the glossary. For how the pieces fit together see
[`docs/architecture.md`](docs/architecture.md); for the mechanics of each kind of work see
[`docs/work-kinds.md`](docs/work-kinds.md); for running more than one stream of work in a
tenant see [`docs/pipelines.md`](docs/pipelines.md).

## Language

### Deployment

**Deployment**:
One consumer-owned directory holding a config file, optional prompt overrides, and the
container files Phoebe runs from. Mounted read-only into the container.
_Avoid_: installation, instance

**Tenant**:
One repository Phoebe works, with its own config, credentials and state. A deployment has
one tenant or many.
_Avoid_: project, target, client

**Fleet**:
The pipelines a single deployment supervises — the whole (tenant × pipeline) matrix, not the
tenants alone.
_Avoid_: pool, cluster

**Pipeline**:
One named body of work a tenant runs, in its own engine process, with its own order, kind
tuning, cadence and concurrency. Every tenant has at least one; `work` is the reserved
default. A work kind belongs to exactly one pipeline.
_Avoid_: row, lane, cell, stream, queue, channel, worker (and never for the planning
pipeline a person runs before Phoebe — that sense is spelled out in full)

**Engine**:
The long-running process behind one pipeline: it selects work units up to that pipeline's
concurrency and works them. Shipped as `src/`, checked out fresh at the git ref the
deployment names, and shared by every pipeline of the deployment.
_Avoid_: daemon, worker, runner

**Bootstrapper**:
The container's main process. It materializes the engine at the named ref, parents it,
hands it credentials and slots, and relaunches it when the config or the ref moves.
_Avoid_: supervisor, launcher, wrapper

**Deployment report**:
The whole object one deployment hands a console: identity, what the bootstrapper is doing,
and the fleet matrix with each pipeline's state derived. One fixed-size file,
`state/deployment.json`, rewritten when something moves: read locally, and shipped as-is to
a relay. A consumer renders it and derives nothing of its own.
_Avoid_: snapshot (that is `status.json`), state (that is the directory), status (that is
the CLI verb), manifest

**Pass**:
One turn of an engine's loop: poll, select, admit what it can, then wait. A supervised
engine reports each completed pass to its bootstrapper, which is the only evidence that a
loop with nothing to do is still turning.
_Avoid_: tick, cycle (that is the whole life of a work unit), iteration

**Arm**:
One of a mutually exclusive pair of shapes a deployment takes, resolved rather than
configured. The deployment arms are **solo** (one tenant) and **workspace** (a fleet); the
credential arms are **PAT** (an operator-supplied token) and **App** (a minted GitHub App
installation token).
_Avoid_: mode, variant, flavour

### Preparing work

**Front-loading**:
Creating the issues, maps, and grilling sessions that become `ready-for-agent` or
research issues. The work a person does before Phoebe can start, because an AFK agent
has nobody to ask.
_Avoid_: grooming, refinement, backlog prep

### Work

**Work unit**:
One thing a work kind works start to finish — an issue, a pull request, or whatever a
custom kind's `ref` names. A pipeline holds up to its `concurrency` of them at once.
_Avoid_: task, job, item, unit of work

**Work kind**:
A category of work unit defined by one registered definition — fetch, select, run, and
prompt. Five ship built-in (`issues`, `research`, `conflicts`, `checks`, `reviews`); a
tenant may register custom kinds in its config, and may opt into catalog kinds.
_Avoid_: work type, category

**Work kind definition**:
The contract object a kind is: name, prompt, eligibility, reporting, and the
fetch/select/run triple (`WorkKindDefinition` in `src/work-kinds/`).
_Avoid_: kind spec, kind config

**Custom kind**:
A tenant-registered work kind, indistinguishable from a built-in after boot.
_Avoid_: plugin kind, user-defined kind

**Catalog kind**:
An engine-shipped work kind that registers only when a tenant declares it, loaded
like a custom kind from the engine's own catalog (`phoebe-agent/kinds/<name>`).
Neither always-on like a built-in nor tenant-authored like a custom kind.
_Avoid_: optional built-in, shipped kind, plugin

**Work order**:
The configured priority of one pipeline's work kinds (`pipelines.<name>.order`). Priority
only: a kind it omits still runs, after the named ones.
_Avoid_: queue, priority list

**Cycle**:
One pass of a pipeline's loop: gather its kinds' work data, admit units up to the free
slots, work them or idle.
_Avoid_: iteration, tick, poll (the interval between empty cycles is the poll interval —
the cycle is the pass itself)

**Admission**:
The engine's check on a pick before it becomes a running unit: not already in flight, not
quarantined, and not sharing a GitHub object with a unit already running.
_Avoid_: acceptance, intake (that word is an example pipeline's name), dispatch

**In-flight set**:
One kind's refs running right now, offered to `select` as `ctx.inFlight` so one gather can
fill several slots.
_Avoid_: active set, running set

**Work source**:
What gathers one cycle's work data. It owns the cycle-scoped issue-body cache and returns a
cycle record. Selection is not its concern.
_Avoid_: fetcher, gatherer, data source

**Cycle record**:
What the work source returns: the units each kind offered, the order they were gathered in,
and one unified issue-body map. Nothing in it needs merging after the fact.
_Avoid_: cycle data, fetch result

**Quarantined unit**:
A work unit the engine skips because working it timed out — labelled, or, for a unit with
no GitHub target, remembered by the pipeline process. The label lapses once the unit's
content advances; the memory lapses when the unit's revision changes or the process ends.
_Avoid_: blocked, stuck, skipped

**Quarantined commit**:
An engine commit the bootstrapper refuses to launch after it crash-looped, in favour of the
last commit that ran healthily. Unrelated to a quarantined unit — do not shorten either to
"quarantine" alone.
_Avoid_: bad commit, blacklisted commit

**Handover**:
A unit a person now owns, recorded by its kind in the external system so selection skips
it. The engine stores none of them; a handover reaches it as a skip reason from `select`.
_Avoid_: escalation (that is the quarantine comment), parked

**Landed member**:
A feature member whose own pull request has merged into the feature branch and now waits
on the integration PR. Labelled so selection skips it. The label is never removed: on a
closed member it is history, on an open one after the feature ends it marks a stray member.
_Avoid_: done, merged member, integrated (that is what has not happened yet)

**Stray member**:
A feature member still open and still wearing a label Phoebe reads after its feature has
ended. Phoebe neither works nor repairs it; a person closes it or strips the label to
re-route it. Reported by `phoebe doctor`.
_Avoid_: stranded (that is a claim with no pull request), orphaned, abandoned, leftover

### Running

**Origin hub**:
The container's private clone of the target repository. It owns all local git state; each
work unit runs in its own worktree off it and pushes straight to origin. The host checkout
is never touched.
_Avoid_: mirror, cache, local repo

**Execution gate**:
The rule that only selection and dry runs happen on the host — a real work unit runs solely
inside the container.
_Avoid_: guard, host check

**Drain**:
Finishing every work unit in flight, admitting no new one, and exiting cleanly. How a
pipeline answers a shutdown or a relaunch.
_Avoid_: graceful shutdown, quiesce

**Reconcile**:
The bootstrapper's periodic check for a moved config or a moved engine ref, and the
drain-and-relaunch that follows one.
_Avoid_: refresh, sync, poll

**Credential lease**:
A GitHub token the bootstrapper hands the engine for a bounded period, re-read or re-minted
rather than baked into the process.
_Avoid_: credential handoff, token grant

**Engine log tag**:
The bracket every engine line opens with, payload `<slug>:<pipeline>` — the implicit `work`
pipeline included. Match it as a prefix; a unit's own lines add a second bracket.
_Avoid_: log prefix, label

**Slot**:
Permission to execute one work unit, granted by the bootstrapper. A pipeline holds one per
unit it has in flight.
_Avoid_: lock, permit, ticket

**Effective cap**:
How many slots the container hands out at once: the largest `concurrency` any live
pipeline declares, or the operator's env override.
_Avoid_: limit, max agents

**Starved pipeline**:
A pipeline holding no slot while it has work waiting for one.
_Avoid_: blocked, queued, starved row

**Slot floor**:
The bounded allowance that lets a starved pipeline hold a slot over the effective cap.
_Avoid_: reserve, guarantee, boost

**Worktree lease**:
A `git worktree lock` whose reason names the unit holding the tree (`pipeline=<name>#<kind>:<ref>`).
Broken only by its own pipeline at that pipeline's next boot, or by the stale-state sweep.
_Avoid_: worktree lock (that is the git verb), reservation

**Declared key**:
An environment-variable name a work kind names in `requiredEnv`, and optionally in
`agentEnv`. It is boot-checked for that kind's pipeline and scrubbed from every sibling pipeline.
_Avoid_: kind secret, scoped credential

**Wedged**:
A pipeline whose oldest in-flight unit has outlived its own run budget plus one poll
interval, or which has completed no loop pass in three poll intervals while not waiting for
a slot. A question the reader derives — `phoebe list` from the snapshot alone, the
deployment report from that plus the pass clock the bootstrapper holds — never a state the
engine records.
_Avoid_: hung, stuck, frozen

**Stale**:
On-disk state whose pipeline or work kind the current pipeline enumeration does not produce.
Reported by `phoebe list` and `phoebe doctor`, reclaimed by the stale-state sweep.
_Avoid_: orphaned (fine in prose, but the reported state is `stale`), leftover, abandoned

**Engine source**:
Where an engine checkout comes from — a GitHub ref, or a local directory in development.
_Avoid_: engine version, engine origin

**Crash report**:
One of Phoebe's own install or upgrade faults, sent to a Sentry project under the
`reporting` block: a boot that cannot materialize the engine, a fast-exiting engine child, a
crash-loop quarantine, an operator command throwing. Never a tenant's failure and never
anything from the work loop.
_Avoid_: telemetry, error tracking (that is what the `sentry` kind reads), analytics

### Relay

**Relay**:
The self-hosted process deployments dial into and the console reads from; one per
operator. Ships in `phoebe-agent` and runs as `phoebe relay serve`, in its own image
beside the deployment, never inside it.
_Avoid_: server, hub, gateway, backend

**Allowlist**:
Who may sign into a relay: a file of `{ sub, email }` on the relay's volume, seeded by
the first verified Google login when it is empty, merged at every start with the
addresses in `ALLOWED_EMAILS`. A person is keyed on Google's `sub`; the address is what
an operator types.
_Avoid_: whitelist, access list, users

**Pairing token**:
The single-use credential the console mints so one deployment can register its key.
Fifteen minutes, shown once, held in the relay's memory and never on its volume; the
operator puts it in the root `.env` as `PHOEBE_RELAY_TOKEN` and removes it once pairing
is done.
_Avoid_: API key, join code

**Device token**:
The opaque bearer a relay issues to a companion after Google sign-in, sent as
`Authorization: Bearer` on every call main makes. Stored on the relay's volume as a
SHA-256 hash in `devices.json`, so a restart keeps companions signed in. No expiry:
revoking it from the People page is the only end it has.
_Avoid_: API key, session token

**Device**:
One signed-in companion as the relay sees it, named by the machine's hostname and OS, and
listed under the person who signed it in. Removing a person revokes all of theirs.
_Avoid_: client, machine

**Relay-client seam**:
The console bundle's one interface to the relay, filled two ways: a browser's own origin,
cookie and `EventSource`, or the desktop bridge, where main holds the device token and
makes the calls. Nothing else in the bundle fetches.
_Avoid_: API client, transport

**Deployment key**:
The Ed25519 key pair on the data volume (`state/relay-key`) that is a deployment's
identity to its relay. Generated in the container at the first pairing, presented as its
public half, and used to sign a relay-issued challenge on every connection after.
_Avoid_: device key, machine key

**Link**:
The relay's record of a deployment — public key, name, first seen — in `links.json`. The
other half of the link is the key on the deployment's own volume; neither half needs the
other's process to be alive.
_Avoid_: registration (the act, not the record), enrollment

**Protocol**:
The integer both sides exchange in the handshake. A relay speaks every protocol up to its
own and refuses anything above it, so the rule is: upgrade the relay first.
_Avoid_: version (that is the package)

**Heartbeat**:
The relay's twenty-second ping, and the visible message that rides with it. The relay
counts the pong, the deployment counts the message, and neither side can do the other's
job: a built-in WebSocket client pongs on its own and can neither send a ping nor see one.
_Avoid_: keepalive, poll

**Dark**:
A deployment the relay has not heard from for sixty seconds, however the connection ended.
Clocked from the later of the last heartbeat and the relay's start, so a restart does not
paint a healthy fleet dark. Requests to a dark deployment are refused undelivered.
_Avoid_: down, offline, unreachable (none of those is a thing the relay can know)

**Disconnected**:
The relay no longer holds this deployment's connection and the dark threshold has not
passed yet. A fact with a duration — "disconnected 12 s" — that a console states rather
than a fourth state it holds.
_Avoid_: reconnecting (the relay cannot know that), offline

**Unseen**:
A link with no completed handshake behind it. Not dark: nobody has lost this deployment,
it has never arrived.
_Avoid_: pending, inactive

**Event stream**:
The one server-sent-events connection a console holds open, `GET /api/events`, carrying a
deployment's report as it arrives and the word for each connection as it changes. No
replay and no resume: every event has a read behind it that answers the same question in
full, so a page that missed one refetches.
_Avoid_: websocket (that is the fleet's side), feed, subscription

**Undelivered**:
The outcome of a request whose deployment socket closed before a receipt arrived, and of
one aimed at a deployment the relay is not holding. In-flight requests are refused with
it, never queued, and nothing is replayed on reconnect.
_Avoid_: failed, timed out

**Forget**:
The relay-side verb that deletes a link. The live connection closes with `unlinked` and
the deployment stops dialling.
_Avoid_: revoke, delete, unpair

**Leave**:
The host-side verb, `phoebe relay leave`, that deletes the deployment key from the data
volume. The other half of forget, and neither half needs the other to work.
_Avoid_: unlink, disconnect
