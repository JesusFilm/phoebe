# Speeding up Phoebe runs

**Provenance note:** this investigation was originally run against a working
checkout that was 7 commits behind `origin/main`, missing the multi-tenant/
concurrency implementation that merged as PR #78 (`996666d4`, "Multi-tenant
Phoebe: one container, many repos") plus PRs #71 and #68. Every finding below
was verified directly against `origin/main` via `git show origin/main:<path>` /
`git ls-tree` rather than the stale checkout, specifically because the two most
obvious "speed up Phoebe" ideas — a per-run timeout and cross-repo concurrency —
turned out to already be shipped there. The checkout has since been
fast-forwarded past that point (onto `fork/main`, which is a strict superset of
`origin/main`), so file/line citations below now match the tree as checked in.

## TL;DR — ranked levers

| #   | Lever                                                                                                  | Status                                            | Effort                       |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------- |
| 1   | Run multiple repos under nested/multi-tenant layout + raise `PHOEBE_MAX_CONCURRENT_AGENTS`             | **Already shipped**, just needs adoption + config | Low (config/layout only)     |
| 2   | Lower `PHOEBE_RUN_TIMEOUT_MS` if a hung unit is the pain point                                         | **Already shipped** knob                          | Trivial, has a real tradeoff |
| 3   | Give `$HOME` (package-manager cache) a named volume so installs stay warm across container recreations | **Not implemented** — genuine gap                 | Small                        |
| 4   | Lower `PHOEBE_POLL_INTERVAL_MS` if idle-to-pickup latency is the complaint                             | **Already shipped** knob                          | Trivial                      |
| 5   | Cache/condition the per-cycle GitHub API fetch (`fetchCycleWorkData`)                                  | **Not implemented** — minor, API-latency bound    | Medium, low payoff           |

The single biggest thing to understand first: **for a single-repo deployment, Phoebe
still executes exactly one work unit at a time, always** (`src/main.ts` `runLoop`, the
main loop is unchanged and strictly serial). Concurrency only exists _across tenants_
in a nested multi-repo deployment. If you're running one repo, most "speed" comes from
your own `installCommand`/`checkCommand`/`testCommand`, not from Phoebe's own
orchestration overhead, which is small next to those.

---

## 1. Concurrency across repos (already shipped, needs adoption)

Phoebe now ships a full multi-tenant concurrency broker, landed by PR #78 (issue #59,
CLOSED) and its follow-ups:

- `bootstrap/slot-broker.ts` — `createSlotBroker(capacity)`, a FIFO counting semaphore.
  `DEFAULT_MAX_CONCURRENT = 1` — the cap is deliberately conservative by default
  ("today's proven single-repo host load").
- `resolveMaxConcurrent()` reads `PHOEBE_MAX_CONCURRENT_AGENTS` (env), documented in
  `docs/configuration.md:314`.
- `bootstrap/broker-ipc.ts` (`attachBroker`) wires each tenant child's IPC channel to
  the shared broker; a child's `exit` event reclaims every slot it held, so a
  crash/OOM/drain can never permanently shrink capacity.
- `src/slot-client.ts` (`createSlotClient`) is the engine-child side: it calls
  `acquire()` before running a selected unit and `release()` in the `finally` (wired
  into `src/main.ts` around the unit-execution block, ~line 1676-1729).
- **This only activates in nested/multi-tenant mode.** `createSlotClient` returns
  `null` when the engine has no IPC parent channel — i.e. a flat single-tenant
  deployment (the common case today) runs "unbrokered," exactly as before: still one
  unit at a time. Nested mode is selected by a `repos/<owner>/<repo>/phoebe.config.ts`
  layout, discovered by `bootstrap/tenants.ts` (`discoverTenants`,
  `isNestedDeployment`). `bootstrap/supervise-fleet.ts` (`superviseFleet`) is the
  fleet-level loop that spawns/reaps one engine child per discovered tenant.

