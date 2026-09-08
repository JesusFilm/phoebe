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
interval. A question `phoebe list` raises, never a state the engine records.
_Avoid_: hung, stuck, frozen

**Stale**:
On-disk state whose pipeline or work kind the current pipeline enumeration does not produce.
Reported by `phoebe list` and `phoebe doctor`, reclaimed by the stale-state sweep.
_Avoid_: orphaned (fine in prose, but the reported state is `stale`), leftover, abandoned

**Engine source**:
Where an engine checkout comes from — a GitHub ref, or a local directory in development.
_Avoid_: engine version, engine origin
