# phoebe-agent

## 0.12.1

### Patch Changes

- 1b82950: Research record: the Sentry read a poll loop needs (docs/research/sentry-read-surface.md, issue #470). Read from Sentry's API reference, its published OpenAPI document and the `getsentry/sentry` source: three calls do the whole loop (org issues list, latest event, external issue link), the group detail call is skippable because the event carries the release; `event:read` covers the read side and `event:write` the link; the list gives count, first/last seen, level and culprit but never a release; frames arrive camelCased with `pre_context`/`context_line`/`post_context` folded into one `[[lineNo, text]]` array; `llmFormat=markdown` renders the whole event for a prompt. Rate limits are undocumented but 20/s per org in the source, so not a design constraint. The Sentry App external issue is the only watermark a machine token can write, and it reads back free in `annotations`. GlitchTip serves the same paths and frame shape (four named divergences); Bugsink deliberately does not, and needs its own adapter.

## 0.12.0

### Minor Changes

- 124b3db: Custom work kinds flatten into their `kinds` block (#465). The reserved `custom` sub-block is retired: a `kinds` (or deprecated top-level `workKinds`) key naming a built-in is that kind's tuning block, and any other key declares a tenant-authored kind — three arms: an inline definition, a module path string, or one flat `{ path, ...knobs, ...options }` block. Declaration and tuning share one key: the block carries the six tuning knobs (`provider`, `model`, `effort`, `promptFile`, `runTimeoutMs`, `disabled`) beside `path`, and **every other root field is the kind's options**, passed through unvalidated as `ctx.options` — the `options` wrapper is retired (a leftover one is a config error pointing at the migration), and `path` plus the knob names are reserved words a kind's options cannot use. The string arm graduates to the block when it needs tuning or options; an inline definition's knobs live on the definition itself, as they always did.

  Every kind entry is now the same knob block, with `path` as one more knob — including the built-ins. Declaring `path` on a built-in's block (or the path-string sugar, `issues: "./kinds/my-issues.ts"`) replaces its shipped definition with the tenant's module, loaded and validated exactly like a custom kind's; the definition must name itself after the key, the tuning knobs keep applying to whatever lands under the name, and the block's extra root fields become the replacement's `ctx.options` (an extra field without `path` is a config error — the shipped built-ins never read options). This retires the "overriding built-ins is not supported" restriction from #350.

  This is a breaking config change with a migration: `phoebe migrate` gains m006 (`flatten-custom-kinds`), which byte-moves each `custom.<name>` entry up one level — under `workKinds` and under every `pipelines.<name>.kinds` — drops the emptied block, renames each entry's `module` to `path`, and unwraps its `options` into the block root. (The old spellings are tombstones: a leftover `module` or `options` key errors at load pointing at the migration.) A config that also tunes a custom kind through a sibling block is refused with the manual instruction, since folding those knobs into the wrapper is a value edit. m006 is ordered before m005 on purpose: m005's verify resolves the config with the current engine, which now rejects a leftover `custom` block outright with an error pointing at the flattening.

  The typo net the reserved key used to provide survives: an object under an unknown kind name that is neither a `{ path }` block nor an inline definition (no `fetch`/`select`/`run`) is rejected at validation, naming the legal kinds and the three declaration arms.

- 4b08aa1: Units the engine cannot see now have a skip half (#424). A unit with no `github` target had nowhere to receive the `phoebe:quarantined` label, so the timeouts the engine already counted for it in memory were written and never read: nothing stopped a wedged unit being re-picked every pass, forever. The count now has a consumer.

  **`ctx.quarantined`**, a sibling to `ctx.inFlight`: this kind's refs whose in-memory timeout count reached the threshold (`maxUnproductiveRuns`, K=3 by default). Filter it in `select` the way you filter `inFlight`. A kind that offers one anyway has the pick refused at admission and is not asked again that pass, so ignoring the set stalls that kind on its poison unit rather than spending a run budget on it every pass. Built-in kinds never appear in it — their units carry `github` and take the label path.

  **`revision` on the unit shape**, optional: what "the content advanced" means for a unit the engine cannot see — a Slack thread's newest message `ts`, a row version, any string that changes when the unit does. The engine records it beside the count and forgets the count when a later pick of the same ref carries a different one, which is how a unit gets out of an in-memory quarantine. Set no `revision` and the count lives for the process's life. It is memory-only either way: a relaunch costs up to K run budgets on a genuinely wedged unit, and nothing under `state/` stops being re-derivable.

  **A ref that gains a `github` target mid-count** drops its in-memory entry and starts the label path from zero — nothing is seeded from memory, so no comment claims timeouts an issue cannot show. The skip half for such a unit is the kind's own label filter, as it already is for the built-ins.

  **The idle report prints only when it changes** — the first idle pass after activity, and again whenever the skip set moves. A pipeline polling every few seconds was otherwise repeating one paragraph until it buried everything worth reading; a work pipeline at 300 s prints what it always printed. The in-memory drop renders there like any other skip: `N <noun> skipped (quarantined in memory)`.

- 4b08aa1: `phoebe list` prints one line per pipeline (#427). A tenant is several pipelines now, and one engine-state column read from one status file could only ever describe one of them. The tenant row keeps what is true of the whole tenant — path, slug, the config/env/data flags, the credential arm, its hold reason, `(disabled)` — and beneath it every pipeline gets an indented line of its own. The implicit `work` pipeline prints like any other; there is no collapsed form.

  **The pipeline set is the supervisor's.** `list` calls the same enumeration the supervisor spawns from, in its own process, so the two cannot disagree about what a tenant runs. A `state/<name>/` directory no enumerated pipeline produces lists as `(stale)` with a legend line — the pipeline analogue of an `undeclared` tenant, reported and never acted on. A held tenant is one whose config could not be read, so there is no pipeline set to ask for: beneath its held reason, `list` shows the snapshots that are on disk and marks each `(from disk)`.

  **States, from each pipeline's own snapshot and nothing else**: `no status`, `working k/N <units>` (`N` is the pipeline's declared `concurrency`), `waiting for slot`, `idle`, and `wedged? <age>` beside a working pipeline whose oldest unit has been running longer than its own `runBudgetMs` plus one poll interval. `wedged?` is a question — `list` reads files, not processes — and it is the only staleness claim made anywhere: an idle pipeline is never wedged however old it is, and pipelines are never weighed against each other. `phoebe doctor` gains no wedged check.

  **Solo lists its one tenant.** `phoebe list` in a solo deployment prints `[phoebe] 1 tenant (solo):`, the root's row, and its pipeline lines, instead of `No tenants`. That message now means what it says: nothing is declared here at all.

  **`--json`**: every tenant gains `pipelines: [{ name, disabled, source, state, units, updatedAt, wedged }]` and loses the tenant-level `status` field — a reader that wants one pipeline's snapshot names the pipeline. `--check` is unchanged and still structural: exit 1 only on held declared tenants, whatever the pipeline lines say.

- 4b08aa1: Per-unit isolation under concurrency (#423): the caveat on `concurrency` is gone. Two units of one pipeline can now hold worktrees, scratch directories and read-only trees at the same time without touching each other's, and the log says which unit every line came from.

  **The worktree lease is per unit.** Its owner widens from `<pipeline>` to `<pipeline>#<kind>:<ref>`, so a unit finding a tree held by a sibling unit of its own pipeline skips the cycle rather than tearing the tree down — the same treatment a tree held by another pipeline already got, with the skip line naming the holder. The boot-time lease break still reads the pipeline segment alone, so a pipeline keeps clearing its own leases after a kill and never anyone else's. A lease skip now waits a poll interval instead of waking the loop, since the holder will be minutes rather than microseconds.

  **`scratch/<kind>` and `worktrees/readonly/<kind>` gain a ref segment.** A ref is a kind's own string and nothing in the engine parses one, so it is percent-encoded into the path — everything outside `[A-Za-z0-9._-]`, `%` included, which keeps the mapping injective and stops a ref from naming a directory that is not its own. `issue:88` becomes `issue%3A88`. Materialization is still lazy, and cleanup still removes only what was materialized.

  **Every workspace handle carries a `scratch` directory beside its git shape.** A `readonly` kind now has both a reading room and somewhere to write its drafts, in the same run, and both go with the unit. `workspace` still names only the git shape, which leaves `workspace: "scratch"` reading a little oddly — "no git shape, plus the scratch every kind now has", with `dir` and `scratch` the same directory. The mode is not renamed; nothing a kind declares today changes.

  **Git and install output is attributed.** The calls that inherited the engine's stdout now pipe, and every line is stamped `[phoebe:<slug>:<pipeline>][<kind> <ref>]` — the shape `ctx.log` already used. Install output still streams as it is produced; git's arrives when the command ends. The agent bracket gains the unit too: `[owner/repo:claude][issues issue:88]`. A host parser matching agent lines on `[owner/repo:<provider>]` should match it as a prefix.

- 4b08aa1: Per-pipeline credentials: `requiredEnv`, `agentEnv`, and the subtractive pipeline scrub (#425). A work kind can now declare the env keys its code reads. `requiredEnv` names them; `agentEnv`, empty unless set, is the subset the kind's agent children also see — the one kind-scoped hole in the otherwise fixed agent allowlist. Values still live in the tenant's one `.env`; there is no per-pipeline secret file and no new config field.

  Declaring a key scopes it. The `pipelines` enumerator now returns an `env` per pipeline — the union of `requiredEnv` over the kinds that pipeline schedules — and the supervisor builds each child's env subtractively: a pipeline loses every key a sibling pipeline declared and it did not. An intake pipeline's Slack token no longer reaches the work pipeline's child. Keys nobody declares flow to every pipeline exactly as before, and a tenant that declares nothing gets a byte-for-byte unchanged child env. Solo applies the same subtraction to the env its child inherits.

  Declared keys are stripped from `installCommand`'s env and from prompt `!` expansions unconditionally, which closes a pre-existing leak of every `.env` value into the target repo's install hooks.

  Every declared key of a pipeline's scheduled kinds is boot-checked for presence and non-blankness. A missing one fails that pipeline's child at startup naming the kind and the key, in the same posture as the prompt-file check; sibling pipelines boot. A kind switched on later against a key nobody set stays off with a logged error rather than taking the pipeline down. `phoebe doctor` reports the same shortfall as a tenant finding.

  Reserved keys cannot be declared: `GH_TOKEN`, `PHOEBE_GH_LOGIN`, the four git identity variables, anything under `PHOEBE_*` or `GH_APP_*`, and any value of `providerEnv`. So is an `agentEnv` key the kind's `requiredEnv` does not list.

  The `.env` reconcile digest is now computed per pipeline over the keys that pipeline would actually hold, so rotating a declared key relaunches only the pipelines that can see it; rotating an undeclared key still relaunches every pipeline of the tenant. The GitHub credential is untouched — leased per pipeline, cached per tenant, minted with the full grant.

- 4b08aa1: What a pipeline owns on disk (#418): the runtime half of the pipelines model, so two engine processes can work one tenant without fighting over its clone, its worktrees, or its status file.

  **The stdout tag gained a third segment.** Every engine line is now `[phoebe:<owner>/<repo>:<pipeline>]`, including the implicit `work` pipeline's — one grammar, not two. **A host log parser matching the exact old `[phoebe:<owner>/<repo>]` string must become a prefix match**, or it stops matching. The bootstrapper's own `[phoebe]` lines are unchanged.

  **The status snapshot moved to `state/<pipeline>/status.json`**, exclusively owned by one process, and carries a `pipeline` field. It holds a single `currentUnit`, so two processes sharing one file would blank each other's on every event. `phoebe list` reads the `work` pipeline's snapshot for its existing tenant-level status line. An existing `state/status.json` is not migrated: the pipeline rewrites its own on the first unit event, and the stale file is inert. There is a new `skipped` unit event, for a unit deferred to another pipeline's lease.

  **The four tracker sweeps are scoped to the kinds their pipeline schedules.** The stranded-unit sweep partitions issue by issue, on the research label, so a pipeline can never re-arm a ticket another pipeline has an agent on. The quarantine sweep lists issues only from a pipeline with an issue producer and PRs only from a pipeline with a janitor. The stale-stack and feature-closes sweeps, both of which maintain what the issue producers create, run only from a pipeline that schedules one. A pipeline scheduling none of a sweep's kinds runs it empty. Exactly-once coverage across pipelines, with no leader election.

  **The origin clone is conditional and lock-guarded.** A pipeline clones only when one of its kinds declares a `worktree` or `readonly` workspace — a pipeline of `scratch` kinds never clones and never touches git. On a fresh tenant the first clone is serialized by a `mkdir`-style lock under the tenant's `state/`; the second process waits, then finds the clone already there. The lock is clone-only and is broken with a log line if its holder dies. Fetch and worktree administration share the clone unlocked, on git's own ref locking and the existing fetch backoff.

  **Worktrees are leased.** `prepareWorktree` takes `git worktree lock` with reason `pipeline=<name> pid=<n>` and drops it on teardown; `pid=` is diagnostic. `removeWorktree` now propagates git's refusal on a locked tree instead of falling back to a recursive delete, which could take a sibling's live tree out from under a running agent — the fallback survives only for an unlocked leftover directory. A pipeline breaks its own leases at boot, unconditionally and never another's, since a lease outlives the process that took it. A unit whose tree another pipeline leases is skipped for the cycle with a logged reason rather than failed.

- 4b08aa1: The `pipelines` block and `--pipeline` pipeline selection (#415). A tenant config can now declare named pipelines of work, like `pipelines: { work: { order: ["checks"], concurrency: 2 }, intake: { pollIntervalMs: 15_000 } }`, each with six knobs: `order`, `kinds`, `concurrency` (1), `pollIntervalMs` (300000), `disabled` (false) and `priority` (0). Names reuse the custom-kind charset, so `#` is excluded. `work` is the reserved default pipeline and exists whether or not a config declares it. The block is tenant-only; a workspace root carrying it is a config error. Unlike `engine`, `workspace` and `deployment`, it survives into the resolved config, because the pipeline enumerator and the cross-pipeline partition check both need to see every pipeline at once.

  `pipelines.work` is the new home of work-kind config. `order` replaces `workOrder`, `kinds` replaces `workKinds`, and a kind's prompt path moved onto its own tuning block as `kinds.<name>.promptFile`. The three top-level fields keep working as deprecated aliases, resolved as `pipelines.work.*` with one warning at load, but declaring both an alias and its replacement is an error rather than a merge. Tuning blocks also gained `runTimeoutMs`, resolved on the familiar ladder (`PHOEBE_<KIND>_RUN_TIMEOUT_MS`, then the block, then `PHOEBE_RUN_TIMEOUT_MS`, then the tenant field), and a pipeline's declared `pollIntervalMs` now outranks `PHOEBE_POLL_INTERVAL_MS`.

  `--pipeline <name>` selects the pipeline on the engine child's argv. It defaults to `work` and resolves into the flat fields every existing module already reads, so no consumer was rewritten. An unknown name exits before any GitHub call. `--run-once` and `--dry-run` take the flag too.

  One behaviour changed with the move: **`order` is priority, not membership.** Named kinds are polled first, in sequence, and every other kind the pipeline owns follows in declaration order. Omitting a kind no longer disables it; `kinds.<name>.disabled: true` is now the only off-switch. A config whose `workOrder` already listed every kind, including the shipped default, behaves exactly as before. The work-order validator keeps rejecting an unknown name and stops rejecting an empty array.

- 4b08aa1: The `pipelines` enumerator and the bootstrapper's capability probe (#417). `phoebe pipelines --config <tenant config>` prints one JSON object describing the pipelines a tenant declares: for each, its `name`, the hot `disabled` and `priority` knobs, `concurrency`, whether the pipeline's kinds want the tenant's git clone (any kind declaring a `worktree` or `readonly` workspace), and an opaque per-pipeline `fingerprint`. It is the seam the supervisor will spawn from, so the bootstrapper never learns to read the `pipelines` block itself — which would pin what a supervisor understands to the installed launcher version and force an npm release per knob.

  The fingerprint is the pipeline's own cold config, hashed, with `disabled` and `priority` stripped at every nesting level: both are hot, so a digest that moved with them would relaunch a pipeline the supervisor meant to adjust in place. Changing a pipeline's cadence moves that pipeline's fingerprint and no other. Custom kind modules load during enumeration, so a factory kind that checks its own prompt files and throws fails the enumeration rather than surfacing a spawn later.

  `phoebe boot` probes a materialized engine checkout once for whether it supports enumeration at all (`pipelines --probe`) and says so in its startup line. A checkout without the subcommand means every tenant runs one implicit `work` pipeline and enumeration never runs — byte for byte today's behaviour, so an existing deployment migrates as a no-op. On a checkout that does support it, enumeration runs per tenant and only when that tenant's config stat fingerprint moves; a failure is a tenant-level fault, never a fleet one. Nothing spawns from the pipelines yet.

- 4b08aa1: `phoebe migrate` now moves `workOrder`, `workKinds` and `promptFiles` into the `pipelines.work` block a tenant config declares its work in since #415 (issue #419). The move is a byte-range splice: each field's source range is lifted into the new block — comments inside it travel with it — and every byte outside the ranges it touches is left alone. Each `promptFiles.<key>` folds onto the kind that reads it, spending the odd singular spellings on the way (`issue` → `issues.promptFile`, `conflict` → `conflicts.promptFile`). A field whose value is computed or holds a spread is reported `manual` with the edit to make by hand, and the config is left untouched. The migrated file is then loaded and its resolved work order, kind tuning and prompt paths compared against what the file resolved to before, so a move that would quietly change what a tenant runs reverts instead of landing.

  Two followers of the move: `phoebe init` scaffolds prompt files from the built-in kinds' own default paths, so a fresh config carries no `promptFiles` block at all, and `phoebe doctor`'s prompt-drift check reads `pipelines.work.kinds.issues.promptFile` before the deprecated alias. The old fields keep working either way. Migrate as part of an engine-ref flip rather than ahead of one: an older engine has never heard of `pipelines` and would read a migrated config as a tenant that declares no work. See docs/upgrading.md.

- 080a88a: A read-only workspace mode for work kinds (#397): `workspace: "readonly"` is the third member of the workspace union, so `ctx.workspace` in a kind's `run` is now `{ mode: "worktree" | "scratch" | "readonly", dir }`. A readonly workspace is the same worktree the `worktree` arm prepares, detached at `origin/<defaultBranch>` and living at `/data/repos/<owner>/<repo>/worktrees/readonly/<kind>`. That gives a kind repo context with no branch to commit onto, nothing created or moved in the clone, and a bare `git push` that fails for want of a refspec. It is materialized on first read of `ctx.workspace.dir` and removed with the unit, the same laziness the other two arms have.

  The don't-push contract is that shape rather than a guard. A kind holds `ctx.env` and is trusted as the tenant, so the mode covers accident, not intent. The engine's one check runs at the unit boundary: a readonly tree left dirty or carrying commits is warned about as it is discarded, so work with nowhere to go is not lost silently. The unit still succeeds. `OriginHub` gains `addWorktreeDetached` and `dirtyFileCount`.

- 4b08aa1: Rolling top-up (#422): a pipeline's `concurrency` now does something. The loop keeps an in-flight set capped at the pipeline's declared number, and each pass wakes on whichever comes first — a unit settling or the poll interval. A pass with a free slot gathers once and admits up to `concurrency − inflight` units; a pass with none skips the gather and still runs the sweeps. At concurrency 1, which is still the default, this is the serial loop it has always been, with one named exception: a failed unit is reconsidered immediately instead of sleeping out a poll interval first.

  **`select` may now be called more than once per cycle.** The walk goes depth-first by `order`, so priority still means priority: the first kind is asked until it runs out before the next is asked at all. `ctx` gains `inFlight`, a read-only set of that kind's refs currently running, including the ones admitted earlier in the same pass. **A kind honouring it can fill several slots; a kind ignoring it offers a running ref again, the engine drops the repeat and stops asking that kind this pass** — so the cost of ignoring it is one unit at a time, never two agents on one unit. Custom kinds need no change to keep working.

  **Two units never share a GitHub object.** A unit whose `github` target is already in flight is refused at admission. A unit that declares no target gets no exclusion, and says so in the log.

  **All four tracker sweeps skip units this pipeline is running**, on top of the per-pipeline kind filter. That closes a live bug concurrency exposes: the stranded-unit sweep re-arms any issue wearing the processing label with no PR yet, which is exactly a running `issues` unit between its claim and its first push. Note that the sweeps now also run on a pass that admits nothing, so a long unit no longer holds tracker repairs behind it — a pipeline with a slow kind will make more `gh` calls per unit than it used to.

  **The credential lease is pipeline-scoped**: one live lease per process, refreshed in place, checked at admission ahead of the slot request. A failed refresh blocks new admissions and leaves the token cell alone, so units already running finish on the credential they were handed.

  **`status.json` holds `currentUnits[]` instead of `currentUnit`.** Each entry carries `startedAt` and the per-kind `runBudgetMs`, and the snapshot gains `waitingForSlot` for a pass parked on the broker. A snapshot written by an older engine is read back on the new shape, so an upgrade across a retained state dir needs no migration; `phoebe list` names every running unit.

  Per-unit worktree and stdio isolation is a separate ticket. Until it lands, two `worktree` kinds in one pipeline at concurrency 2 can still collide over a workspace — raise the number for pipelines whose units cannot share a tree.

- 107ee25: Plain-directory workspaces for work kinds (#358): `workspace: "scratch"` is the second member of the workspace union, and `ctx.workspace` in a kind's `run` is now `{ mode: "worktree" | "scratch", dir }`. A scratch workspace is one empty directory — no clone, no branch, no git state — for kinds that only need somewhere to write files. It is created on first read of `ctx.workspace.dir` and removed with the unit, the same laziness the worktree arm has, and lives at `/data/repos/<owner>/<repo>/scratch/<kind>`, cleared before each run so a directory left by a killed run is never inherited. `PathsConfig` gains the derived `scratchDir`. The reference kind in `examples/custom-kind/` runs on the new mode: it posts a comment and never needed a checkout, and its prompt now passes `gh` an explicit `-R`.
- 4b08aa1: Stale-state sweep and the doctor `stale-state` check (#426). Deleting a pipeline, renaming one, or retiring a work kind used to leave disk with no owner: `state/<pipeline>/` and its snapshot, `scratch/<kind>` and `readonly/<kind>` trees, and worktrees locked by a lease whose pipeline no longer existed and which nothing was allowed to break. A new one-shot engine command, `phoebe sweep-state`, reclaims them, and `phoebe boot` invokes it per tenant at two moments and never on a timer: at facility boot before any pipeline spawns, and after a pipeline-set change once the pipelines it took down have drained.

  Orphanhood is a stateless diff of disk against the pipeline enumeration, re-derived every sweep. State is orphaned only when its pipeline name — or, for kind-keyed state, its kind — is absent from the enumeration, so a `disabled` pipeline is still enumerated and its state is stopped rather than orphaned, a rename is a delete plus a create, a kind that moved between pipelines keeps its scratch, and an enumeration that fails skips the sweep entirely instead of reading unknown as "everything is orphaned".

  Deletion is tiered. Leases, orphaned state directories, unowned scratch and read-only trees, and clean worktrees are reclaimed. A worktree that is dirty, or that holds commits `origin` has not seen, is never auto-deleted — it is reported with its exact path and a one-line reclaim hint. Worktrees are classified by the lease rather than by name: locked by a live pipeline is untouchable, orphan-locked or unlocked is a candidate, which makes the sweep the second thing allowed to break a worktree lease after a pipeline breaking its own at boot.

  The sweep is never load-bearing: per-item failures continue, and a whole sweep that fails is one log line while the pipelines spawn as if it had never run. `phoebe doctor` gains a per-tenant `stale-state` check — its first look at the repos data directory — reporting orphans by tier including the worktrees the sweep refused, always warn and never fail.

- 4b08aa1: Supervisor pipelines: the `(tenant × pipeline)` matrix (#420). `phoebe boot` now supervises one engine child per pipeline rather than one per tenant. A pipeline is keyed `<tenant config dir>#<pipeline>`, and that id is also the concurrency broker's owner id and the credential lease's, so a pipeline reclaims its own slots and its own token when it dies. Each child is spawned with its own `--pipeline`. A tenant declaring `work` and `intake` therefore runs two children under distinct broker owners; a tenant declaring nothing runs one `work` pipeline, which is the one-child-per-tenant fleet unchanged.

  Pipelines are re-read when a tenant's config or `.env` fingerprint moves, and the diff decides what happens: a new pipeline spawns, a vanished pipeline drains, and an existing pipeline relaunches only when its own cold config moved — so editing `intake.pollIntervalMs` touches nothing but the intake child. A fingerprint move that no pipeline accounts for is by elimination tenant-wide (a `gitIdentity`, a `repoSlug`, an edited `.env`) and relaunches every pipeline of that tenant. An engine upgrade drains the fleet, materializes once, and re-enumerates every tenant before respawning; the pre-upgrade pipeline list is never reused.

  An enumeration that fails holds the tenant: nothing drains, the reason is warned once per poll, and the next poll tries again. At first boot a held tenant contributes no pipelines rather than a `work` pipeline against a config already known to be bad.

  **The universality rule.** A pipeline's death alone is no longer fatal. The container comes down only when every supervised pipeline is crash-looping at once, and a fast crash counts toward the engine crash-loop guard only when every pipeline that ran that commit has fast-crashed on it — so one broken tenant cannot quarantine a commit the rest of the fleet is running happily. A solo deployment has one pipeline, so its exit status, its backoff and the guard's threshold are exactly what they were. Workspace deployments gain both halves: their runs now feed the crash-loop guard, and a wholly crash-looping fleet exits instead of respawning forever.

  On an engine checkout with no `pipelines` subcommand every tenant still boots exactly one `work` pipeline, spawned without the `--pipeline` flag that engine would die on. Boot lines name a pipeline as `<slug>:<pipeline>`.

- 4b08aa1: The slot broker learns to schedule pipelines (#421). Its cap is no longer a constant 1: it derives `max(concurrency)` across the live pipelines, so a tenant writing `pipelines.work.concurrency: 3` gets 3 instead of a silent 1, while every pipeline at the default still derives today's 1. `PHOEBE_MAX_CONCURRENT_AGENTS` replaces the derived number, winning even when it is lower, and a pipeline declaring more than the cap queues for it rather than being rewritten to fit — boot prints the cap, where it came from, and any such pipeline on one line. The number is recomputed only on a reconcile that reshapes pipelines, because a granted slot cannot be recalled.

  Two mechanisms answer the two shapes of starvation. A pipeline holding no slot with work waiting may hold one over the cap, bounded fleet-wide by `PHOEBE_SLOT_FLOOR_BUDGET` (default 1, `0` for a hard ceiling), so one 45-minute unit elsewhere cannot stall an intake pipeline for 45 minutes; a release gives the over-cap slot back before a regular one, and nothing is handed to a waiter while the cap is breached, so the breach never rolls forward. And `priority` now orders the queue: tenants take turns, a tenant's own pipelines are served highest-first with ties keeping their place, and the same ordering allocates the floor budget. Waiters are sorted when a slot is granted rather than when they queue, which is what makes `priority` hot — the supervisor re-reads it and a pipeline already waiting is reordered without relaunching anything.

  Grants are fungible on the wire. A pipeline may have several acquires outstanding, the supervisor answers each with the same untagged message, and the engine-side client resolves its own FIFO; a broker disconnect now rejects every one of them, so the pipeline stops admitting work and drains what is running. The wire format is unchanged.

### Patch Changes

- bef17a7: The slot broker's cross-tenant fairness rule now says what the code does (#458). #421 described it as round-robin over tenants; what ships is oldest-waiter-first, which matches rotation only while each tenant has at most one waiter queued. Rolling top-up ends that assumption, since one pipeline can queue several units in a single pass, and a tenant holding the two oldest waiters is then served for both before a tenant that asked later.

  That stands as the rule, with no rotation cursor added. A queue position is earned by asking early, `priority` never reaches past its own tenant, and the pipeline at the back of a long queue is moved by the slot floor, which grants a pipeline holding no slot at all one over the cap however long the queue is. Scheduling behaviour is unchanged; `pipelines.md`, `configuration.md`, `operating.md`, `workspace.md` and the broker's own module doc now state the rule, and two broker tests pin it.

- 3c46bc5: The feature-branch arm now survives its first live use. Three faults, one PR: the captured `gh` executor dropped the `input` option, so every `gh api --input -` write (feature-branch creation and native stacking) posted an empty body and drew a 422; the branch-creation catch read any 422 as "reference already exists", hiding that; and GitHub refuses a pull request whose head and base share a commit, so the draft integration PR could never open on a branch cut straight from the default branch. `createFeatureBranch` now probes for the branch, and when it is absent seeds it with one empty commit on the default branch's tree before opening the draft PR. Stdin is forwarded on both executor paths, and only "Reference already exists" is treated as the idempotent success.
- f2c34eb: The feature-closes sweep now treats a `Closes #N` line anywhere in the integration PR body as already said, not just one between the `phoebe:closes` markers, and reads a line a hand edit left trailing blanks on. Integration PR #430 carried three lines below the block — for stacked members #418, #422 and #423, whose PRs merged into the blocker branch `phoebe/issue-415` rather than the feature branch, so the sweep never saw them. Phoebe's own lines have always landed inside the markers and now have a test saying so; what could go wrong was the sweep later attributing one of those members and writing a second line for an issue the body already closed. `docs/feature-branches.md` notes both the stacked-member blind spot and the new rule.
- 9d84d85: Research record: how hatsu turns Slack into issues (docs/research/hatsu-slack-intake.md, issue #405). Read directly from JesusFilm/hatsu at a321d77: Socket Mode means no inbound ingress; push-to-wake, pull-to-read with events never trusted as content; two separately scoped Slack apps plus an app-level `connections:write` token; "runs constantly" is two systemd-supervised processes with only an optional 60 s silence sweep; dedup by re-derived state (no cursor, no seen-set) and idempotent effects; issue shaping is LLM work behind a ticket contract. Plus the Slack-platform limits any phoebe intake inherits (10 sockets/app, socket refreshes, 30k events/hour, HTTP's 3 s ack and disable-on-failure rules).
- 4b08aa1: One supervision loop and one slot broker for solo and workspace (#416). Solo deployments used to run a dedicated single-child loop with their own broker beside the fleet's; both arms now run on `superviseFleet`, with solo as a one-tenant fleet, and `phoebe boot` creates exactly one broker per container. Nothing an operator sees changes: a solo engine exit still ends the container with its own status, a solo fast crash still feeds the crash-loop guard on the same threshold, and the drain is verbatim — SIGTERM to every child in parallel, exit raced against the grace ceiling, SIGKILL on timeout.

  The two semantics that genuinely differed are now injected policy on the shared loop rather than a second code path: a `PipelineExitPolicy` says what a pipeline dying on its own means for the container, and `onRunEnd`/`onRunTick` carry the guard's bookkeeping. The arm still decides discovery and whether the child inherits the supervisor's ambient env; it no longer decides which loop runs. Groundwork for pipelines (#400), where the loop supervises a flat tenant × pipeline matrix.

- 4b08aa1: `docs/pipelines.md` is the home of the pipelines model (issue #428). It opens with who the page is for, then takes one section per design decision: what a pipeline is, declaring one and which of the six knobs cost a relaunch, supervision and the universality rule, units in flight, the two ceilings on concurrency, what a pipeline owns on disk, credentials per pipeline, the stale-state sweep, reading `phoebe list`, units the engine cannot see, and the intake example the framework was validated against — Slack-to-issues and AFK bug triage — walked end to end with the wake seam named and the connectors marked out of scope.

  Every other doc keeps the seam it already owns and gains a pointer. `configuration.md` stays the sole home of the six-knob field table; `work-kinds.md`'s intro and poll loop are now explicitly the view from inside one pipeline, and its kind-contract additions gain a patterns section covering draft handback, handover, label partitioning, the kind-owned quarantine filter, and self-checking factory prompts. `CONTEXT.md` gains Pipeline, Admission, In-flight set, Worktree lease, Declared key, Wedged, Stale and the engine log tag, and corrects Fleet, Engine, Work order, Cycle, Work unit and Drain for a world where a tenant is a matrix of pipelines rather than one loop.

- 31d3e99: Pipeline drains driven by a reconcile now race their graces together instead of one after another. The container-stop and engine-relaunch paths already fan out through `drainAll`, but the pipeline axis awaited `drain(record)` a pipeline at a time, so removing or relaunching N pipelines in one poll could serialize N drain graces — an hour each by default — with the stale-state sweep and every respawn waiting behind the sum. The drains a poll asks for are collected and joined with `Promise.all`; the sweep and the respawns still sit behind that join, because both are only sound once every pipeline the reconcile takes down is down.
- 57486ca: `--config`/`-c` and `--pipeline` now parse the same way in every subcommand (#460). Between them the two flags had seven hand-written copies, and the copies had drifted: `phoebe --pipeline --dry-run` read `--dry-run` as the pipeline name, where the engine's own `parsePipelineName` rejected it, and `--config --json` did the same to `--json` under `phoebe`, `phoebe upgrade` and `phoebe migrate`. The stricter reading wins everywhere — the next flag was never the value, and swallowing it dropped the flag that was actually typed — so a `-`-prefixed word is now refused, as is a `--config=` with nothing after it. One implementation, in `src/cli-flags.ts`; the parsers keep their own argv loops and their own unknown-argument errors.
- 070cd59: Solo boot lines name their pipeline (#457). #420 asked every `[phoebe] boot:` line to name a pipeline `<slug>:<pipeline>`, and only the workspace arm delivered it: solo's spawn failure read `engine failed to spawn`, and a solo pipeline dying produced no line at all.

  Both arms now report a spawn failure and a child exit through the same two functions, so neither can drift from the other or go quiet. Solo also takes its label from the `repoSlug` its root config declares — in solo that config _is_ the tenant's — instead of the null slug discovery leaves it with, so its lines read `acme/widget:work` rather than `/etc/phoebe:work`. That covers the slot-floor and cap lines too, which were already labelled and already degrading to the path. A config with no usable `repoSlug` keeps the path label; nothing about that field turns into a boot failure.

  Solo wires no `onPipelineChange`: its tenant fingerprint is a constant, so the pipeline matrix never reshapes mid-run and the handler would have nothing to report.

## 0.11.0

### Minor Changes

- f043d30: `conflicts` and `checks` now catch a PR up with its **own base** rather than always the default branch (#392). Every merge either kind runs — the agent-free `cleanMerge`, the tree `prWorkflow` primes for the agent, and the `conflict` prompt's instructions — read the base off `mergeInfo`, which now carries `baseRefName`. For an ordinary PR and for a feature's integration PR that is still the default branch, so nothing changes. For a feature **member**, whose base is `<branchPrefix>feature-<M>`, it is the feature branch — and that is the merge GitHub was reporting a conflict against all along. Merging the default branch there resolved a different merge, left the reported conflict in place, and grew the member's diff by however far `main` had moved. The `conflict` prompt names the base through a new `{{BASE_BRANCH}}` placeholder; it defaults to the default branch, so a tenant prompt override written against `{{DEFAULT_BRANCH}}` still renders unchanged.
- e603568: `phoebe doctor` gains two per-tenant checks: `labels` verifies that `readyLabel`, `processingLabel`, and `prOptOutLabel` exist in the repo (naming the missing ones and the exact `gh label create` fix for each); `prompt-drift` warns when a vendored issues prompt lacks the blocker-recording rule, so operators learn before their agents quarantine blocked issues instead of parking them.
- de82bf6: Engine applies `config.processingLabel` to the GitHub issue before handing it to the agent, and `selectIssue` / `unresolvedBlockerNumbers` filter out issues already carrying that label so a unit in flight is invisible to selection.
- ba55755: Feature base arm (#379): unblocked members of a live feature are routed onto `origin/<branchPrefix>feature-<M>` instead of the default branch, and their PRs target that branch. The first member creates the feature branch (idempotent on 422) and a draft integration PR via the GitHub REST API; subsequent members reuse both. `PHOEBE_BASE` and stacked routing bypass the arm. `IssueGraphNode` and `Feature` now carry a `title` field so the integration PR is named after the parent issue without an extra API call.
- d8b1ae8: `conflicts` now keeps a live feature branch current with the default branch (#382). A feature branch is long-lived by construction, so `main` moves under it — and a branch that has merely fallen behind conflicts with nothing yet, which means no mergeability read would ever nominate it. The kind therefore selects a feature's integration PR on distance from the default branch instead, then works it down the path it already had: the agent-free clean merge, the `conflict` prompt when that dirties, the `prHead` + `mainHead` watermark when neither resolves it. A caught-up branch is zero commits behind, so it drops out the moment the merge lands. `featureBranchCatchUp: false` retires the catch-up tenant-wide; `ready-for-human` on one integration PR takes that feature out of scope on its own. `reviews`, meanwhile, never selects an integration PR at all: review activity there is a human reviewing the whole feature, and answering it would be Phoebe reviewing the human's review of Phoebe.
- 8c9f0de: Two config fields for the feature-branch arm (#341): `featureLabel` (default `phoebe:feature`, env `PHOEBE_FEATURE_LABEL`) is the opt-in label a parent issue wears to put its children on one branch, and `featureBranchCatchUp` (default `true`, env `PHOEBE_FEATURE_BRANCH_CATCH_UP`) governs whether the `conflicts` kind keeps a live feature branch current with the default branch. Both are additive with behaviour-preserving defaults, and the env overlay gains boolean support — validated as `true`/`false` so a typo cannot silently switch a janitor off.
- 91cfa9b: Each cycle, Phoebe now maintains a delimited `Closes #N` block in a feature's integration PR body, one line per member PR that has merged into the feature branch. GitHub honours closing keywords only on a PR bound for the default branch, so this is what makes merging the integration PR close the whole set of member issues at once — at the moment the work reaches the default branch, not while it sits on a branch. The sweep only ever appends, so a human's own prose in that body survives it.
- 9e929bd: Feature membership resolution for the feature-branch arm (#341): given an issue, the engine can now name the live feature it belongs to. The walk climbs GitHub's native sub-issue parent chain to the nearest ancestor wearing `featureLabel`, falling back per hop to a hand-authored `Part of #M` in the body (configurable as `partOfPattern`, env `PHOEBE_PART_OF_PATTERN`), and names the branch `<branchPrefix>feature-<M>`. A feature stops resolving once its integration PR is merged or closed, or its parent issue closes, so stragglers become ordinary tickets again and a late one never resurrects a merged branch. Reads are memoized per cycle — siblings share one walk — and a failed read leaves that issue unaffiliated rather than ending the cycle. Nothing routes on the answer yet; that is the base arm itself.
- 50b5216: The janitors now see feature-branch members (#341). Each cycle's PR listing covers the default branch as before, plus the branch of every live feature — one `gh pr list` per feature, all of it through the same scope filter. A member PR with red CI, a conflict, or unresolved review feedback is picked up like any other PR, where before it was invisible: nothing merges a member PR that nobody fixes, so the whole feature stalled in silence. A feature retires when its integration PR merges or closes, and `prOptOutLabel` on that PR now takes the feature's members out of scope with it, which is what makes the label the per-feature opt-out the config docs promise.
- cf76f20: Stack inside a feature, wait across its boundary (#383): base resolution now reads the feature membership of the blocker as well as the issue. Two members of one feature stack as before, with the stack floored on the feature branch instead of the default branch, and the member's resolution carries its feature. A dependency that crosses the boundary — a member blocked by an outsider, or an outsider blocked by a member — is skipped until the blocker's work reaches the branch the dependent is built on; the idle log names it. When the Stacks API cannot express the stack, a member's PR keeps its base rather than being retargeted onto the default branch, which would take the work off the feature branch; the ⛓️ banner names the branch an early merge would pollute. The stale-stack sweep retargets a member back onto its feature branch for the same reason.
- 140bdbc: Each cycle sweeps open issues that carry `processingLabel` but have no open or merged Phoebe PR. The sweep removes the stale claim and puts the issue back in the queue, so a killed or crashed run cannot strand an issue indefinitely.
- bacab7b: The stranded-unit sweep now owns the unproductive-run counter for issue-shaped units, applying `phoebe:quarantined` after K runs that produce no PR — not just timeouts. `recordUnitTimeout` narrows to PR-shaped units (conflicts, checks, reviews), eliminating the double-count that existed when an issue both timed out and was found stranded. The escalation comment for quarantined issues now says "N consecutive runs produced no PR" instead of claiming a timeout. `maxUnitTimeouts` is renamed `maxUnproductiveRuns` (config field and `PHOEBE_MAX_UNPRODUCTIVE_RUNS` env var); the old names work as deprecated aliases and a `phoebe migrate` step rewrites them.

### Patch Changes

- 925957d: `docs/feature-branches.md` documents the whole feature-branch arm in one place (#384): when a group of tickets earns its own integration branch and when direct-to-main or a stacked PR is still the right answer, the `phoebe:feature` opt-in that only a human applies, how membership is inherited through GitHub's sub-issue link (with `Part of #M` as the hand-authoring fallback, and research children riding the branch like any other member), the branch and draft integration PR Phoebe creates, the merges it never makes, why a member PR's `Closes #N` fires on nothing and how the integration PR body closes the set instead, what the janitors do with members and with the integration PR, and how a feature retires or is cancelled. `preparing-work.md` points at it as the third thing a map can produce, `work-kinds.md` as the third base-resolution arm, and `operating.md` carries the label and the cancel lever.

## 0.10.0

### Minor Changes

- e9fbafa: Modular work kinds (map #303): a work kind is now one self-contained definition object — name, prompt, eligibility, reporting, and a `fetch`/`select`/`run` triple — registered in a single registry the engine walks. The five built-ins are re-expressed on the contract, and a tenant can author its own kinds under `workKinds.custom.<name>` (inline, a module path, or `{ module, options }`), which the engine treats identically to built-ins: `workOrder`, `workKinds` tuning blocks, `PHOEBE_<KIND>_*` env vars, quarantine, slots, deadlines, and the prompt-existence check all apply uniformly (the run deadline bounds the agent spawn, not arbitrary kind code — a kind times out its own waits). Kind modules use type-only imports from `phoebe-agent` (`satisfies WorkKindDefinition`); everything a kind can do arrives on `ctx`. Work units are now opaque with a structural `ref` (`pr:123` / `issue:88`) — unit event lines and `phoebe list` show `conflicts pr:123` where they used to show `conflicts #123`. See `docs/work-kinds.md` → "Writing your own kind" and `examples/custom-kind/`. The scratch workspace `ctx.workspace.dir` is prepared on first read, so a kind that builds its own worktrees pays nothing for one it never uses.
- 23d889b: Bound a work kind's `run` under the whole-unit deadline (#359): the run budget now races against the entire `definition.run`, not just the agent spawn. A custom kind that hangs outside `ctx.agent.*` — an unbounded fetch, a poll loop, a `while (true)` — now triggers `RunTimeoutError`, releases its concurrency slot, and reaches the quarantine accounting path exactly like a built-in timeout. `WorkKindRunCtx` gains `signal: AbortSignal`, which fires when the budget expires; cooperative kinds pass it to async operations or poll `signal.aborted` to stop early. Each `ctx.agent.*` helper automatically passes the signal to the agent subprocess, so the child process is killed on expiry wherever in `run` the call sits.
- cf96006: The engine's credentials no longer ride into toolchain spawns. `installCommand` runs in a worktree that may sit at a PR branch head, where the branch's install hooks execute as the engine's child — its environment now drops `GH_TOKEN`, `GH_APP_ID`/`GH_APP_PRIVATE_KEY`, and every configured provider API key while still inheriting the operator's toolchain env whole (registry tokens, proxies, `NODE_OPTIONS`). The prompt `` !`cmd` `` expansions keep `GH_TOKEN` — the shipped templates open with `gh` calls — but likewise stop seeing provider keys. An install that needs GitHub auth of its own (private git dependencies, GitHub Packages) must bring a dedicated token; the engine's minted credential is not it. `docs/trust.md` gains "The config is code": loading the config or a custom kind module is executing it, why an unmerged PR can't smuggle a kind in, and what `prScope` actually bounds.

### Patch Changes

- e8ad7b3: Fix migrate post-apply validation falsely reverting workspace-root migrations.

  `validateUserConfig` now skips the five tenant-field checks (`repoSlug`, `repoUrl`, `installCommand`, `checkCommand`, `testCommand`) when a `workspace` block is present. A workspace-root config carries that block instead of those fields by design, so demanding them was always wrong. The root preexisting-invalid probe is fixed as a consequence.

- 29cec29: Design record: the Slack bug-channel responder sketch (docs/research/slack-responder-sketch.md). A paper exercise against the modular work-kinds contract (map #303) that names the v1 extension points — workspace `none`/`readonly`, kind-declared credentials, non-GitHub work sources, and the agent tool surface — and feeds one amendment back into the contract: work units gain an optional structural `github` target so the engine's timeout/quarantine write path survives opaque units without parsing refs.
- 55f8886: Fix stale-stack sweep to retarget every orphaned stack member, not only the PR whose blocker completed (#360): the GitHub stacks `unstack` endpoint dissolves the whole stack, leaving all other members with stale Phoebe-branch bases. The sweep now falls through to `retargetPr` when `unstackPr` reports `not-in-stack`, so a PR whose stack was dissolved earlier in the same cycle (or in a prior one) still gets moved onto the default branch when its blocker has completed.

## 0.9.0

### Minor Changes

- 15c20b3: Add a stale-stack sweep that unblocks a natively stacked PR when its blocker issue closes as completed without merging a Phoebe PR. The sweep detects the dead stack layer each cycle, calls the GitHub Stacks unstack endpoint, and retargets the dependent PR onto the default branch.
- 2ee8825: Upgrade TypeScript from 5.x to 7.0.2, the stable native Go compiler. The typecheck CI gate now runs the Go-based `tsc`, which is ~10× faster than the old compiler. No source changes were needed — `erasableSyntaxOnly`, which the codebase already enforced, is exactly what TypeScript 7 assumes. `vite-plus` is bumped to `0.3.0` alongside it, as that release adds TypeScript 7 to the peer-dependency range.

### Patch Changes

- dac8c9b: Warn at boot when the resolved login differs from the author on Phoebe's own newest unit-marker comment. A token swap, GitHub App identity change, or misconfigured `PHOEBE_GH_LOGIN` makes every marker Phoebe posts read as foreign activity, silently resetting the quarantine counter every rotation so quarantine never fires. The cross-check is best-effort — a lookup failure logs and boot continues. The mismatch decision is a pure function (`loginMismatchWarning`) with direct unit tests covering match, mismatch, no marker history, and deleted author.
- b43ee63: Retry transient GitHub failures with backoff instead of failing the cycle. Captured `gh` calls that die with a 5xx or a network-level error (connection reset, TLS timeout, the GraphQL server-error catch-all) now retry twice, 2s then 8s, before the error propagates; rate-limit and permission failures still fail immediately, since a few seconds of waiting can't fix either. `git fetch origin` retries on any failure — a fetch is idempotent, and a GitHub 504 mid-negotiation used to cost a whole cycle or an engine restart. Writes with inherited stdio (comments, labels, `pr create`) are deliberately not retried: there is no captured stderr to classify, and a blind re-send after an ambiguous failure could double-post.
- 6a1af83: Base resolution and comment templates now use `config.defaultBranch` instead of hardcoded `origin/main`.
- 4bbf508: `workKinds` blocks can now set `effort: null` to suppress the effort flag for that kind even when `defaultEfforts` names one for the active provider. Previously the only escape from a global effort default was to drop `defaultEfforts` entirely and repeat the setting in every other block — an impossible tradeoff when one kind runs a model that has no effort knob (e.g. `claude-haiku-4-5`). A per-kind env var (`PHOEBE_<KIND>_EFFORT`) still wins over the null clear.

## 0.8.2

### Patch Changes

- 333b201: `phoebe upgrade` now runs the _target_ checkout's migrations, not the current pin's. `upgradeEngineHalf` handed `runMigrations` the config's existing engine source verbatim, so the materialize step fetched the old ref and spawned _its_ `phoebe migrate` — the upgrade gate was exercising the code being upgraded away from. Any deployment pinned to a ref whose migrate cannot load (v0.7.x–v0.8.0's parameter property under strip-only stripping) was stuck: every upgrade re-ran the broken old migrate and refused the flip, no matter how fixed the target release was.

## 0.8.1

### Patch Changes

- 61f24eb: Replaces the constructor parameter property in `ConfigRefusal` with an explicit field so `phoebe migrate` loads under Node's strip-only type stripping. Parameter properties are the one TypeScript construct in the codebase strip-only mode rejects, and `config-handle.ts` sits on the migrate import path — so every `phoebe upgrade` failed its migration gate with "TypeScript parameter property is not supported in strip-only mode" and refused to flip `engine.ref`.
- 462b07e: Corrects the documented mechanism behind the `chmod 0711` node guard: the kernel makes an exec of an unreadable binary non-dumpable (`would_dump()` in `fs/exec.c`), not `AT_SECURE`, which stays `0` for a plain unprivileged exec. Verified against the shipped image — the same-uid environ read really is denied. `trust.md` now also states the residual the old text omitted: readable helpers (`git`, `gh`, shells) spawned with secrets in their environment run dumpable, so the guard narrows in-memory exposure to those helper windows rather than eliminating it.

## 0.8.0

### Minor Changes

- 7f8f1f6: `phoebe upgrade --cli` and `--both` now rewrite the `ARG PHOEBE_AGENT_VERSION` pin in `container/Dockerfile` for container deployments and print the `docker build` command to apply it. `npm install -g` on the host does nothing to the baked image, so the pin has to change in the Dockerfile. `--check` and `--json` report the Dockerfile pin as the effective CLI version (`cli.source: "dockerfile"`). Unpinned Dockerfiles and host deployments are unchanged.
- b2baac5: `phoebe doctor` now checks the launcher version against `phoebe.minBootstrap`. A launcher below the engine's declared floor deadlocks the deployment — boot throws on startup and no work runs. Doctor names both versions, explains the situation plainly, and gives the one-line fix. No floor declared means the check does not apply.
- e1bb94f: Engines can now declare a minimum bootstrapper version via `phoebe.minBootstrap` in their `package.json`. Boot reads the field after checkout and throws immediately if the running launcher falls below the floor, naming both versions and the steps to fix it. Engines whose `package.json` is absent, unparseable, or missing the field keep working with any launcher.
- c488285: Stacked work rides GitHub's native stacked pull requests (#311). A PR opened
  for an issue blocked by an open blocker PR now targets the blocker's branch and
  is added to the blocker's stack — created when the blocker has none — so merge
  ordering, post-merge rebase, and retargeting are GitHub's job instead of a
  ⛓️ do-not-merge banner and a lazy catch-up merge.

  The agent's own `gh pr create` (issues prompt, step 7) targets the same base
  via a new `{{PR_BASE}}` placeholder, so both creation routes produce the
  stack's shape. A blocker buried under another open layer is not joined —
  `/add` appends to the top, which would stack the PR on a sibling it does not
  build on — and falls back instead.

  The Stacks API is a public preview, so unavailability is an outcome rather
  than an error: when the PR cannot be stacked, the ⛓️ do-not-merge banner is
  posted as a comment (once) and the PR is retargeted onto the default branch,
  which is the flow as it was. The PR body's strong warning became a neutral
  "stacked on" note either way, because the body is written before the outcome
  is known.

- d9684bc: New `workKinds` config field (#300): each work kind can carry its own `provider`, `model`, and `effort`, falling back to the repo-level defaults when unset, plus per-kind env variants of the runtime trio (`PHOEBE_<KIND>_AGENT` / `_MODEL` / `_EFFORT`). Each knob resolves independently — per-kind env → per-kind config → global env → repo defaults — and a provider-mismatch guard keeps a block's `model`/`effort` silent when the run's effective provider differs from the one the block speaks for. Unknown kind keys, provider values, and knob names are boot-time config errors.

### Patch Changes

- d36116d: Adds migration m003: lifts the bootstrapper version pin in `container/Dockerfile` from a hardcoded install line to a named `ARG PHOEBE_AGENT_VERSION`, making it overridable at build time with `--build-arg` and reachable by bump automation without a regex over prose.
- 856dd71: Credential lease requests now time out after 60 seconds. A supervisor that connects but never responds no longer stalls its tenant indefinitely — the affected cycle is skipped and normal polling resumes.
- 5f63082: Adds the `WorkSource`/`CycleRecord` seam design record (`docs/research/cycle-record-seam.md`):
  motivating defect (#290), five-to-three representation count, failure contract, and origin-hub
  collaborator. `CONTEXT.md` gains **Work source** and **Cycle record** glossary entries;
  `docs/research/engine-runtime-seam.md` notes that its "No WorkSource reshape" non-goal is now
  superseded by the new record.
- 9b98cae: Extracts all cycle-gather logic from `src/main.ts` into `src/cycle-work-source.ts`
  (`WorkSource` / `CycleRecord`) and wires `workSource.gatherCycle(fetchKinds)` into
  `createEngine`'s run loop. The only behaviour change: issue bodies are now fetched through
  a single cycle-scoped read-through cache (`Map<number, string>` local to each `gatherCycle`
  call) instead of per-kind maps merged after the fact — fixing the duplicate-fetch bug (#290)
  so the same body is never requested twice in one cycle regardless of how many kinds reference
  the same PR.
- bea02f7: The post-stamp push after `appendTrailerToCommits` now uses `--force-with-lease`. The rebase that stamps co-author trailers rewrites every SHA, so the plain push that followed was always rejected as non-fast-forward — the co-author credit was silently lost. The lease still surfaces any concurrent writer rather than silently overwriting them.
- 57178b7: Replaces the `KINDS` registry object in `src/main.ts` with a `switch` on `picked.kind`, letting the compiler narrow each branch to the concrete payload type and eliminating five unchecked casts. No behaviour change.
- efa94c6: Issue bodies survive every work order. A cycle gathers issue bodies per work
  kind and merges them into one map, which the stack selectors then read to tell a
  real conflict or a real CI failure from an expected divergence. The `conflicts`
  kind assigned that map where `checks` and `reviews` merged into it, so any
  `workOrder` fetching conflicts second discarded every body gathered before it.

  A body the selectors cannot find reads as "not stacked", so the effect was a
  pull request stacked on an open blocker being worked instead of left alone —
  its divergence from the base branch treated as something to fix. The shipped
  default order hides this, because conflicts fetches first into a map that is
  empty anyway; only a reordered `workOrder` reaches it.

  Every kind that gathers issue bodies now merges, and the map is a `const` so
  assigning over it is a compile error rather than a silent loss.

- deab09f: Correct the PAT rate-limit model in github-app-mode.md. Fine-grained PATs share
  their owner's 5,000 req/hr budget rather than each carrying an independent
  allowance. The App arm's GraphQL budget scales to 12,500 points/hr for standard
  installations (REST also 12,500 req/hr) and 10,000 points/hr for Enterprise
  Cloud (REST 15,000 req/hr), making it the better choice for multi-tenant fleets.

## 0.7.1

### Patch Changes

- 2caa78e: A comment with no author is nobody's, not Phoebe's (#282). GitHub reports a
  deleted account as a null comment author, and every login the engine read
  coerced that to `""` — which is also what an unresolved Phoebe login used to be.
  The two "missing"s were the same value, so a ghost's comment could compare equal
  to "Phoebe posted this", and the timeout counter's reset-on-activity signal was
  lost with it.

  A missing author is now `null`, which is nobody's login and can never equal
  anyone's, and there is no placeholder Phoebe login at all: `resolvePhoebeLogin`
  resolves one wherever a comparison needs it, so `""` never reaches a comparison
  from either side. The one place two nullable logins do meet — skipping a PR
  author's own review comments — guards explicitly, so a ghost reviewer's comment
  on a ghost-authored PR is still the review feedback it plainly is, rather than
  being silently attributed to the PR's author and never worked.

- caa6ec1: The idle-cycle report now follows this tenant's `workOrder` (#282). Selection and
  the report were two separate walks over the work kinds — the loop asking
  `selectFirstWorkUnit`, and the reporter re-walking them in a hardcoded order of
  its own — so on any `workOrder` other than the hardcoded one they could name
  different kinds. An operator could be told "3 ready-for-agent issue(s) but none
  workable" about a cycle whose first kind was `conflicts` and whose conflicting
  PRs were never mentioned.

  `selectFirstWorkUnit` now returns the unit it picked together with a record of
  what each kind it walked passed over and why, and the report renders that record.
  There is one walk, so the report can only describe the cycle that actually
  happened. The lines themselves are unchanged; their order now matches
  `workOrder`, and a kind the walk never reached is no longer reported on.

## 0.7.0

### Minor Changes

- e23cbd0: Credit the issue author on Phoebe's commits (#198). On the issue-to-PR path
  (`issues` and `research` units) the engine now appends
  `Co-authored-by: <login> <id>+<login>@users.noreply.github.com` — the issue's
  author — to every commit it pushes for that unit, so the human who filed the
  ticket gets contribution-graph credit for the work it produced. The trailer is
  applied by the engine after the agent runs and before the push (a message-only
  rewrite of the unit's own commits), so operator prompt overrides need no change.

  Policy, decided here: it applies to every issue Phoebe works — applying
  `readyLabel` is already a maintainer's deliberate act — and never to the janitor
  kinds (`conflicts` / `checks` / `reviews`), which have no single requester. Bots
  and deleted accounts are never credited. Credit is best-effort: a failed author
  lookup, a merge commit in the range, or a failed rewrite leaves the commits
  exactly as the agent made them and logs why.

  New config field `creditIssueAuthor` (default `true`). Set it to `false` on a
  repo where a drive-by reporter's name on agent-written code would read as
  misattribution rather than credit. The opt-out is the operator's only — there
  is deliberately no per-issue or per-author switch.

- b988d95: New bootstrapper-only config block `deployment` (#260, #261) for deployments
  that do not run under Phoebe's Compose driver — Podman, a systemd unit, a
  remote host, anything with its own start/stop incantation:

  ```ts
  deployment: {
    startCommand: "podman compose -f container/compose.yml up -d",
    stopCommand: "podman compose -f container/compose.yml down",
    stopNowCommand: "podman compose -f container/compose.yml down -t 1", // optional
  }
  ```

  When the block is present, `phoebe start` runs `startCommand` and `phoebe stop`
  runs `stopCommand` (`--now` runs `stopNowCommand`, falling back to
  `stopCommand`) via `/bin/sh` with inherited stdio, and skips the docker-on-PATH
  check, Compose discovery, settle wait, and killed-mid-run detection that belong
  to the Compose path. `--build` warns and is a no-op. `startCommand` and
  `stopCommand` must be declared together; a half-declared block or a blank
  `stopNowCommand` is a config error. Like `engine` / `workspace` / `configDir`,
  `resolveConfig` drops the block — the engine never sees it.

  **Nothing changes when the block is absent** — `phoebe start` / `phoebe stop`
  drive `container/compose.yml` exactly as in 0.6.0.

- b988d95: New config field `disabled` (default `false`) — the human off-switch for a
  tenant (#202). Set `disabled: true` in a repo's `phoebe.config.ts` and its
  engine stops dispatching work at the top of the next poll: a run already in
  flight finishes, nothing new starts, and any quarantined work units are
  cleared so the tenant comes back clean when re-enabled. The child keeps
  running (so re-enabling is a config edit, not a restart), and `phoebe list`
  shows a `(disabled)` suffix (`disabled: boolean` in `--json`) while
  `phoebe doctor` reports it as an informational `ok` check.
- 52eaec2: New bootstrapper-only config field `gitIdentity` (#199): a repo declares how its
  commits are attributed — `gitIdentity: { name, email }` in `phoebe.config.ts` —
  instead of every deployment that adopts it restating the four `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` vars in a `.env`. A name and an email are not secrets and are
  repo-scoped, which is exactly the class of fact `phoebe.config.ts` is for.

  **The precedence ladder, decided here** (the objection #161 raised when it
  declined the field). Later wins: the supervisor's deployment-global `GIT_*` <
  the `app` arm's bot fallback < `gitIdentity` < the tenant's own `.env`. The
  config field outranks anything said deployment-wide and is outranked by anything
  said about that tenant specifically, per variable. Nothing moves for existing
  deployments: a `.env` that sets an identity today still wins, and a repo that
  declares nothing gets a byte-for-byte unchanged child env. In solo there is no
  deployment-global rung — the container env _is_ the single tenant's env-file, so
  it wins and the field fills the gaps; where it does, boot logs a line naming the
  vars it overrode, so a declaration cannot go quietly inert.

  Both halves are required — #161 established the email must be exact for
  GitHub's commit→account linkage, so a name-only field would look like it worked
  and attribute nothing — and the pair sets all four vars; author and committer
  are not separately expressible. A malformed value fails the tenant
  (skip-and-warn in a fleet, a hard boot error in solo) rather than silently
  falling back to the deployment's identity.

  Read by the bootstrapper only, like `engine` / `workspace` / `configDir`:
  `resolveConfig` drops it and the engine sees only the env vars the supervisor
  sets from it. Editing the field relaunches that tenant's child with the new
  identity at the next work-unit boundary, no container restart.

- b988d95: GitHub App mode: a deployment can now authenticate to GitHub as an installed
  GitHub App instead of carrying a fine-grained PAT per tenant (#155). Set
  `GH_APP_ID` and `GH_APP_PRIVATE_KEY` (base64-encoded PEM) in the
  deployment `.env` and leave a tenant's `GH_TOKEN` blank; the supervisor mints a
  short-lived installation token for that tenant's repo — narrowed to that one
  repository and the five onboarding permissions — and hands it to the engine
  child. Tokens are refreshed before expiry and re-delivered at the next
  work-unit boundary; a mint failure puts that tenant on hold without touching
  its siblings. The App's private key never reaches an agent process, and in a
  fleet never reaches an engine child; a solo engine child holds it by design,
  since it mints its own token. See
  `docs/github-app-mode.md` for registration, cost, and the per-tenant rate-limit
  budget.

  Every tenant resolves to one of two **credential arms** — `pat` (its own
  `GH_TOKEN`) or `app` — and mixed fleets are supported. The arm is now visible
  across the CLI: `phoebe boot` logs a per-arm tally, `phoebe list` shows an
  `arm:` column (also in `--json`), `phoebe doctor` checks each tenant by its arm
  (an App-arm tenant with no `GH_TOKEN` is healthy, not broken; the arm is only
  determinable inside the container, so an unverifiable check reports `unknown`
  and never fails `--check`), and `scripts/verify-tenant-token.mjs` verifies App
  installations by their granted permissions.

  Along the way, solo deployments gain what fleets already had: the engine child
  runs on an IPC channel with a slot broker, so `PHOEBE_MAX_CONCURRENT_AGENTS`
  now has its documented meaning in solo (default cap 1 — no behaviour change
  unless you raise it), and the engine leases its credential over that channel at
  the top of each poll instead of reading a fixed env var.

  **Nothing changes for existing PAT deployments.** A tenant with a `GH_TOKEN`
  never mints; the PAT arm remains the recommended solo default and is not
  deprecated. App mode is new in this release and has not yet been run in
  Phoebe's own dogfood deployment — treat it accordingly. Existing deployments that want the App arm need the two new
  variables in the deployment `.env` — see `docs/github-app-mode.md` §7 for the
  migration and `docs/configuration.md` for the variable reference.

- b988d95: New verb `phoebe migrate`, and `phoebe upgrade` runs migrations for you (#177).
  A **deployment migration** is a small, idempotent, engine-owned reshaping of
  the files a deployment carries — a prompt file the engine now expects, a work
  kind that should be in `workOrder` — so that moving to a newer engine no longer
  depends on an operator reading the changelog and editing by hand.

  - `phoebe migrate` walks the deployment (solo root, or workspace root plus
    every tenant), applies each registered migration that detects as applicable,
    and prints per-directory verdicts (`migrated` · `up-to-date` · `manual` ·
    `failed` · `reverted` · `skipped` · `invalid`) with the paths it wrote so
    you can review and commit them. Writes are staged and flushed only after a
    migration succeeds, create-if-absent files are written no-clobber, and a
    failure mid-flush or in post-apply validation reverts what was written.
    Dirty tenant trees are skipped, not overwritten.
  - `phoebe migrate --check` previews the walk with every write suppressed and
    exits 1 when anything is pending, for scripted pipelines.
  - `phoebe migrate --json` (with or without `--check`) emits a stable,
    additive-only envelope — documented in `docs/upgrading.md`.
  - `phoebe upgrade` now materialises the **target** checkout and runs _its_
    `migrate` before flipping `engine.ref`, so new code migrates old artifacts and
    a failed migration aborts the upgrade with the pin untouched. `upgrade
--check` is unchanged.

  **What changes for existing deployments.** `phoebe upgrade` may now leave
  uncommitted, reviewable edits in your deployment repos (a scaffolded prompt
  file, a `workOrder` entry) — review and commit them; nothing is pushed for you.
  A migration that fails aborts the upgrade with `engine.ref` untouched. This
  runs only for `engine.source: "github"` deployments: a `source: "local"`
  deployment does not go through the materialise-and-migrate step and must run
  `phoebe migrate` by hand after moving its checkout.

  Two migrations ship in this release: scaffold a missing
  `prompts/research-prompt.md`, and append `"research"` to `workOrder` where it
  is absent. Both are no-ops on a deployment that already has them.

  Config edits are made by a parser-based substrate (a vendored `@babel/parser`
  bundle, MIT) that splices only the bytes it changes and refuses — rather than
  guesses — on config shapes it cannot edit safely (spread, shorthand,
  computed keys, non-literal values, and so on); a refusal reports `manual` with
  the reason. `docs/migrations.md` covers writing migrations, the supported
  config forms, and the closed refusal set.

### Patch Changes

- b988d95: Agent log lines now carry the repo slug in a multi-tenant container:
  `[owner/repo:provider]` (and `[owner/repo:provider:stderr]`) instead of the
  bare `[provider]`, so interleaved agent output is attributable to a tenant.
  `docs/operating.md` is corrected to describe the actual `[<slug>:<command>]`
  prefix shape.
- a25a428: A blocker issue closed as **completed** now satisfies the block (#219). Blocker
  resolution used to ask only "is there a PR on `<branchPrefix>issue-<N>`?", so
  work that landed outside the prefix — a human's `wheat/issue-497`, another
  tool's branch — was indistinguishable from work nobody had started, and every
  dependent issue was skipped forever. `resolveWorktreeBase` gains a third arm
  after the open- and merged-PR arms: `CLOSED`/`COMPLETED` blocker → base
  `origin/main`, unstacked. `NOT_PLANNED` deliberately does not count; an
  abandoned blocker leaves the dependent on unbuilt ground.

  The `gh issue view` behind it is lazy — it fires only when both PR lookups come
  back empty, so every blocker with a Phoebe PR keeps the two calls per cycle it
  costs today and only a blocker Phoebe cannot see pays a third. A failure on it
  is caught the way `buildBlockerStates` already catches blocker-state failures
  (warn, treat as unsatisfied, retry next cycle).

  The idle line also names the blockers now — `3 ready-for-agent issue(s) but none
workable this cycle (waiting on blockers #497, #498)` — instead of a bare count
  that read the same whether the wait was legitimate or a permanent stall.

- b988d95: A GitHub rate-limit 403 is now reported as one, not as a permission failure
  (#201). Failed `gh` calls are classified from their stderr — `rate limit` vs
  `Resource not accessible by …` — and a rate-limit hit is rethrown as
  `GitHub rate limit exhausted (graphql|core) — resets at <time>`, with the reset
  time fetched from `/rate_limit` (which does not count against the primary
  quota). Operators reading
  the log can now tell "wait" from "fix the token".
- eec9021: Mask the deployment env-file inside the container so tenant engine children
  cannot read the deployment `GH_TOKEN` off disk.

  The deployment root is mounted read-only at `/etc/phoebe`, which includes the
  `.env` Compose uses as its `--env-file` input. Every tenant engine child (same
  uid 10001) could `cat /etc/phoebe/.env` and recover the credential, defeating
  the deny-by-default env allowlist in `bootstrap/engine-child-env.ts`.

  Fix: add `- /dev/null:/etc/phoebe/.env:ro` to `container/compose.yml`. Compose
  reads the real file before the container starts; inside the container the path
  resolves to empty. The dogfood compose (`/.phoebe/container/compose.yml`) gets
  the equivalent mask at `/opt/phoebe-engine/.phoebe/.env`.

  - `docs/trust.md`: clarify the deployment env-file is not part of the accepted
    at-rest residual — only sibling tenant `.env` files remain readable.
  - `docs/upgrading.md`: add a one-time step for existing deployments to add the
    mount by hand and restart.

- b988d95: Rotate a tenant's PAT without a relaunch (#205). Editing only `GH_TOKEN` in a
  tenant's `.env` no longer drains and respawns that tenant's engine child: the
  supervisor answers each credential lease with the token as it currently is on
  disk, and the engine picks it up at its next poll. Every other `.env` value
  still triggers the relaunch (they are frozen into the child's env at spawn).
  Removing or blanking `GH_TOKEN` also relaunches, so an absent token cannot
  linger in a running child.
- 95cc93c: Teach `phoebe start` / `phoebe stop` at the three sites where the long compose
  incantations lived.

  - `phoebe upgrade --cli` now tells operators to run `phoebe start --build` instead
    of the raw `docker compose --env-file ../.env build && docker compose --env-file
../.env up -d` pair.
  - `docs/upgrading.md` leads with `phoebe start [--build]` / `phoebe stop` for
    image rebuilds, the one-time chown step, and the multi-tenant clean-break
    upgrade. Raw compose is kept as a documented fallback with the `--env-file`
    explanation intact.
  - The `container/compose.yml` template header teaches `phoebe start`,
    `phoebe stop`, and `phoebe start --build` as the primary lifecycle commands.

- b988d95: Fewer GitHub calls per poll cycle (#200). The open-PR list is fetched once per
  cycle and shared by the `conflicts`, `checks`, and `reviews` kinds, and each
  PR's merge-info is fetched once (with the existing `UNKNOWN`-mergeability retry)
  instead of once per kind. Behaviour is unchanged; a fleet's per-tenant API
  budget stretches further, which matters most under App-installation rate
  limits.
- 4349cc9: Make the supervisor non-dumpable in the consumer image — chmod 0711 the system node.

  `templates/container/Dockerfile` now applies `chmod 0711 "$(command -v node)"` unconditionally,
  matching the dogfood image's long-standing deviation. The supervisor (`phoebe boot`) and every
  engine child run on this system node; without the execute-only bit, those long-lived processes
  holding `GH_TOKEN` stayed dumpable and a same-uid sibling could read `/proc/<pid>/environ`. The
  dogfood has run exactly this in production — evidence it does not break the shebang shims or
  execute-only ELF loading.

  `docs/trust.md` updated: the "what is isolated" list now names both the vendored cursor node
  (protecting the agent process) and the system node (protecting the supervisor and engine
  children), so the full non-dumpable set is documented.

  `docs/upgrading.md` adds a one-time image-rebuild note for existing deployments that predate
  this change.

## 0.6.0

### Minor Changes

- 1de2e41: Reasoning effort is now configurable per provider. `defaultEfforts` sits beside
  `defaultModels` in `phoebe.config.ts` and is merged the same key-by-key way, so
  `defaultEfforts: { claude: "low" }` sets a level without restating the rest;
  `PHOEBE_EFFORT` overrides the active provider's entry for one run.

  Only the `claude` provider maps it today — to `--effort`, one of `low`,
  `medium`, `high`, `xhigh`, `max`. `cursor` and `codex` have no equivalent knob
  and ignore it.

  **Nothing changes for existing deployments.** The default is empty rather than a
  level, so a provider with no entry is invoked with no effort flag at all and
  keeps its CLI's own default — the behaviour before this change.

- 08048b2: `phoebe start [--build]` brings the deployment container up detached from the
  host. It reuses the Compose discovery and injectable command runner from
  `phoebe stop` (#186), does not rebuild an existing image unless `--build` is
  passed, confirms the container stayed up after a short settle wait, and returns
  to the prompt pointing at how to follow the logs.
- b104f8e: `phoebe stop [--now]` drains and stops the deployment container from the host.
  It resolves `container/compose.yml` from the current directory (no upward walk),
  passes the deployment `.env` only when present, blocks for up to the fleet
  supervisor's 1h drain grace (or 1s with `--now`), streams Compose progress, and
  warns loudly when the container was SIGKILLed mid-run. Shared Compose discovery
  and an injectable command runner land here for `phoebe start` (#187) to reuse.

### Patch Changes

- 78227a3: The scaffolded `container/compose.yml` now sets `stop_grace_period: 1h` so
  `docker compose stop` gives the engine its full drain window (finish the work
  unit in flight, start no new one) instead of Compose's 10-second default, which
  was SIGKILLing mid-run. The value matches the fleet supervisor's
  `DEFAULT_DRAIN_TIMEOUT_MS`.

  **Existing deployments are not updated automatically** — `phoebe init` skips
  files you already have. Add this under the `phoebe` service in your
  consumer-owned `container/compose.yml`, then recreate:

  ```yaml
  stop_grace_period: 1h
  ```

  ```bash
  docker compose --env-file ../.env up -d --force-recreate
  ```

- 703445d: Corepack's download confirmation can no longer hang a work unit. The `pnpm` and
  `yarn` shims `corepack enable` installs default `COREPACK_ENABLE_DOWNLOAD_PROMPT`
  to `1`, so the first use of a version Corepack has not cached yet asks "Do you
  want to continue? [Y/n]" — and blocks on stdin whenever it is a TTY and `CI` is
  unset, which is exactly the case for a deployment started with `docker compose
run`. The engine spawns `installCommand` with inherited stdio, so that question
  reached a terminal with no operator watching it and the unit stalled at install
  rather than failing; the run-timeout deadline cannot interrupt a blocked
  `execSync`, so it stalled indefinitely. `installCommand` and the prompt `!`
  expansions now default the variable to `0`, which answers the confirmation
  without changing what gets downloaded — the version still comes from the repo's
  own `packageManager` field. An operator who sets the variable themselves keeps
  their value. (The expansions were never at risk of hanging — `execSync`'s default
  stdio gives them a piped stdin — but they would still have logged Corepack's
  download notice, and both spawns now build their env the same way.)

  This removes the need for a consumer image to set it: the fix holds for any image
  whose toolchain runs through Corepack, not just those that thought to add the
  `ENV` line.

## 0.5.2

### Patch Changes

- 21f7cf7: Two CLI guards against misleading errors: an unknown bare subcommand is now rejected with the installed version and the `pnpm dlx phoebe-agent@latest upgrade` hint (instead of falling through to the engine-run path and dying in config validation), and the engine-run path refuses a workspace-root config with "run from a tenant directory, or `phoebe boot`" (instead of the five-required-fields error about tenant fields a root never carries).

## 0.5.1

### Patch Changes

- 204aa3e: Quarantine now has two working exits. The auto-un-stick sweep is wired into the
  poll cycle: each cycle Phoebe checks every unit still labelled
  `phoebe:quarantined` and removes the label when the unit's content has advanced
  past the baseline its escalation comment recorded — a PR's head SHA, or a
  fingerprint of the issue body. Issue baselines are that fingerprint rather than
  `updatedAt`, which GitHub bumps on any comment, label, or reaction (including
  Phoebe's own quarantine writes) and which would therefore have cleared every
  quarantine on the first sweep. Both exits — the sweep and a hand-removed label —
  now reset the timeout counter, so a released unit gets a fresh
  `maxUnitTimeouts` allowance instead of re-quarantining on its next timeout. A
  `phoebe:quarantined` label applied by a human is never auto-removed: the sweep
  only acts on a quarantine of its own that is still in force, and ignores the
  baseline of one it has already lifted.

## 0.5.0

### Minor Changes

- 808b24f: New operator commands: `phoebe upgrade` advances the pinned engine ref (a
  strict-literal, in-place rewrite of `engine.ref` in the deployment-root
  `phoebe.config.ts` — refs validated before the pin moves, rollback command
  printed) and/or the npm CLI, with `--check [--json]` as a scriptable
  behind-detector; `phoebe doctor [--json]` reports deployment health (cli and
  engine versions, config, repo reachability, crash-loop quarantine state,
  supervisor liveness) and sweeps every tenant's token and repo reachability.

## 0.4.0

### Minor Changes

- c7a741a: Remove the nested (`repos/<owner>/<repo>/`) layout; **solo and workspace are the
  only supported layouts** (#169). Nested was never used in a real deployment, and
  workspace mode covers every fleet case it was meant to — and better, since
  children are self-configured repos rather than config dirs the operator
  hand-assembles.

  Breaking, with no deprecation window:

  - The surviving single-repo layout is renamed **`flat` → `solo`** everywhere —
    `InitProfile`, the discovery `mode` discriminant, help text, log lines, and
    docs — so code, docs, and `examples/` share one vocabulary.
  - `phoebe init` gains an explicit `--solo` flag alongside `--workspace` /
    `--tenant`. Default behaviour is unchanged: no flag ⇒ solo.
  - `phoebe add-repo` and `phoebe remove-repo` are **deleted** — both were
    nested-only. Workspace children are scaffolded by `phoebe init --tenant`, and
    registering or unregistering one is an edit to the deployment-root config the
    operator owns.
  - `--repo <owner/repo>` is **deleted**, along with the config-selection ladder it
    drove. It existed only to pick a nested tenant's config. So that it fails loudly
    rather than surviving as a no-op alias, engine mode now **rejects any
    unrecognised flag** instead of forwarding it — the engine reads its flags with
    `argv.includes(...)`, so a forwarded unknown flag was silently dropped and a
    typo like `--dry-runn` would run the opposite of what was asked. `--run-once`,
    `--dry-run`, `--config`/`-c`, and `--help`/`-h` are unchanged.
  - `phoebe list` and `phoebe purge` survive minus their nested arms. `list`
    enumerates workspace children and reports no tenants in solo; `purge` now
    refuses whenever a live config still claims the slug — including a _held_
    child, whose engine may still be running — and its advice names no removed
    verb.
  - A deployment root that still carries a `repos/` directory **fails boot** with
    `nested \`repos/\` layout was removed in 0.4.0; use workspace mode`. That guard
    is an error message, not a mode: without it such a tree would fall through to
    solo and die on a misleading "missing required field".
  - `examples/nested/` is retired; `examples/` ships solo and workspace.

  `/data/repos/<owner>/<repo>/` is untouched — that is the runtime data layout for
  every tenant, unrelated to the removed config-side `repos/`.

## 0.3.2

### Patch Changes

- c66e9f1: Validate `promptFiles` at engine startup (#164). Prompt loading was fail-at-use:
  a tenant whose runtime root was missing one prompt kind booted clean, polled
  happily, and only died when the first work unit of that kind was dispatched —
  which for a rare kind meant weeks later, one failed unit at a time. The engine
  now checks, before it starts, every entry the tenant's `workOrder` can actually
  dispatch, and refuses to run with a single error naming the tenant and every
  missing kind with its resolved path. A kind you dropped from `workOrder` needs no
  prompt file — it was never going to be loaded.

  Being a loadable file is the whole rule — a regular file, since a directory would
  pass an existence check and then throw `EISDIR` at dispatch — so a `promptFiles`
  key may point outside the runtime root. That is what a `configDir` tenant wants:
  `issue: "../prompts/issues-prompt.md"` reaches the prompts at the repo root
  instead of keeping a second copy under `<configDir>/prompts/` that silently
  misses every prompt improvement merged afterward.

## 0.3.1

### Patch Changes

- 2b2723e: Add `workspace: { tenants: [...] }` (#128) — the field shape, ordering, and
  validation for declaring a workspace fleet in the root config instead of walking
  the tree for it. A `workspace` block now declares exactly one of two discovery
  arms: `depth` (walk, unchanged and still the default) or `tenants` (an ordered
  list of directory paths). Declared order is authoritative, so it is spawn,
  `phoebe list`, and warn order rather than the walk's emergent slug sort.

  Entries are normalized (`"./widget/"` → `widget`); absolute and `..` paths are
  deliberately supported so a root may supervise repos outside the workspace
  checkout. Fatal at load: an entry that is or contains the workspace root, a
  duplicate after normalization, a tenant nested inside another tenant, a glob, or
  declaring both arms at once. An empty list is a valid zero-tenant fleet.

  One validator in `bootstrap/workspace-source.ts` backs both the bootstrapper and
  `resolveConfig`, so the two entry points cannot drift, and `WorkspaceField` is a
  union — declaring both arms fails to compile as well as to validate.

  Discovery for a declared fleet is not wired yet: a config using `tenants` is
  validated and then refused at boot rather than silently falling back to a walk.

## 0.3.0

### Minor Changes

- 0591258: Add a bootstrapper-only `configDir` field (#98) so a fleet tenant can point at a
  single asset directory instead of duplicating `.env`/`prompts/` at the repo
  root. `configDir: ".phoebe"` makes the supervisor read the tenant's `.env` from
  `<dir>/.phoebe/.env` and run its engine child with cwd `<dir>/.phoebe/` (so
  relative `promptFiles` resolve there), while `phoebe.config.ts` stays at the
  tenant root for discovery. Honored for workspace children and nested `repos/`
  tenants; malformed values are held like a bad `repoSlug`. Default `"."` keeps
  the co-located path byte-for-byte unchanged. Like `engine`/`workspace` it is
  validated then dropped by `resolveConfig` — the engine never reads it.

## 0.2.0

### Minor Changes

- 8bbfa25: Multi-tenant Phoebe: run one container that supervises many repos (map #57). A
  single deployment can now discover a fleet of tenants from
  `/etc/phoebe/repos/<owner>/<repo>/` — each with its own `phoebe.config.ts` and
  `.env` — and run one supervised engine child per tenant behind a global
  concurrency cap, per-tenant `[phoebe:<slug>]` log tagging, per-tenant
  `state/<slug>/status.json`, and `phoebe list`. Env-scrub isolation hands each
  child only its own secrets. The flat single-tenant layout still works
  unchanged; nested discovery is additive.
- 8bbfa25: Wire the poison-unit quarantine write path into the engine (#75/#80). A unit of
  work that repeatedly fails is now quarantined rather than retried indefinitely,
  keeping a poison ticket from stalling the fleet.
- 8bbfa25: Workspace discovery mode (map #81): run `phoebe` at the root of a workspace
  whose child repos are linked as submodules, each carrying its own in-tree
  Phoebe install (config + gitignored `.env`). Phoebe walks the tree, reads each
  child's config, and feeds the same tenant abstraction as multi-tenant mode —
  one supervised engine child per tenant, still cloning each repo privately (the
  local checkout is a discovery + config source only). A `workspace: { depth }`
  block in the root `phoebe.config.ts` selects the mode. Highlights:

  - Discover and supervise a fleet from the submodule tree, reconciling on every
    poll as children come and go.
  - Child `repoSlug` stays authoritative; the submodule `origin` is a best-effort
    cross-check, and duplicate slug/origin across the fleet is a fatal boot abort.
  - `phoebe list` and per-tenant status surface workspace tenants.
  - Two new scaffolder profiles: `phoebe init --workspace` (root) and
    `phoebe init --tenant` (child, prefilling `repoSlug`/`repoUrl` from the
    child's `origin`).
  - Topology docs and an operator runbook for the workspace layout.

### Patch Changes

- 8bbfa25: Bound `superviseFleet.drain` with a SIGKILL escalation (#79). Draining the fleet
  on shutdown no longer hangs indefinitely on a child that ignores SIGTERM — the
  supervisor escalates to SIGKILL after a bounded grace period.
- 8bbfa25: Let the conflict-resolution agent drop relocated or superseded hunks (#89)
  instead of forcing every hunk to apply, so a rebase whose changes have moved or
  already landed upstream resolves cleanly.
- 8bbfa25: Fix two container-boot blockers surfaced by dogfooding: the Corepack download
  prompt hanging boot, and the agent child's `0711` permissions preventing it from
  running.

## 0.1.1

### Patch Changes

- 9b8cb25: Authenticate git against private repos at boot. When `GH_TOKEN` is set,
  `phoebe boot` runs `gh auth setup-git --hostname github.com` once before
  supervising the engine, so `ensureClone`, engine fetch/push, and the agent
  child's own `git push`/`fetch` all authenticate via a live credential helper
  — no token is written to disk.
- bcbeefb: Stop two Phoebe instances on one host from sharing each other's clone. The
  scaffolded compose file lives in a directory named `container`, so Compose
  derived the same project name — and therefore the same "private" `/data/repo`,
  `/data/state`, … volumes — for every repo on the machine. `ensureClone` then
  adopted whatever clone was already there, so an instance could silently run its
  git work against the wrong repo while its `gh` calls used its own `repoSlug`.

  - The scaffold compose file now sets an explicit, overridable project name
    (`name: ${COMPOSE_PROJECT_NAME:-phoebe}`); `.env.example` documents setting
    `COMPOSE_PROJECT_NAME` uniquely per repo when sharing a host.
  - `ensureClone` now verifies an existing clone's `origin` matches the configured
    `repoUrl` and fails loudly on a mismatch instead of adopting a foreign clone.

## 0.1.0

### Minor Changes

- f185f7f: Run buildless on Node 24. The engine (`src/`) and the published bootstrapper now
  run from raw `.ts` via native type-stripping — no `dist/` build, no
  `tsconfig.build.json`; `tsc --noEmit` stays for typecheck only, and the package
  requires Node >= 24.

  Node 24 refuses to type-strip files under `node_modules`, so the two files Node
  resolves there — the `bin` and the `defineConfig` import entry — are a dumb JS
  launcher (`bootstrap/bin.mjs`) and a one-line runtime shim (`bootstrap/index.mjs`).
  The launcher copies the package out of `node_modules` (default under the OS temp
  dir, override with `PHOEBE_ENGINE_DIR`) and execs the real, still-TypeScript
  bootstrapper (`bootstrap/cli.ts`) from there. Consumer-facing behavior is
  unchanged — same `phoebe` / `phoebe-agent` commands, same `defineConfig` import —
  only the Node floor moved to 24.

- d76833c: `phoebe boot` now guards against a bad engine ref. Tracking a branch means
  eventually tracking it onto a commit that will not boot; after three consecutive
  fast crashes (a non-zero exit inside 60s) boot quarantines that commit and
  materializes the last engine SHA that ran healthily instead, keeping the
  container serving until the tracked ref moves past the bad commit — at which
  point the quarantine lapses and reconcile resumes normally.

  A run is judged three ways — healthy, crash, or inconclusive — so that a run boot
  itself ended (a reconcile drain, a container stop) moves nothing, and a commit
  that outlives the healthy window is banked as last-good while it is still
  running. The record (last-good SHA, quarantined SHA, crash count) is JSON in
  `paths.stateDir`, so a quarantine survives the container restart a crash-looping
  engine causes; an unwritable state dir is a warning, not a failure. The guard is
  inert unless the engine ref is a moving branch — a `local` mount has no commit to
  pin, and a pinned SHA or tag means the operator chose that exact commit — and
  inert until some commit has proven itself, so a first boot onto a broken ref
  still fails loudly.

- 2db8640: The engine's self-update machinery is gone, and `phoebe init` scaffolds the
  bootstrapper model. With `phoebe boot` owning engine updates, the engine no
  longer diffs its own code on every cycle and exits for a supervisor re-exec:
  `selfUpdatePaths` is removed from the config, and the shell `supervisor.sh` the
  scaffold used to write is removed with it.

  **The engine version moved out of the image and into the config.** It is now
  `engine: { source: "github", ref }` in `phoebe.config.ts`, and `PHOEBE_VERSION`
  is gone from the scaffolded compose and `.env`. Editing `ref` upgrades a running
  deployment: within one reconcile interval boot drains the engine at a work-unit
  boundary and relaunches it on the new commit — no image rebuild, no container
  restart. A tag or SHA pins exactly; a branch follows its tip, guarded by the
  crash-loop fallback.

  **If you already scaffolded a runtime** (nothing is published yet, so this
  breaks no released version), migrate it:

  - `selfUpdatePaths` is no longer a config field. Remove it — an unknown field is
    a type error.
  - Your `phoebe.config.ts` must import **nothing at runtime**. Replace
    `import { defineConfig } from "phoebe-agent"` with
    `import type { PhoebeUserConfig } from "phoebe-agent"` and a plain default
    export. Boot loads the config from the container mount, where no
    `node_modules` is reachable, so a value import fails to resolve.
  - Add an `engine` field (it defaults to `{ source: "github", ref: "main" }` —
    pin it) and set `PHOEBE_ENGINE_DIR` at a persistent volume so engine checkouts
    survive a restart.
  - Re-scaffold `container/`: the Dockerfile's `ENTRYPOINT` is now
    `["/usr/bin/tini", "--", "phoebe", "boot"]`, `compose.yml` describes the
    long-lived container directly, and `compose.daemon.yml` is replaced by a
    dev-only `compose.local.yml` for running an engine checkout from your host.

- c303d65: First public release of the `phoebe-agent` CLI: the configurable AFK coding-agent
  engine, distributed as a pinned CLI with `phoebe init` scaffolding and container
  templates. Installable via `npx phoebe-agent`.

### Patch Changes

- 8327a35: Introduce nominal (branded) types for git SHAs, branch refs, and PR numbers
  (`Sha`, `BranchRef`, `PrNumber`) with `asSha` / `asBranchRef` / `asPrNumber`
  constructors applied at the `gh`/config trust boundary. These were previously
  bare `string` / `number` that could pass each other's parameter slot silently.
  Internal-only hardening — no consumer-facing API or runtime behaviour change.
