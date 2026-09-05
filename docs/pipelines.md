# Pipelines

**Who this is for:** anyone who wants a tenant to run more than one stream of
work at a time, and anyone who opened `phoebe list`, found several lines under one
repository, and wants to know what they are. It answers what a pipeline is, how
to declare one, and what the engine does differently once a tenant has two.

If you have never declared a `pipelines` block, you already have one pipeline and
nothing here changes what Phoebe does for you. Read the first section and stop.

The vocabulary is in [`CONTEXT.md`](../CONTEXT.md). This page uses those words
rather than redefining them.

## What a pipeline is

A **pipeline** is one named body of work a tenant runs, in its own process, with
its own priority order, kind tuning, cadence and concurrency. Every tenant has at
least one. `work` is the reserved default: the serial poll loop Phoebe has always
run, now with a name.

The reason to want a second one is that a single loop makes every kind of work
wait for every other. Filing an issue from a Slack thread takes seconds, and
wants to happen the moment the thread goes quiet. Working that issue takes
forty-five minutes, and wants a five-minute idle poll. Put both in one `workOrder`
and the fast work waits behind the slow work for as long as the slow work runs.
Declaring `intake` beside `work` is how you stop that. Two processes, two
cadences, one tenant.

Three things follow from a pipeline being a process rather than a queue, and they
are most of the design.

**A kind belongs to exactly one pipeline.** Two pipelines naming the same kind is fatal
for the tenant at load, because two processes would race each other over the same
pull request. Kinds nobody claims fall to `work`.