**What changing it looks like:** if you run more than one repo, migrate to the nested
`repos/<owner>/<repo>/` layout (see `docs/configuration.md` and the tenant-discovery
comments in `bootstrap/tenants.ts`) and raise `PHOEBE_MAX_CONCURRENT_AGENTS` above 1.
This is the single largest available throughput lever, and it is fully built — no
engine code needs to change, only deployment configuration.

**Tradeoff/risk documented in source:** the default cap of 1 is explicitly "raise
deliberately" (`docs/configuration.md:314`); `bootstrap/slot-broker.ts`'s header
comment frames the concern as unbounded children thrashing the host machine (worktree +
install + agent + test + push, run N-at-once). Raising the cap trades host resource
pressure for throughput — no specific safe upper bound is given in source, it's left
to the operator.

**Does not help a single-repo deployment.** If you only run one repo, this lever is
inapplicable — there's no second tenant to run concurrently with.

## 2. Per-run timeout (already shipped, tunable)

Issue #72 ("Per-run execution timeout... so it can't starve the fleet", CLOSED) is
fully implemented in `src/run-timeout.ts`:

- `DEFAULT_RUN_TIMEOUT_MS = 2_700_000` (45 minutes).
- `resolveRunTimeoutMs(env, configValue)` reads `PHOEBE_RUN_TIMEOUT_MS` first, then the
  `runTimeoutMs` config field, then the default. Documented in
  `docs/configuration.md:315`.
- `runWithDeadline()` races the agent call against the deadline, aborting via
  `AbortSignal` on expiry.
- Wired into `src/main.ts`: `RUN_TIMEOUT_MS = resolveRunTimeoutMs(...)` (line 120),
  and `runAgentInWorktree` wraps `runAgent(...)` in `runWithDeadline({ ms:
RUN_TIMEOUT_MS, ... })` (lines ~473-486).

**Important scope limit, stated directly in `src/run-timeout.ts`'s header comment:**
the deadline wraps **only the agent phase**. The install/test/push phases run via
synchronous `execSync` outside this deadline — an `AbortSignal` can't interrupt a
blocked `execSync` — so they rely on their own separate, already-existing sub-timeouts
(`CHILD_PROCESS_TIMEOUT_MS = 120_000` for gh/git calls, `SHELL_COMMAND_TIMEOUT_MS =
600_000` for install/test/ready, both still present in `src/main.ts`). The comment
explicitly flags "extending one budget across the whole unit (install→push)" as a
tracked #72 follow-up, not yet done.

**What changing it looks like:** lowering `PHOEBE_RUN_TIMEOUT_MS` bounds how long a
hung/slow agent run can occupy the (in flat mode, only) execution slot before Phoebe
gives up and moves on — directly relevant if "runs feel slow" actually means "one bad
unit is blocking everything else," not "the average unit is slow."

