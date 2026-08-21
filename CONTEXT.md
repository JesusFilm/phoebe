# Phoebe

The public engine for Phoebe, an AFK coding agent: it picks up labelled work in a
repository, does it in a container, and pushes the result as a pull request.

This file is the glossary. For how the pieces fit together see
[`docs/architecture.md`](docs/architecture.md); for the mechanics of each kind of work see
[`docs/work-kinds.md`](docs/work-kinds.md).

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
The set of tenants a single deployment supervises.
_Avoid_: pool, cluster

**Engine**:
The long-running process that selects one work unit per cycle and works it. Shipped as
`src/`, checked out fresh at the git ref the deployment names.
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

### Work

**Work unit**:
One issue or one pull request, worked start to finish inside a single cycle.
_Avoid_: task, job, item, unit of work

**Work kind**:
A category of work unit with its own selection rule and prompt — `issues`, `research`,
`conflicts`, `checks`, `reviews`.
_Avoid_: work type, category

**Work order**:
The configured priority of work kinds. The first kind with a workable unit wins the cycle.
_Avoid_: queue, priority list

**Cycle**:
One pass of the engine's loop: gather each kind's work data, select at most one unit, work
it or idle.
_Avoid_: iteration, tick, poll (the interval between empty cycles is the poll interval —
the cycle is the pass itself)

**Work source**:
What gathers one cycle's work data. It owns the cycle-scoped issue-body cache and returns a
cycle record. Selection is not its concern.
_Avoid_: fetcher, gatherer, data source

**Cycle record**:
What the work source returns: the units each kind offered, the order they were gathered in,
and one unified issue-body map. Nothing in it needs merging after the fact.
_Avoid_: cycle data, fetch result

**Quarantined unit**:
A work unit labelled so the engine skips it, because working it timed out. The label lapses
once the unit's content advances.
_Avoid_: blocked, stuck, skipped

**Quarantined commit**:
An engine commit the bootstrapper refuses to launch after it crash-looped, in favour of the
last commit that ran healthily. Unrelated to a quarantined unit — do not shorten either to
"quarantine" alone.
_Avoid_: bad commit, blacklisted commit

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
Finishing the work unit in flight, starting no new one, and exiting cleanly. How the engine
answers a shutdown or a relaunch.
_Avoid_: graceful shutdown, quiesce

**Reconcile**:
The bootstrapper's periodic check for a moved config or a moved engine ref, and the
drain-and-relaunch that follows one.
_Avoid_: refresh, sync, poll

**Credential lease**:
A GitHub token the bootstrapper hands the engine for a bounded period, re-read or re-minted
rather than baked into the process.
_Avoid_: credential handoff, token grant

**Slot**:
Permission to run one work unit at a time, granted by the bootstrapper so a fleet cannot
exceed its concurrency limit.
_Avoid_: lock, permit, ticket

**Engine source**:
Where an engine checkout comes from — a GitHub ref, or a local directory in development.
_Avoid_: engine version, engine origin