**Pipelines share the tenant and partition it.** One origin clone, one `state/`
directory, one `.env`, carved into slices with a single owner each rather than
locked. [What a pipeline owns on disk](#what-a-pipeline-owns-on-disk).

**A pipeline's failure is its own.** The container comes down only when every
supervised pipeline is crash-looping at once. [Supervision and
faults](#supervision-and-faults).

A pipeline is not a work kind, not a scheduling policy inside one loop, and not a
type. There is no "intake pipeline" the framework ships. An intake pipeline is a pipeline
whose kinds happen to read Slack, running on the same machinery `work` has always
run on.

## Declaring pipelines and the six knobs

The `pipelines` block is name-keyed and lives on the **tenant** config. A
workspace root declaring it is a config error, since a root says which tenants
exist, not what happens inside one.

```ts
pipelines: {
  work: { order: ["conflicts", "checks"], concurrency: 2 },
  intake: { pollIntervalMs: 15_000, kinds: { slack: "./kinds/slack.ts" } },
},
```

Names follow the custom-kind charset, lowercase `[a-z][a-z0-9-]*` and at most 32
characters, so `#` can never appear in one. That is what lets `<tenant>#<pipeline>` be
an unambiguous key.

There are six knobs, and the field reference with defaults is
[`configuration.md` → Pipelines](configuration.md#pipelines). What matters here is
which of them cost a relaunch.

`order`, `kinds`, `concurrency` and `pollIntervalMs` are **cold**. Editing one
drains that pipeline and respawns it, and nothing else moves. Editing
`intake.pollIntervalMs` touches the intake child and no other.

`disabled` and `priority` are **hot**. The supervisor consumes both itself, so it
acts on a change without relaunching anything, and an edit lands on pipelines already
queued for a slot.

That split is not a convenience. It is what the pipeline fingerprint means. The
supervisor asks the engine checkout for each pipeline's cold config, hashed, with
`disabled` and `priority` stripped at every nesting level, so a hot edit cannot
move the digest that decides whether to relaunch. This is the one place in the
system where a fingerprint knows what a field means.

Two knobs are worth their own note. A pipeline's declared `pollIntervalMs` **outranks**
`PHOEBE_POLL_INTERVAL_MS`, which is the fallback for a pipeline that declares nothing.
And `priority` is tenant-local by design. `priority: 100` means "ahead of my other
pipelines", never "ahead of everyone else's repo".

One behaviour changed when `workOrder` became `order`. It is priority-only now, so
**omitting a kind no longer disables it**: a kind absent from `order` runs after
the named ones, and `kinds.<name>.disabled: true` is the off-switch. Configs whose
`workOrder` already listed every kind behave exactly as before, which covers the
shipped default and everything `phoebe init` writes. The old top-level `workOrder`,
`workKinds` and `promptFiles` still resolve as `pipelines.work.*` with one
deprecation warning, and [`phoebe
migrate`](upgrading.md#moving-the-work-fields-into-pipelineswork) moves them for
you.

## Supervision and faults

The unit the supervisor runs is a **pipeline**: one `(tenant × pipeline)` cell, keyed
`<tenant config dir>#<pipeline>`. That id is the child-map key, the slot broker's
owner id, and the credential lease's, so a pipeline reclaims its own slots and its own
token when it dies.

The supervisor does not read the `pipelines` block. It asks the materialized
engine checkout instead. `phoebe pipelines --config <tenant config>` prints one
JSON object per pipeline: name, the hot knobs, `concurrency`, whether the pipeline's kinds
want the clone, the keys its kinds declared, and the fingerprint. Reading the
block in the bootstrapper would pin what a supervisor understands to the installed
launcher version, so every new knob would need an npm release before any
deployment could use it.

That split answers the awkward case cleanly. **Capability** belongs to the engine.
Boot probes the checkout once with `pipelines --probe`, and a checkout without the
subcommand gives every tenant one implicit `work` pipeline, spawned without a
`--pipeline` flag it would die on. That is byte for byte what a deployment did
before pipelines existed. **Validity** belongs to the tenant. An enumeration that
fails is that tenant's fault, never the fleet's, so it holds the tenant, warns once
per poll, and tries again, rather than spawning a `work` pipeline against a config
already known to be bad.

Enumeration spawns a Node process, so it runs only when the tenant config's stat
fingerprint moves. Steady state stays stat-only. The pipeline diff then decides
everything. A pipeline that appeared spawns, one that vanished drains, one whose own
fingerprint moved relaunches alone. A tenant fingerprint that moved with no pipeline to
show for it is by elimination tenant-wide, a `gitIdentity` or a `repoSlug` or an
edited `.env`, and every pipeline of that tenant relaunches, because every one of them
runs with it.

**The universality rule.** A pipeline's death alone is never fatal. The container exits
only when every supervised pipeline is crash-looping at once, and a fast crash counts
toward the crash-loop guard only when every pipeline that ran that commit has
fast-crashed on it. One broken tenant cannot quarantine a commit the rest of the
fleet is running happily. A pipeline is marked crash-looping when it dies of its own
accord inside the healthy-run window, and the mark survives a respawn, so two pipelines
crash-looping out of phase still add up to a verdict. Solo has one pipeline, so the
rule reduces to what it always did.

The mechanics, including what an engine upgrade does to the pipeline set, are
[`architecture.md` → Supervising pipelines](architecture.md#supervising-pipelines).

## Units in flight

`concurrency` above 1 means one pipeline may hold several units at once. The loop that
does it is **rolling top-up**, not batch, and the distinction is that it never
awaits a specific unit.

Each pass tops the pipeline up to its free-slot count, then waits on whichever of three
things comes first: a unit settling, the poll interval elapsing, or a drain. A
pass with no free slot skips the gather entirely, because there is nothing
selection could do with the answer.

Slots fill depth-first, so `order` still means priority. A kind is asked again and
again until it runs out before the next kind is asked at all. Filling k slots from
one gather is what `ctx.inFlight` is for, the kind's refs running right now,
including any admitted earlier in the same pass. A kind that filters on it can fill
several slots. A kind that ignores it degrades to one unit at a time rather than
breaking: the engine drops the repeated pick at admission, stops asking that kind
for the rest of the pass, and logs why.

**Admission** is the engine's own backstop, asked of every pick. It refuses a unit
whose `github` object another running unit already holds, because two agents on one
pull request is the failure worth spending a check on. A unit declaring no `github`
target gets no exclusion, and a log line saying so.

Everything a unit is given is its own: its worktree lease, its scratch directory,
its read-only tree, and the prefix on its children's output. Two units of one pipeline
that want the same worktree do not fight over it. The second finds the first's
lease, logs who holds it, and comes back next cycle. What raising `concurrency`
still costs you is throughput on kinds that genuinely want one tree, since they
take turns rather than run together.

The kind-side contract is [`work-kinds.md` → The `ctx`
surface](work-kinds.md#the-ctx-surface).

## Concurrency across the fleet

Two ceilings, and neither negotiates with the other. `concurrency` bounds what a
pipeline will admit. The bootstrapper's slot broker bounds what the container will run
at once. What runs is whatever both allow.

The cap is **derived**, not fixed: `max(concurrency)` across the live pipelines. A pipeline's
declared concurrency is reachable when nothing else is working, and the cap still
binds across pipelines. Every pipeline at the default 1 derives 1, which is the fleet Phoebe
has always run. `PHOEBE_MAX_CONCURRENT_AGENTS` replaces the derived number and wins
even when it is lower, because the operator knows the machine and the tenant does
not. A pipeline declaring more than the cap is not rewritten to fit. It queues, and boot
says so on one line. The number is recomputed on a reconcile that reshapes pipelines and
never on a hot edit, since a slot already granted cannot be recalled.

Starvation has two shapes, so there are two mechanisms.

A pipeline holding no slot while it has work waiting is **starved**, and one
forty-five-minute unit elsewhere can keep it that way for forty-five minutes. Such
a pipeline is granted one slot over the cap. `PHOEBE_SLOT_FLOOR_BUDGET` (default 1)
bounds how many of those over-grants may exist at once across the container, so the
worst case is `cap + floorBudget`. A release gives back an over-cap slot before a
regular one, and nothing is handed on while the cap is breached, so the breach
never rolls forward. Set the budget to 0 for a hard ceiling, and accept what that
costs a starved pipeline.

The other shape is a pipeline that is served but always last. The queue is served
**oldest waiter first** — the tenant whose waiter has been queued longest goes next,
and `priority` orders that tenant's pipelines against each other, higher first, ties in
the order they asked. Turns are taken per **pipeline**, not per tenant, so declaring three
pipelines is declaring three independent streams and they queue as three. Nothing
rotates on top of that: a pipeline admitting several units at once queues several
waiters, and it is served for all of them before a tenant that asked later. Asking
early is the only thing that buys a place, since `priority` never reaches past its own
tenant, and what keeps the pipeline at the back of a long queue moving is the slot
floor above, which is blind to how long the queue is. Starving a low-priority pipeline
for as long as something higher is contending is what the knob is for.

An intake pipeline takes slots in the same currency as everything else. There is no
exemption for short work, and asking for one would mean the broker could not bound
the machine.

The knobs, the boot line, and the exact formula are [`configuration.md` →
Concurrency](configuration.md#concurrency-the-pipelines-knob-and-the-fleets-cap).

## What a pipeline owns on disk

Two pipelines are two processes over one tenant's clone and one `state/` directory.
Ownership is partitioned rather than locked. Each thing on disk has exactly one
writer, and nothing needs electing.

`state/<pipeline>/status.json` is the pipeline's alone. Stdout lines are tagged
`[phoebe:<owner>/<repo>:<pipeline>]`, `work` included, so match it as a prefix and
not as a fixed string. The four tracker sweeps are scoped to the kinds the pipeline
schedules, so two pipelines cover every object exactly once and a pipeline scheduling none of
a sweep's kinds skips it. The origin clone is shared, cloned once with the first
clone serialized by a lock under `state/`, and a pipeline whose kinds all declare
`"scratch"` never clones at all.

The one new primitive is the **worktree lease**. `checks`, `reviews` and
`conflicts` can converge on one pull request's branch, so a tree is claimed with
`git worktree lock` and a reason naming its holder down to the unit:
`pipeline=<name>#<kind>:<ref> pid=<n>`. A tree anyone else leases is left alone,
whether that is another pipeline or a sibling unit of the same pipeline, and the unit that
wanted it comes back next cycle.

A lease outlives the process that took it, so a pipeline breaks its own leases at boot
and never anyone else's, reading the pipeline segment of the reason and ignoring
the rest. If you find a locked worktree and no engine, the reason names the pipeline and
the unit that left it.

Per-unit paths are the other half. A unit's scratch is `scratch/<kind>/<ref>` and
its read-only tree `worktrees/readonly/<kind>/<ref>`, the ref percent-encoded, both
created when first read and removed with the unit. Two units of one kind in flight
together never share a path, so one unit's preparation cannot clear the other's
work.

The full ownership table is [`configuration.md` → What a pipeline owns on
disk](configuration.md#what-a-pipeline-owns-on-disk).

## Credentials per pipeline

An intake pipeline reads a Slack token. The work pipeline has no business with it. Neither
does the target repository's install script, which until this landed saw every
value in the tenant `.env`.

The lever is on the kind, not the pipeline. A kind that reads a credential out of
`ctx.env` declares it: `requiredEnv` names the keys the kind's own code reads, and
`agentEnv`, a subset that is empty unless you set it, is what its agent children
also see. Values still live in the tenant's one `.env`. There is no per-pipeline
secret file and no per-pipeline config field.

The pipeline's key set is the union of what its scheduled kinds declared, and the
enumerator reports it alongside everything else about the pipeline. The scrub the
supervisor then performs is **subtractive**: a pipeline loses the keys a _sibling_ pipeline
declared and it did not. So the intake pipeline's Slack token never reaches the work
pipeline's child, and a key nobody declares reaches every pipeline exactly as before. That
rule holds for a solo deployment too, where there are no siblings and so nothing is
taken away.

Three more things follow from a declaration. A scheduled kind's declared key must
be present and non-blank when the pipeline's engine child starts, or that pipeline fails boot
naming the kind and the key, and only that pipeline, since its siblings boot. A kind
switched on later against a key nobody added stays off with a logged error rather
than taking the pipeline down. `phoebe doctor` reports the same shortfall as a tenant
finding. And the `.env` reconcile digest is computed per pipeline over the keys that pipeline
would actually hold, so rotating the Slack token relaunches intake alone.

Some keys cannot be declared at all: `GH_TOKEN`, `PHOEBE_*`, `GH_APP_*`, the git
identity variables, any `providerEnv` value. The engine mints, leases or sets
those, and a declaration that moved them would let one kind take the token away
from a sibling pipeline.

The GitHub credential itself is not narrowed per pipeline. The lease is per pipeline, the
cache per tenant, and the App-arm mint unchanged. Full contract, including what is
stripped from `installCommand` and prompt `!` expansions, is [`work-kinds.md` →
Declared keys](work-kinds.md#declared-keys-requiredenv-and-agentenv).

## Stale state and the sweep

Deleting a pipeline, renaming one, or retiring a work kind leaves disk with no
owner. The **stale-state sweep** reclaims it. `phoebe sweep-state` is a one-shot
engine command the supervisor invokes per tenant at exactly two moments and never
on a timer: at facility boot before any pipeline spawns, and after a pipeline-set change once
the pipelines it took down have drained. Both are moments when the disk in question is
provably nobody's.

It is a stateless diff of disk against the pipeline enumeration, with no cursor and no
memory of the last sweep, which is what makes the awkward cases fall out rather
than need handling. A `disabled` pipeline is still enumerated, so its state is
_stopped_, not orphaned. A rename is a delete plus a create. A kind that moved to
another pipeline keeps its scratch, because ownership moved rather than ended. And an
enumeration that fails means _unknown_, which skips the sweep entirely rather than
reading it as "everything is orphaned".

Deletion is tiered. Re-derivable state goes without asking, meaning leases,
orphaned state directories, unowned scratch and read-only trees, and _clean_
worktrees. A worktree that is dirty, or that holds commits `origin` has not seen, is
never auto-deleted. It is reported with its exact path and a one-line reclaim hint,
and `phoebe doctor`'s warn-only `stale-state` check keeps reporting it between
sweeps.

Worktrees are classified by the lease rather than by name, because they are
branch-keyed. Locked by a live pipeline is untouchable; orphan-locked or unlocked is a
candidate. That makes the sweep the second thing authorized to break a lease, after
a pipeline breaking its own at boot.

The sweep is never load-bearing. A per-item failure continues to the next item, and
a whole sweep that fails is one log line. The supervisor spawns exactly as if it had
never run. Mechanics: [`architecture.md` → Reclaiming what a pipeline leaves
behind](architecture.md#reclaiming-what-a-pipeline-leaves-behind).

## Watching pipelines

`phoebe list` keeps one pipeline per tenant and prints one indented line per pipeline
beneath it. The implicit `work` pipeline prints like any other, one grammar with no
collapsed form, and a solo deployment prints its single tenant the same way.

```
[phoebe] 2 of 2 declared tenant(s):
  children/widget  (acme/widget)
      ✓ config  ✓ env  ✓ data  arm: pat
        work    working 1/2 issues 12
        intake  waiting for slot
        old     idle  (stale)
```

The pipeline set is the same enumeration the supervisor spawns from, so `list` and the
supervisor cannot disagree about what a tenant runs. A `state/<name>/` directory no
enumerated pipeline produces prints as `(stale)`, the pipeline analogue of an
`undeclared` tenant, reported and not acted on. A held tenant cannot be enumerated,
since its config is exactly what discovery could not read, so its lines fall back to
what is on disk and say `(from disk)`.

Each line's state comes from that pipeline's own snapshot and nothing else. Two
snapshots are never compared. A pipeline polling every fifteen minutes is not sick
because the pipeline beside it wrote a second ago, and an idle pipeline is not sick for being
idle a week.

The one staleness claim is `wedged?`, and it is anchored to the only deadline the
snapshot carries, each in-flight unit's own run budget. A working pipeline gets
`wedged? <age>` beside the state it is still reporting once any of its units has
outlived its own budget plus one poll interval, so a unit admitted late on a short
budget can raise the flag while an older one beside it is still well inside its
own. The age is the oldest unit's. It is a question, not a verdict, because
nothing reading disk can see whether the process is alive.

There is no per-pipeline stop verb. Hot `disabled: true` is the stop, and it is one
edit with no relaunch. Today the flag is validated, enumerated and shown as
`(disabled)`, but the supervisor records it without yet acting on it, so the pipeline
keeps running until that lands.

Reading the columns, including `--json` and `--check`: [`operating.md` → Quick
reference](operating.md#quick-reference).

## Units the engine cannot see

Quarantine's skip half is a GitHub label filter, so a unit that is not a GitHub
object, a Slack thread or a pipeline in someone's board, had nowhere to receive the
marker and nothing to stop it being re-picked forever.

It now has both, in memory. The engine counts a unit's whole-unit timeouts under
`(kind, ref)` and, at the same threshold the label path uses
(`maxUnproductiveRuns`, 3 by default), puts the ref in that kind's
`ctx.quarantined`. That is a per-kind set, sibling to `ctx.inFlight`, that `select`
should filter on. Offering a quarantined ref anyway is not fatal: the engine refuses
the pick at admission and logs it, so ignoring the set stalls your kind on its
poison unit rather than spending a run budget on it every pass.

Three things end an in-memory quarantine, and only three. The unit's optional
`revision` changes, meaning the content advanced. The unit gains a `github` target,
at which point the label path takes over from zero with nothing seeded from memory.
Or the process ends, because the count is never written to disk.

Terminal states that are not the engine's business stay yours. A person owns this
now, sent back, waiting on the reporter: those live where the unit lives, as a
marker reaction or a board field or a ledger line, and reach the engine only as a
free-string `skipped` reason from `select`. The engine's own vocabulary is success,
failure and quarantine, and widening it would mean the engine storing domain state
it cannot re-derive. Full contract: [`work-kinds.md` → Units the engine cannot
see](work-kinds.md#units-the-engine-cannot-see).

## The intake example, end to end

The framework was designed against one validating example and checked against a
second. Neither ships with Phoebe. This section is what building them looks like,
because it is the shortest way to see which pieces above carry weight.

**Slack to issues.** A thread in a support channel goes quiet. An issue appears on
the tracker with the thread summarized, a suggested title, and a link back. The
ordinary `work` pipeline then picks it up as it would any other issue.

**AFK bug triage** is the cheaper one, and it needs no Slack at all. It is a
`/triage` state machine over issues already filed on GitHub, moving each through
reproduce, classify and label. Same shape, one fewer external system.

Both are one pipeline's worth of custom kinds, and both fit like this.

**One cycle per unit.** A unit is one thread, or one untriaged issue. The whole node
graph, read and summarize and decide and write, is kind-owned inside `run`. The
engine sees one unit going in and one result coming out, and the multi-step agentic
work inside is invisible to it. That is why nothing about `WorkKindDefinition` had
to relax.

**`ctx.github` does not grow.** A kind reaching past it uses `gh` or the REST API
itself, as every kind already does for a non-GitHub source. The engine offers no
HTTP convenience and owes none.

**The scratch path.** Intake needs a reading room and a desk, meaning repo context
to write a decent issue plus somewhere to put the draft. `ctx.workspace.scratch` is
on every workspace handle whatever the mode, and it is the one engine addition the
example forced.

**Draft handback.** The agent writes structured output to a kind-local draft file
the engine knows nothing about, and the kind reads it back. No new engine channel,
and no schema the framework has to version.

**`readyLabel` added last.** The handoff to the `work` pipeline is that label and nothing
else. The tracker is the entire interface between the two pipelines: no shared memory, no
queue, no message. An issue created without it is a draft the intake pipeline can still
amend, and adding it is the commit.

**Kinds partition by label.** Two kinds over the same repository stay out of each
other's way by selecting on disjoint label sets. That is kind duty, not engine duty,
and it is how a triage kind and the `issues` kind coexist.

**The unit gains `github` when its issue exists.** Before that it is a thread with a
`revision`. After, it is a GitHub object on the label path. The handover between the
two quarantine halves is designed for exactly this moment.

The **wake seam** is fixed and not built. An intake pipeline should start work when a
thread goes quiet rather than fifteen seconds later, which means a third racer
alongside the settle and the poll in [Units in flight](#units-in-flight). It is
pipeline-scoped and payload-free, a nudge that says "look now" and never a message
carrying work. Where it attaches is settled. The socket-holding process that would
push it is not designed here.

**Out of scope, deliberately.** The connectors themselves, meaning the Slack app
pair and its scopes and the triage state machine's prompts. And the wake source: the
process that holds the WebSocket, its URL refresh, the ten-connections-per-app
ceiling, the event caps. Those are a later effort. What this page claims is that the
framework hosts them, not that they exist.

The evidence for that claim, including the seven gaps the validation pass closed, is
in the two research records below.

## Related reading

- [`configuration.md` → Pipelines](configuration.md#pipelines), the six-knob field
  table, the deprecated top-level aliases, and the concurrency knobs. The field
  reference lives there and only there.
- [`work-kinds.md`](work-kinds.md), the kind contract every pipeline runs: `ctx`,
  `inFlight`, `quarantined`, the workspace modes, and declared keys.
- [`architecture.md`](architecture.md#asking-the-engine-which-pipelines-a-tenant-has),
  the supervisor's mechanics. Enumeration, the pipeline diff, the crash-loop rule, and
  the stale-state sweep.
- [`operating.md`](operating.md#quick-reference), `phoebe list` and the other levers
  a human drives a deployment with.
- [`workspace.md`](workspace.md#fleet-invariants), what stays true across a fleet
  once tenants have pipelines.
- [`upgrading.md`](upgrading.md#moving-the-work-fields-into-pipelineswork), the
  `phoebe migrate` step that moves `workOrder`, `workKinds` and `promptFiles`.
- [`research/hatsu-slack-intake.md`](research/hatsu-slack-intake.md), how the Slack
  side actually works. Socket Mode, push-to-wake, and dedup by stateless
  re-derivation.
- [`research/slack-responder-sketch.md`](research/slack-responder-sketch.md), the
  kind contract sketched against that responder before any of this was built, and
  which of its named edges have since landed.