**Tradeoff, from source:** too tight a budget kills legitimately slow-but-productive
runs. There's no single right number given in source; 45 minutes is called "today's
shipped default," not a principled minimum. A companion mechanism already guards
against a timeout becoming a permanent tax: `src/quarantine.ts` (issue #75) counts
consecutive timeouts per unit and, at a threshold (`DEFAULT_MAX_UNIT_TIMEOUTS = 3`,
`PHOEBE_MAX_UNIT_TIMEOUTS`), labels the unit `phoebe:quarantined` and stops re-picking
it, so a genuinely poisonous unit can't burn the timeout budget forever.

## 3. Package-manager cache durability across container recreations (real gap)

Every work unit gets a brand-new ephemeral `git worktree`
(`addWorktreeForNewBranch`/`addWorktreeForExistingBranch` in `src/git-model.ts`),
`config.installCommand` is re-run from scratch in it every time (`runShellCommand` in
`src/main.ts`'s `runAgentWorkflow`/`runOneIssue`), and the worktree is deleted in a
`finally` (`removeWorktree`) — so there's no persisted `node_modules` between units by
design.

What _does_ persist across units, and is directly documented, is `$HOME`. The
Dockerfile sets `ENV HOME=/home/phoebe` and states outright (lines ~155-159):

> Anything the workload writes must be under `/data` (the volumes) or `$HOME`. That
> covers the package manager and provider CLI caches...

So package-manager download/content caches (e.g. npm's `~/.npm`, pnpm's content-store)
already stay warm across work units **within one running container's lifetime** —
that part is fine and already intentional. The gap: `compose.yml`'s volume list
(lines 47-51, 64-68) only names `phoebe-repo`, `phoebe-worktrees`, `phoebe-state`, and
`phoebe-engine` — there is **no named volume covering `$HOME`**. A container
recreation (redeploy, `docker compose up -d --force-recreate`, image rebuild) wipes
that cache, and every unit after a redeploy pays a full cold install again until the
in-container cache warms back up.

**What changing it looks like:** add a named volume for `$HOME` (or more narrowly, for
the package manager's specific cache directory, e.g. `~/.npm` or pnpm's store) in
`compose.yml`, mirroring how `phoebe-engine` already exists specifically "so a restart
fetches into an existing clone instead of cloning again" (same comment pattern, same
rationale, just not applied to the install cache).

**Flagged as inferred, not found in source:** no issue, PR, comment, or doc discusses
this specific gap or argues against it — I found no evidence anyone considered and
rejected it. This is my own read of the Dockerfile/compose.yml, not a documented
decision either way. Treat it as a genuine unexplored opportunity, not a "known and
deliberately skipped" tradeoff.

## 4. Poll interval (already a knob, don't confuse with reconcile interval)

`PHOEBE_POLL_INTERVAL_MS` (default `300_000` / 5 min, `docs/configuration.md:309`)
controls how long the persistent-mode loop sleeps between cycles when there's no work
(`src/main.ts`, `DEFAULT_POLL_INTERVAL_MS`). If "speed up runs" means "reduce the time
between an issue becoming ready and Phoebe picking it up" rather than per-unit
execution speed, this is the relevant knob, and it's a trivial env var change.

Don't conflate it with `PHOEBE_RECONCILE_INTERVAL_MS` (default `60_000`,
`docs/configuration.md:311`) — that's the _bootstrapper's_ separate supervision loop
(config/ref-change watch, `bootstrap/reconcile.ts`), unrelated to work-unit selection
cadence. The dev-only `templates/container/compose.local.yml` already tightens this to
10s locally with an explicit rationale comment ("the reconcile poll is one stat plus
... one ls-remote, so a tight interval is cheap here") — that reasoning doesn't
transfer to `PHOEBE_POLL_INTERVAL_MS`, which drives real GitHub API fetch volume
(`fetchCycleWorkData`), so tightening it has an actual cost (API quota), unlike the
reconcile interval.

## 5. Per-cycle GitHub API fetch (minor, likely not worth it)

`fetchCycleWorkData` (`src/main.ts`, ~line 1355) calls `KINDS[kind].fetch()` for
**every kind in `workOrder`, every single cycle**, with no conditional-request/ETag
caching found anywhere in `src/` or `bootstrap/`. This is real per-cycle overhead, but
it's GitHub-API-latency bound (sub-second to low-seconds per call), dwarfed by the
minutes-scale install+agent phase of actually executing a unit. Only worth pursuing if
someone is running an unusually long `workOrder` against an unusually short
`pollIntervalMs`.

---

## `verifyMode` set to `engine` or `both` adds wall-clock to every unit

Issue #166 ("Engine-executed verification gate: stop trusting the agent's
self-report") adds `checkCommand`/`testCommand` as an engine-run step,
sequenced _after_ the agent's own run finishes (`runOneIssue` in
`src/kinds/producer.ts`, `runAgentWorkflow` in `src/kinds/janitor.ts`). It is
opt-in — `verifyMode` defaults to `"agent"`, today's behavior, where the
engine never runs the gate itself — but choosing `"engine"` or `"both"`
sequences a second, full `checkCommand` + `testCommand` run onto the critical
path of every unit, on top of whatever gate the agent already ran as part of
its own workflow. For a repo whose test suite takes minutes, that is minutes
added per unit, not a one-time cost. This does not compound with lever 2's
`SHELL_COMMAND_TIMEOUT_MS` — the engine run is bounded by the same
600-second-per-command budget the agent's own install/test commands already
use — but it is additive with the agent's own verification time, since
nothing skips the agent's self-verification step just because the engine will
also verify.

