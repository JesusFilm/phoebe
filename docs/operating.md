# Operating Phoebe as a human

**Who this is for:** anyone with Phoebe already running who needs to steer it. It
answers which labels, drafts, and comments change what Phoebe does next.

The canonical operator manual. It covers how a person steers Phoebe using GitHub
itself: labels, draft state, and the comment watermarks it leaves behind. There is no
separate control plane; **you drive Phoebe by changing the issues and PRs it
looks at.**

This manual is written against **config field names** (`readyLabel`,
`prOptOutLabel`, …) rather than literal strings, because every consumer sets its
own values. Look up your repo's concrete strings in its `phoebe.config.ts`, or
have each consumer keep a short "concrete values" card next to this manual. The
defaults are shown in parentheses throughout.

## The core idea

Phoebe polls the repo and, each cycle, works one unit of the first workable kind
in `workOrder`. It only ever acts on:

- **Issues** labelled `readyLabel`,
- **Wayfinder research tickets** labelled `researchLabel` (default
  `wayfinder:research`), unless the `research` kind is disabled, and
- **Open PRs in scope** (see `prScope` / `draftPrs` / `prOptOutLabel`).

So every lever below is just a way of adding or removing an issue/PR from those
sets, or of telling Phoebe "a human has this now." Research tickets are selected
the same way as ready issues (priority, age, `Blocked by #N`); see
[`work-kinds.md`](work-kinds.md#research-resolve-wayfinder-research-tickets).

## Starting a unit of work: `readyLabel`

Add `readyLabel` (default `ready-for-agent`) to an issue and Phoebe will pick it
up when it reaches the front of the queue. To influence _which_ ready issue goes
first:

- **Priority** is inferred from the title/body text: wording like _bug, broken,
  crash, regression, fix_ sorts first; _tracer, wire, poc_ next; then ordinary
  _polish_; then _refactor_ last.
- Within a priority, **older issues win** (oldest created, then lowest number).

To pause an issue without deleting it, just remove `readyLabel`. Phoebe never
touches an unlabelled issue.

### `processingLabel` means "in flight"

The engine swaps `readyLabel` for `processingLabel` (default `processing`) before
starting the agent. If you see `processingLabel`, a run is (or was) working that
issue — don't start on it yourself. If a run dies and leaves the label stranded,
the stale-label sweep reconciles it automatically; you do not need to requeue by
hand.

**Label ownership.** `readyLabel` is yours to apply and remove; `processingLabel`
is Phoebe's. To pause a queued issue, remove `readyLabel`. Applying
`processingLabel` by hand is not a pause — the sweep will treat it as a stale
claim and remove it.

When an agent identifies a blocker, it records `Blocked by #N` in the issue body
and exits. The `blockedByPattern` section below describes how the engine reads
that and what happens next.

## Blocking one issue on another: `blockedByPattern`

Write a blocker reference in the issue body, by default `Blocked by #123`
(matched by `blockedByPattern`). Phoebe then:

- **skips** the issue while the blocker has no PR yet,
- **stacks** the new branch on the blocker's branch while the blocker's PR is
  open (the resulting PR carries a ⛓️ "do not merge before #123" banner), and
- bases on the default branch normally once the blocker's PR has **merged**, and
- likewise once the blocker **issue is closed as completed**, even with no
  Phoebe-branch PR at all, which covers a blocker a human landed on their own
  branch. Closing a blocker as **not planned** does not unblock anything.

When everything is skipped, the cycle log names the blockers
(`waiting on blockers #497, #498`) so a stalled queue is a five-second read.

This lets you queue a dependent chain of issues at once and let Phoebe sequence
them.

## Landing a group of issues together: `featureLabel`

Add `featureLabel` (default `phoebe:feature`) to a **parent** issue and its
children stop going to the default branch one at a time. They branch off
`<branchPrefix>feature-<parent>` instead, their PRs target it, and Phoebe opens
one draft integration PR from that branch to the default branch. You merge the
member PRs into the branch, mark the integration PR ready when the set is
complete, and merge it. That last merge is what puts the feature on the default
branch and closes the member issues.

The label is yours, like `readyLabel`. Phoebe never applies it and never treats a
parent issue as a feature without it.

**To cancel a feature, close its draft integration PR.** Phoebe stops routing
anything onto the branch. It does not delete the branch, and it does not touch
member PRs that are already open. Any member still carrying a label Phoebe
selects on becomes an ordinary ticket bound for the default branch the next time
it comes up, so close the members you are abandoning or strip their labels —
`readyLabel` on the implementation children, `researchLabel` on the research
ones.

To take one feature away from the janitors without cancelling it, put
`prOptOutLabel` on its integration PR: that drops the whole feature, members
included. The arm end to end, and what it costs you, is
[`feature-branches.md`](feature-branches.md).

## Taking a PR back: `prOptOutLabel`

Add `prOptOutLabel` (default `ready-for-human`) to any PR and Phoebe drops it
from **all** janitor scans, so no conflict fixes, no CI fixes, no review handling.
This is the "I've got this one" switch. Remove the label to hand it back.

## Draft PRs as hands-off: `draftPrs`

Draft state is a second, lighter opt-out governed by `draftPrs`:

| `draftPrs`                  | Effect on drafts                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `skip-non-phoebe` (default) | Drafts on non-Phoebe branches are off-limits; Phoebe's own drafts are still worked. |
| `skip-all`                  | Phoebe never touches any draft.                                                     |
| `include`                   | Drafts are fair game like any other PR.                                             |

With the default, **marking someone else's PR a draft takes it off Phoebe's
plate** without needing the opt-out label. Mark it ready-for-review to hand it
back.

## Which PRs Phoebe considers at all: `prScope`

- `prScope: "phoebe"` (default). Phoebe only maintains its own
  `branchPrefix` (default `phoebe/`) branches.
- `prScope: "all"`. Phoebe maintains _every_ same-repo PR (still honouring
  `prOptOutLabel`, `draftPrs`, and the fork exclusion).

Cross-repository PRs from forks are **always** excluded.

## Watermark comments

Phoebe keeps no memory between cycles; it records janitor progress as hidden
HTML-comment markers on the PR. You normally never see them, but they explain
"why isn't Phoebe re-fixing this?":

| Marker                   | Meaning                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `phoebe-conflict-fail`   | A conflict fix already failed against this exact PR-head + base-head pair; Phoebe waits for either side to move before retrying. |
| `phoebe-checks-fail`     | A CI fix already failed at this PR head; Phoebe waits for a new push before retrying.                                            |
| `phoebe-reviews-handled` | Review feedback up to a timestamp was handled; Phoebe only re-runs on newer review activity.                                     |

**To force a retry**, move the thing the watermark is keyed on: push a commit
(new PR head), merge/advance the base branch, or post fresh review activity.
Because the marker lives in a PR comment, you can also delete it. But the parser
takes the **newest** matching marker, so deleting a failure comment only
resets state when it removes that newest one; an older matching marker still
underneath it will keep applying. When a janitor gives up it posts a **visible**
failure comment too, so a human knows to step in.

## Running modes

| Invocation             | Behaviour                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| no flags (the default) | Persistent poll loop; all kinds; idles `PHOEBE_POLL_INTERVAL_MS` (300000).                                    |
| `--run-once`           | One `issues` or `research` unit then exit. Janitor kinds are persistent-mode only.                            |
| `--dry-run --run-once` | Print the unit that _would_ be picked (host-safe, nothing executes).                                          |
| `--pipeline <name>`    | Run one declared [pipeline row](configuration.md#pipelines-rows-of-work-inside-one-tenant) instead of `work`. |

Flags go after the compose service name (`docker compose run --rm phoebe
--run-once`); `phoebe boot` forwards them to the engine it launches. No flags is
the deployed shape, and `docker compose up -d` runs the persistent loop.

`--dry-run` is the safe way to preview selection on your host without booting
the container. See [`upgrading.md`](upgrading.md) for start/stop/upgrade
commands and [`work-kinds.md`](work-kinds.md) for the full selection rules.

## Checking the deployment's health: `phoebe doctor`

`phoebe doctor` (report-only) runs eight checks and exits 1 when any fails:

- **cli.** Installed `phoebe-agent` against the npm registry's latest.
- **engine.** The configured pin against the latest release tag, plus the commit
  actually materialized in the engine checkout.
- **config.** The root `phoebe.config.ts` loads and its `engine` field parses.
- **repo.** The engine repo answers `ls-remote` with the current `GH_TOKEN`.
- **crash-loop.** Whether a quarantine is in force, meaning the container is
  silently running the last-known-good commit instead of the tracked tip.
- **supervisor.** Whether `phoebe boot` is the container's main process
  (answerable in-container only: `docker compose exec phoebe phoebe doctor`).
- **launcher-floor.** Whether the launcher meets the floor the engine declares
  in `phoebe.minBootstrap`. Below the floor is not staleness: `phoebe boot`
  refuses to start, so the deployment does no work at all. Reads the
  `ARG PHOEBE_AGENT_VERSION` pin in `container/Dockerfile` for a container
  deployment and the npm-global install for a host one. An engine that declares
  no floor, or a local-mount engine, reports "does not apply".

In workspace mode it also sweeps every tenant, using the same enumeration boot
supervises with, checking each tenant's `GH_TOKEN` is present the way its
engine child reads it, and that its repo answers to that token. Held tenants
surface as failures with their hold reason. `--json` for scripts.

The eighth check is per tenant and is the only one that reads the data volume:

- **stale-state.** State under a tenant's data directory that no pipeline row
  owns — a deleted or renamed row's `state/<pipeline>/`, a retired kind's
  scratch or read-only tree, a worktree whose lease names a pipeline that no
  longer exists. Most of it the next boot reclaims by itself ([the stale-state
  sweep](architecture.md#reclaiming-what-a-row-leaves-behind)); what this names
  by path is the tier that sweep refuses to touch — a worktree that is dirty or
  holds commits `origin` has not seen — with a one-line hint for reclaiming it
  by hand. **Warn, never fail**: accumulated dirt is a chore, not a fault.

Division of labor: `phoebe upgrade` moves you between versions; `phoebe migrate`
reshapes your files for the version you are moving to; `phoebe doctor` tells you
whether the version you are on works. The first two compose: `upgrade` runs the
target version's `migrate` itself, before it moves the pin, so a normal upgrade
is one command. Invoke `migrate` directly to reshape without moving the pin, or
to re-run a child that was held or failed. For the per-permission token
diagnosis, doctor points at the deeper probe below.

## Checking a tenant's GitHub token

Under the PAT arm, Phoebe acts entirely as `GH_TOKEN`'s identity. When that
token is short a permission, or its org approval never landed, nothing fails at
boot. It fails mid-run as a 403 from whichever API hop needed the grant. Under
the App arm, `GH_TOKEN` is a synthesized installation token minted at startup;
org approval does not apply, but the same five permissions must be granted to the
App installation.

**Branch-protection note (both arms).** If the repo enables
`dismiss_stale_reviews_on_push` or `require_last_push_approval`, Phoebe's push
after the agent commits interacts with each one differently.
`dismiss_stale_reviews_on_push` dismisses the existing approvals outright, so the
PR needs a fresh one. `require_last_push_approval` keeps them, but requires
someone other than the last pusher to approve the newest push. Under the PAT arm
Phoebe pushes as the `GH_TOKEN` owner, so an operator who approved earlier cannot
satisfy that themselves. Under the App arm Phoebe pushes as the bot, which is a
separate identity from the operator, so a human approval still counts.

Either way this is GitHub applying its own settings, not Phoebe doing something
unusual.

`node scripts/verify-tenant-token.mjs` says which grant is missing, before
Phoebe runs.

| Invocation                                         | Verifies                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `verify-tenant-token.mjs`                          | The cwd's tenant, its `phoebe.config.ts` and its `.env`.            |
| `verify-tenant-token.mjs ./core`                   | A specific tenant directory (repeatable).                           |
| `verify-tenant-token.mjs --all`                    | Every tenant of the deployment rooted here, one section each.       |
| `verify-tenant-token.mjs --slug o/r --token ghp_…` | A token you have not written to a file yet.                         |
| `--json` / `--check`                               | Machine-readable output / exit 1 on any finding (as `phoebe list`). |

It reports each of the five permissions
[onboarding §2](phoebe-core-onboarding.md#2-operator-github-token-a-fine-grained-pat)
asks for as granted / missing / unknown, distinguishes "no access at all" (the
usual sign of a fine-grained PAT still awaiting org approval) from one missing
checkbox, and warns when the token expires inside 14 days. No probe changes
anything: the three write grants are proven by aiming a `POST`/`PATCH` at a
resource that cannot exist, so GitHub answers with the permission verdict and
there is nothing to mutate. It is safe against production, but note that it does
issue write-method requests, which matters if you are approving it through
a network policy. It never prints the token, and `--all` does not abort when one
tenant fails.

## One-off overrides without editing config

Most scalar fields have a `PHOEBE_*` env override for a single run, such as
`PHOEBE_AGENT=claude`, `PHOEBE_PR_SCOPE=all`, or `PHOEBE_POLL_INTERVAL_MS=60000`.
See the [environment overlay table](configuration.md#environment-overlay-phoebe_).

## Quick reference

| I want to…                                    | Do this                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue an issue for Phoebe                     | Add `readyLabel` (`ready-for-agent`).                                                                                                              |
| Pause a queued issue                          | Remove `readyLabel`.                                                                                                                               |
| Bump an issue up the queue                    | Word it as a bug/fix, or it waits its turn by age.                                                                                                 |
| Sequence-dependent issues                     | `Blocked by #N` in the body.                                                                                                                       |
| Land a group of issues in one merge           | Add `featureLabel` (`phoebe:feature`) to their parent issue.                                                                                       |
| Cancel a feature                              | Close its draft integration PR, then close or unlabel the members you are abandoning (`readyLabel` and `researchLabel` alike).                     |
| Take a PR away from Phoebe                    | Add `prOptOutLabel` (`ready-for-human`), which works for any PR. Under the default `draftPrs`, marking a **non-Phoebe** PR draft also opts it out. |
| Hand a PR back                                | Remove the label / mark ready-for-review.                                                                                                          |
| Force a janitor to retry                      | Push, advance the base, post new review feedback, or delete the newest failure comment.                                                            |
| Let Phoebe maintain all PRs, not just its own | `prScope: "all"`.                                                                                                                                  |

## Running many repos in one container

One container can serve several repos as **tenants**. The bootstrapper runs one
engine child per tenant and reconciles the set on every poll, with **no restart**
needed to add or remove one. The layout is **workspace**: child checkouts under a root
that declares `workspace: { depth }` (walk) or `workspace: { tenants: [...] }`
(declare). Full topology + runbook: [`workspace.md`](workspace.md).

Read [`trust.md`](trust.md) first: co-locating repos means co-locating them in
one trust domain.

| Action                            | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a repo                        | Place the checkout under the root (`git clone` / `git submodule add`), then `phoebe init --tenant <dir>` (host-side) and, on the declared arm, add the dir to `workspace.tenants` yourself. Phoebe never edits your fleet declaration; `workspace.tenants` is yours. The bootstrapper discovers it next poll. Fill in its `.env`.                                                                                                                                                                                                                                |
| Remove a repo                     | Drop the child from `workspace.tenants` and/or delete its config dir (host-side; Phoebe never edits your fleet declaration). Reversible, because the tenant's `/data` is retained and re-adding re-uses it.                                                                                                                                                                                                                                                                                                                                                      |
| Reclaim a deleted pipeline's disk | Nothing to do: the next boot, and any later row-set change, sweeps the state of rows the config no longer declares. A worktree that is dirty or holds unpushed commits is left for you, named by `phoebe doctor`'s `stale-state` check. Run `phoebe sweep-state` (in-container) to do it now.                                                                                                                                                                                                                                                                    |
| Reclaim a removed repo's disk     | `phoebe purge <owner/repo> --yes` (in-container). Destructive; refuses while a live config still claims the slug.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Apply deployment migrations       | `phoebe migrate` (host-side, in the deployment dir). Rewrites config content and scaffolds missing artifacts across root and fleet; lists uncommitted paths for you to review and commit per repo. See [`upgrading.md` → phoebe migrate](upgrading.md#phoebe-migrate-reshaping-your-files-for-the-current-ref).                                                                                                                                                                                                                                                  |
| Check every tenant's GitHub token | `node scripts/verify-tenant-token.mjs --all` (host-side, in the deployment dir). One section per tenant; `--check` exits non-zero when any is short a grant. See [Checking a tenant's GitHub token](#checking-a-tenants-github-token).                                                                                                                                                                                                                                                                                                                           |
| See every tenant + its health     | `phoebe list` (in-container): one row per tenant — config present? `.env` present? retained data? which credential arm? — and beneath it one indented line per pipeline (see below). Tenants that cannot boot show `held — <reason>`. Use `--json` for scriptable output and `--check` to exit non-zero when a declared tenant is held; declared-arm accounting, meaning `N of M`, declared order, and `undeclared` are reported but don't affect the exit code — see [`workspace.md` → Declaring the fleet](workspace.md#declaring-the-fleet-workspacetenants). |

**Reading `phoebe list`.** A tenant prints its own row — path, slug, the
config/env/data flags, its credential arm — and beneath it one indented line per
pipeline. The implicit `work` row prints like any other, and a solo deployment
prints its single tenant the same way:

```
[phoebe] 2 of 2 declared tenant(s):
  children/widget  (acme/widget)
      ✓ config  ✓ env  ✓ data  arm: pat
        work    working 1/2 issues 12
        intake  waiting for slot
        old     idle  (stale)
  children/sprocket  (acme/sprocket)
      held — missing repoSlug in phoebe.config.ts  ✓ config  ✓ env  ✓ data  arm: app
        work    idle  (from disk)
```

The row set is the one the supervisor spawns from, so `list` and the supervisor
cannot disagree about what a tenant runs. Each line's state comes from that row's
own `state/<name>/status.json` and nothing else:

- `no status` — the row exists; nothing has written a snapshot for it yet.
- `working k/N <units>` — `N` is the row's declared `concurrency`.
- `waiting for slot` — a pass picked a unit and is queued on the fleet cap.
- `idle`.
- `wedged? <age>` beside a working row whose oldest unit has been running
  longer than its own run budget plus one poll interval.

`wedged?` is a question, not a verdict: `list` reads files, not processes. An
idle row is never wedged however long it has been idle, and rows are never
weighed against each other — a row that polls every 15 minutes is not sick for
being quieter than the one beside it.

`(stale)` marks a `state/<name>/` directory this tenant's config no longer
declares: a renamed or deleted pipeline whose snapshot outlived it. It is
reported, never acted on, and it does not affect `--check`. A held tenant is one
whose config could not be read, so there is no row set to ask for — `list` shows
the snapshots that are on disk and marks each one `(from disk)`.

**Stopping one pipeline.** There is no per-pipeline stop verb yet. Setting
`disabled: true` on that row in the tenant's `phoebe.config.ts` is hot at the
row scope — the supervisor picks up the edit without relaunching anything, and
the row lists as `(disabled)` — but nothing acts on it: the supervisor does not
stop the row, and the flag is display-only for now, recording operator intent.
To actually stop work today, use the off-switch that bites: per kind
(`pipelines.<row>.kinds.<kind>.disabled: true`), which takes each of the row's
kinds out of rotation. Stopping the whole tenant is `disabled: true` at the top
level of its config.

**Concurrency across tenants.** One bootstrapper-brokered cap decides how many
work units execute at once across the whole container, so N repos don't thrash
the host. It defaults to the largest `concurrency` any live row declares — 1
unless a row asks for more — and `PHOEBE_MAX_CONCURRENT_AGENTS` replaces that,
even when lower. Rows queue for it, tenants take turns, and a row starved of a
slot may hold one over the cap (`PHOEBE_SLOT_FLOOR_BUDGET`, default 1), so the
worst case is the cap plus that budget. Boot prints both numbers and their
derivation on one line. Idle polling stays per-row and parallel. The knobs are
in [`configuration.md`](configuration.md#concurrency-the-rows-knob-and-the-fleets-cap).

**Reading the logs.** Every engine line is tagged
`[phoebe:<owner>/<repo>:<pipeline>]` — the pipeline row included, and the
implicit `work` row is tagged like any other. The bootstrapper's own lines are
tagged `[phoebe]`. A host log collector matching the tenant tag should match it
as a **prefix**: a parser pinned to the exact old `[phoebe:<owner>/<repo>]`
string stops matching. Agent output uses the combined bracket
`[<owner>/<repo>:<command>]` (e.g. `[JesusFilm/phoebe:cursor]`) so agent lines
stay visually distinct from unit-event lines. stderr lines add a further suffix:
`[<owner>/<repo>:<command>:stderr]`.
The container writes no log files. Stdout is the whole story.

**Which unit said it.** Anything produced on behalf of one work unit adds a
second bracket naming it: `[phoebe:<owner>/<repo>:<row>][<kind> <ref>]` on a
kind's own logging and on the git and install output its children produce, and
`[<owner>/<repo>:<command>][<kind> <ref>]` on the agent's. It is there whatever
the row's `concurrency`, so `[issues issue:88]` greps one unit's whole story —
its clone traffic, its install, its agent — out of a row running several.

**When a unit hangs.** A work unit that exceeds its wall-clock budget
(`PHOEBE_RUN_TIMEOUT_MS`, default 45 min) is aborted so it can't starve the
fleet, and the engine moves on. A unit that hangs **every** time is quarantined
after `PHOEBE_MAX_UNIT_TIMEOUTS` (default 3) consecutive timeouts: Phoebe applies
a `phoebe:quarantined` label and posts one escalation comment asking for a human.

There are two ways out, and both give the unit a **fresh** allowance of
`PHOEBE_MAX_UNIT_TIMEOUTS` timeouts, not a single retry:

- **Change the content.** Push to the PR, or edit the issue body. Each cycle
  Phoebe sweeps the quarantined units and compares them against the baseline
  recorded in the escalation comment, either the PR's head SHA or a fingerprint of
  the issue body. When that has moved, Phoebe removes the label itself and says so in
  a comment. A bare comment or reaction does **not** count: it can't re-arm a unit
  nobody has actually fixed.
- **Remove the label by hand.** Phoebe treats that as a deliberate "try again"
  and starts the timeout count over.

Phoebe only ever auto-removes a label it applied itself (it looks for its own
escalation comment first), so a `phoebe:quarantined` you add by hand stays until
you take it off.

</content>