**What changing it looks like:** stay on the default `"agent"` if per-unit
latency matters more than catching a fabricated self-report; opt into
`"both"` (shadow mode — the engine result is authoritative but a mismatch
against the agent's report is only logged, not acted on further) to observe
the actual cost and disagreement rate before deciding whether the tradeoff is
worth it for a given repo.

## Already in flight / already shipped (don't duplicate)

| Issue/PR                                                                   | Title                                                              | State             | Relevance                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #78 (`996666d4`)                                                           | Multi-tenant Phoebe: one container, many repos                     | Merged 2026-08-03 | Implements concurrency (lever 1) end-to-end                                                                                                                                                                                                                                                                                                                               |
| #59                                                                        | Scheduling & resource bounding of work across N repos              | CLOSED            | Design doc for the slot broker; fully implemented                                                                                                                                                                                                                                                                                                                         |
| #72                                                                        | Per-run execution timeout                                          | CLOSED            | Fully implemented, `src/run-timeout.ts` (lever 2)                                                                                                                                                                                                                                                                                                                         |
| #75 (referenced pervasively, not directly opened by number in this search) | Poison-unit repeat protection                                      | Implemented       | `src/quarantine.ts`, prevents a hung unit from burning the timeout budget forever                                                                                                                                                                                                                                                                                         |
| #90                                                                        | Crash-safe issue claims: lease + heartbeat + startup self-recovery | CLOSED            | Prevents orphaned `phoebe-processing` claims stalling an issue indefinitely — reliability, tangential to speed                                                                                                                                                                                                                                                            |
| #79                                                                        | Bound `superviseFleet.drain` with a SIGKILL escalation             | **OPEN**          | `drain()` in `bootstrap/supervise-fleet.ts` awaits child exit with no timeout; could make an engine-axis relaunch (shared engine ref/config change, which drains+respawns the whole fleet) hang indefinitely. Edge-case relevant to relaunch/upgrade latency, not per-unit speed. Not something to duplicate — pick it up if unbounded-drain-hang is your actual symptom. |
| #57                                                                        | Multi-tenant Phoebe (tracking issue)                               | **OPEN**          | Kept open as a tracking/parent issue even though the core implementation (#78) merged — likely residual follow-up scope, not a duplicate target                                                                                                                                                                                                                           |
| #81 / #88                                                                  | "Workspace Phoebe" — submodule-based multi-repo layout             | **OPEN**          | A different, alternate multi-repo architecture track (in-tree child-repo submodules vs. today's clone-per-tenant `repos/` layout). Not obviously a speed lever either way; flagged as exploratory/tangential, not something this doc's recommendations conflict with.                                                                                                     |

## What was NOT verifiable / had to be inferred

- **Lever 3 (install-cache volume)** is my own reading of the Dockerfile/compose.yml
  gap, not a documented decision anyone made or rejected — flagged above.
- **`docs/status-contract.md`**, named in the original source list, does not exist
  anywhere in `origin/main` (`git ls-tree -r origin/main` finds no `status-contract`
  path in `docs/`, and `docs/architecture.md` doesn't reference it). It may have
  existed only in the stale local branch as unmerged work, or its content may have
  been absorbed into `src/status-contract.ts` without a corresponding doc. Not resolved
  — flagging rather than guessing.
- The credential-helper change (issue #64/PR #71, "Authenticate git against private
  repos via a GH_TOKEN credential helper at boot") was located but not deeply
  investigated for speed impact; a quick check of `src/git-model.ts`'s `fetchOrigin`
  showed a plain `git fetch origin` with no visible per-call credential-embedding cost
  either way, so this was deprioritized as unlikely to be a speed lever (boot-time
  concern, not per-cycle).
