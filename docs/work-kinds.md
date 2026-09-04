# Work kinds

**Who this is for:** anyone asking why Phoebe picked the unit it picked — and,
at the end, anyone writing a kind of their own. It answers how each of the five
built-in kinds selects and executes one unit, then documents the contract every
kind (built-in or custom) implements.

Every cycle Phoebe walks `config.workOrder` and runs **one** unit of the first
kind that has workable work. A kind is one registered **definition** — name,
prompt, eligibility, reporting, and a `fetch`/`select`/`run` triple. Five ship
built-in: three **janitors** that keep open PRs moving (`conflicts`, `checks`,
`reviews`) and two **producers** that start new work (`issues`, and `research`
for wayfinder research tickets); a tenant may register more under
[`workKinds.custom`](configuration.md#workkinds) (see
[Writing your own kind](#writing-your-own-kind)). This file documents how each
built-in selects and executes a unit. Field references point at
[`configuration.md`](configuration.md); the runtime plumbing is
`src/work-kinds/`, `src/orchestrator.ts` and `src/main.ts`.

## The poll loop and `workOrder`

```yaml
workOrder: ["conflicts", "checks", "reviews", "issues", "research"] # default
```

Each cycle the engine gathers work data for every kind, then
`selectFirstWorkUnit` returns the first kind (in `workOrder` order) that yields a
unit. Order is priority: with the default, a conflicting PR is reconciled before
a red-CI PR, which is handled before review feedback, which is handled before a
brand-new issue is picked up, which is handled before a research ticket. That
keeps already-open work flowing rather than piling up new branches.

Priority is all it is. A kind left out of the order still runs, after the named
ones; taking one out of rotation is `disabled: true` on its tuning block. The
field itself is now the deprecated alias for `pipelines.work.order`. See
[`configuration.md` → Pipelines](configuration.md#pipelines).

- **Persistent mode** (no flags) runs all kinds and sleeps
  `PHOEBE_POLL_INTERVAL_MS` (default 300000) between empty cycles.
- **`--run-once`** works at most one unit of the first _one-shot-eligible_ kind
  and exits. `issues` and `research` are one-shot-eligible; the three janitor
  kinds are **persistent-mode only**. Under `--run-once` with nothing to work,
  Phoebe prints "Nothing to do" and exits.
- **`--dry-run`** prints the unit it would pick without executing (host-safe).

A failed unit in persistent mode is logged and skipped; the engine continues to
the next cycle. Under `--run-once`, a failure throws.

## Which PRs the janitors scan

All three janitors scan open PRs based on the same scope rules (`isPrInScope`):

1. **Cross-repository PRs (forks) are always excluded.**
2. PRs carrying `prOptOutLabel` (default `ready-for-human`) are excluded.
3. If `prScope` is `"phoebe"`, only `branchPrefix` branches qualify; `"all"`
   admits any same-repo PR.
4. Drafts are filtered by `draftPrs`: `skip-all` drops every draft;
   `skip-non-phoebe` drops drafts on non-Phoebe branches; `include` keeps them.

PRs are listed once per base: `defaultBranch`, plus the branch of every live
feature ([#341](https://github.com/JesusFilm/phoebe/issues/341)). A member PR
targets its feature branch, so this is what puts it in front of the janitors —
without it a red member PR sits red and the feature stalls without a word. A
feature retires when its integration PR merges or closes, and `prOptOutLabel` on
that PR takes the whole feature out of scope; either way it contributes no
listing.

## `issues`, start new work

The producer. Selection (`selectIssue`):

1. List open issues labelled `readyLabel`, oldest-created first.
2. Sort by **priority** then age then number. Priority is inferred from the
   title + body text: `bug` (bug/broken/crash/regression/fix) → `tracer`
   (tracer/wire/poc) → `polish` (default) → `refactor`.
3. For each candidate in order, resolve a worktree base; take the first issue
   that resolves.

A base has three arms: the default branch, a blocker's branch when the work
stacks, and a feature's integration branch when the issue belongs to a live
feature. The third one is more than a base. Its opt-in label, who counts as a
member, the integration PR, how member issues close, and how a feature is
cancelled are [`feature-branches.md`](feature-branches.md).

**Base resolution** (`resolveWorktreeBase`) handles blockers and feature
membership together:

- `PHOEBE_BASE` set → use it verbatim (escape hatch, no blocker logic).
- No `Blocked by #N` reference → base `origin/main`, or `origin/<feature branch>`
  when the issue belongs to a live feature
  ([#341](https://github.com/JesusFilm/phoebe/issues/341)).
- Blocked by an issue on the **same side** of the feature boundary — both
  members of one feature, or neither in a feature — with the blocker PR
  **open** → **stack** on `origin/<blocker branch>`; the opened PR targets the
  blocker's branch and is added to the blocker's native GitHub stack (created if
  the blocker has none), so merge ordering and post-merge rebase/retarget are
  GitHub's job. Inside a feature the stack's floor is the feature branch rather
  than the default one: the bottom layer is the blocker's own PR, which already
  targets it. When the Stacks API is unavailable (it is a public preview), the PR
  gets a ⛓️ banner comment warning not to merge before the blocker, and is
  retargeted to the default branch — except for a member, whose base is left
  alone. Retargeting a member would take its work off the feature branch, which
  is the point of the whole arm
  ([#383](https://github.com/JesusFilm/phoebe/issues/383)).
- Blocked **across a feature's boundary** → **skip** this cycle; the idle log
  names the blocker. Neither side can stack on the other, because the two
  branches are bound for different places. A member blocked by an outsider waits
  for that PR to merge into the default branch, after which the
  [catch-up](#the-feature-branch-catch-up) carries the work onto the feature
  branch and the member proceeds normally. An outsider blocked by a member waits
  for the feature itself: a member's work reaches the default branch only when
  the integration PR merges.
- Blocked, blocker PR **merged** → base `origin/main`, or the feature branch for
  a member (the blocker work is already in the base, or on its way there via the
  catch-up).
- Blocked, no blocker PR either way, but the blocker **issue is closed as
  completed** → the same base as a merged blocker, unstacked. The work landed
  outside `branchPrefix` (a human's branch, another tool's) and who built it is
  not Phoebe's business. The `gh issue view` that answers this fires only when
  both PR lookups come back empty. Closed as **not planned** does not count,
  because an abandoned blocker leaves the dependent on unbuilt ground.
- Blocked, blocker has **no** open or merged PR and is not closed as completed →
  **skip** this cycle. The idle log names the blockers it is waiting on.

Blocker references are parsed with `blockedByPattern` (capture group 1 = blocker
issue number).

**Execution** (`runOneIssue`):

1. Create branch `<branchPrefix>issue-<n>` off the resolved base in a worktree.
2. Run `installCommand`, then the agent with the `issue` prompt
   (`{{ISSUE_NUMBER}}` supplied).
3. Count commits since the base. If zero, no PR is created.
4. With `creditIssueAuthor` (default on), stamp those commits with a
   `Co-authored-by:` trailer for the issue's author. See
   [`configuration.md`](configuration.md#issue-author-credit).
5. Push. If no open PR exists for the branch, open one titled
   `Phoebe: <issue title> (#<n>)` with body `Closes #<n>` (plus a "stacked on"
   note when applicable); otherwise post a follow-up note.
6. For stacked work, put the PR into the blocker PR's native stack
   (`stackPrOnto`): join the blocker's stack when the blocker is its top open
   layer, found a stack when it has none. When the PR cannot be stacked — the
   preview API is absent, or the blocker is buried under another layer — post
   the ⛓️ banner comment (once) and retarget the PR onto the default branch. A
   feature member gets the banner and keeps its base: it waits on its blocker,
   and GitHub carries it onto the feature branch when that blocker merges.

The issue prompt has the agent claim the issue first, swapping `readyLabel` for
`processingLabel`, so parallel operators and humans see it is in flight.

## `research`, resolve wayfinder research tickets

The second producer. It picks up wayfinder research tickets, meaning open issues
labelled `researchLabel` (default `wayfinder:research`), which in wayfinder are
child issues of a `wayfinder:map`. The engine keys off the label alone, not the
parent-map relationship. It then follows
[wayfinder's](../.agents/skills/wayfinder/SKILL.md) resolution protocol:
investigate primary sources, produce a Markdown summary, post a resolution
comment, close the ticket, and append a pointer to the map's _Decisions so far_.

Selection **reuses the `issues` path** (`selectIssue`) against the
`researchLabel`-tagged open issues rather than the `readyLabel` set: same
priority/age ordering, same `Blocked by #N` handling and base resolution
(blocked tickets with no blocker PR are skipped this cycle). It is _not_ full
wayfinder-native selection. There is no querying of map children, no GitHub
native `blocked-by`, and no assignment-as-claim. Those are follow-ups. Double-work
avoidance relies on branch/PR existence, same as `issues`.

This kind was built against wayfinder's protocol on purpose: research tickets are
the part of planning that is itself AFK-able. The coupling stops at the label,
though, and the default is only a default. See
[`preparing-work.md`](preparing-work.md) for the pipeline this sits at the end of.

**Execution** reuses `runOneIssue` with the `research` prompt: branch off the
resolved base, run the agent, and push and open a PR, but **only when the agent
left commits**. The output shape is adaptive, decided by the prompt rather than
the engine:

- **Issue-level artifact (default):** the prompt posts the summary/answer as a
  comment, closes the ticket, and updates the map. No commits → no PR.
- **Committed doc (PR):** when the finding naturally belongs in the repo, the
  prompt writes and commits the doc; the engine pushes and opens a PR whose body
  closes the ticket on merge.

The engine stays map-agnostic. It only selects the ticket, allocates the
worktree, and runs the prompt. The resolution comment, close, and map update all
happen inside the prompt. Disable the kind for a repo with
`research: { disabled: true }` on its tuning block.

## `conflicts`, reconcile PRs that conflict with the base

Selection (`selectFirstWorkUnit`, via `selectConflictFixCandidates` → oldest
eligible PR number):

1. Scan in-scope open PRs; a PR is a candidate when `mergeable` is
   `CONFLICTING`, or `UNKNOWN` while `mergeStateStatus` is `DIRTY` (GitHub may
   still be computing mergeability, so the engine retries a few times).
2. A feature's **integration PR** is a candidate on a different test: whether
   `defaultBranch` carries commits its branch does not
   ([#341](https://github.com/JesusFilm/phoebe/issues/341)). See
   [the feature-branch catch-up](#the-feature-branch-catch-up) below.
3. Skip PRs whose issue is **stacked on an open blocker**, where divergence from
   the base is expected rather than a real conflict.
4. Skip PRs whose latest **failure watermark** matches the current PR head _and_
   base head. A prior fix attempt already failed against this exact pair, so
   retrying would loop until either side moves.

**Execution** (`fixOnePrConflict`):

1. Compute merged-blocker PR numbers for stacked catch-up (bottom-up order).
   This is the fallback path's machinery: a natively stacked PR is rebased and
   retargeted by GitHub when its blocker merges, so it rarely reaches here.
   When one does (later divergence, and a blocker that was squash-merged), the
   blocker-head merge can itself conflict — which lands in the agent's lap like
   any other conflict, one step later than it needed to be.
2. Try a **clean, agent-free merge** first: merge each merged-blocker PR head,
   then the PR's **own base** (`origin/<baseRefName>`), and push. If it
   succeeds, done (a stacked catch-up posts a retraction comment noting the
   branch is now independently mergeable). The base is `defaultBranch` for an
   ordinary PR and for an integration PR; for a feature **member** it is the
   feature branch, which is the merge GitHub was reporting a conflict against
   ([#392](https://github.com/JesusFilm/phoebe/issues/392)). Merging
   `defaultBranch` there would resolve a different merge and push commits the
   member's reviewer never asked for.
3. If the clean merge conflicts, hand off to the agent with the `conflict`
   prompt (worktree pre-staged with the attempted merge; `BLOCKER_PR_NUMBERS`
   and `BASE_BRANCH` supplied). The agent resolves, verifies, and pushes.
4. If neither the agent nor the merge produced commits and the PR still
   conflicts, post a failure comment carrying a fresh watermark
   (`prHead` + `mainHead`) and leave the branch untouched for a human.

### The feature-branch catch-up

A feature branch is long-lived by construction — it exists because its members
are not landing on `defaultBranch` one at a time. So `defaultBranch` moves under
it, and a branch that has merely fallen behind conflicts with nothing yet:
nothing in a mergeability read would ever nominate it. Left alone it drifts
until the PR a human opens at the end of the feature is a conflict pile instead
of a review.

`conflicts` therefore selects a feature's integration PR whenever
`origin/<defaultBranch>` carries commits its branch does not, and then works it
down the ordinary execution path above: the clean merge first, the `conflict`
prompt when that dirties, the `prHead` + `mainHead` watermark when neither
resolves it. A caught-up branch is zero commits behind, so it drops out of the
listing the moment the merge lands.

`featureBranchCatchUp: false` retires the catch-up tenant-wide.
`prOptOutLabel` (default `ready-for-human`) on one integration PR takes that
feature out of janitor scope entirely, members included — which is why the
config knob is global-only. And the integration PR is a draft, so a tenant on
`draftPrs: "skip-all"` never sees it and gets no catch-up whatever the knob
says.

## `checks`, fix failing CI

Check state comes from the REST Actions API (`gh run list`), not GraphQL
`statusCheckRollup`, because fine-grained PATs cannot read the rollup. (The App
arm does not share this limitation, but Phoebe uses REST regardless, keeping one
code path for both credential arms.) Only the
newest run per workflow counts; a rollup is `FAILURE` only when at least one
check failed and **none are pending**.

Selection (`selectFirstWorkUnit`, via `selectChecksCandidates` → oldest eligible
PR number):

1. Scan in-scope open PRs; candidate when the combined rollup is `FAILURE`.
2. Skip conflicting PRs (those belong to `conflicts`).
3. Skip stacked-on-open-blocker PRs and watermarked PRs (`prHead` unchanged
   since the last failed attempt).

**Execution** (`fixOnePrChecks`):

1. If the PR is `BEHIND` the base, try a clean catch-up merge against that base
   first (including merged-blocker PRs); if that conflicts, defer to the
   `conflicts` kind next cycle.
2. Otherwise run the agent with the `checks` prompt; the formatted list of
   failing checks is passed as `{{FAILING_CHECKS}}`.
3. Push new commits. If the agent produced nothing and origin is unchanged, post
   a failure comment with a `prHead` watermark.

## `reviews`, address review-thread feedback

Selection (`selectFirstWorkUnit`, via `selectReviewsCandidates` → oldest eligible
PR number). This kind needs the
bot's own GitHub login (`phoebeLogin`), fetched once per cycle:

1. Scan in-scope open PRs, page through all `reviewThreads`.
2. A PR qualifies when it has **new, unresolved, non-outdated** thread activity
   from someone **other than Phoebe and other than the PR author**, newer than
   the PR's `handled` watermark.
3. Skip conflicting PRs and stacked-on-open-blocker PRs.
4. A feature's **integration PR is never a unit here**. Review activity on it is
   a human reviewing the whole feature, so Phoebe answering it would be Phoebe
   reviewing the human's review of Phoebe. `conflicts` and `checks` still work
   it.

**Execution** (`fixOnePrReviews`):

1. Run the agent with the `reviews` prompt. It triages every unresolved thread,
   makes code changes where needed, and posts a summary comment containing
   `reviewsSuccessHeading`.
2. Push new commits (or detect the agent already pushed).
3. Post a `handled` watermark comment stamped with the newest activity time from
   the **pre-run** snapshot, so feedback posted _during_ the run is not marked
   handled and correctly re-selects the PR next cycle. If the agent produced no
   summary and no push, the comment notes the failure and Phoebe retries on new
   activity.

## Watermarks

Janitors record their progress as **hidden HTML-comment markers** on the PR so
state survives across engine restarts (nothing is kept in memory between
cycles). The parser reads comments newest-first and takes the first marker it
finds, so the latest matching marker wins when several exist. Deleting the newest
one falls back to the next-newest rather than to a clean slate. To reset state,
move whatever the marker is keyed on (see the table below) or remove the newest
matching comment. See [`operating.md`](operating.md#watermark-comments) for the
operator's view.

| Kind        | Marker                   | Keyed on                    | Effect                                                |
| ----------- | ------------------------ | --------------------------- | ----------------------------------------------------- |
| `conflicts` | `phoebe-conflict-fail`   | `prHead` + `mainHead`       | Skip re-fixing until either the PR or the base moves. |
| `checks`    | `phoebe-checks-fail`     | `prHead`                    | Skip re-fixing until the PR head moves.               |
| `reviews`   | `phoebe-reviews-handled` | `latest` activity timestamp | Only re-run on review activity newer than this.       |

## Writing your own kind

A custom kind is authored code implementing the same contract as the five
built-ins, declared under `workKinds.custom.<name>` (field syntax and the
declaration arms live in [`configuration.md` → workKinds](configuration.md#workkinds)).
After boot-time registration the engine cannot tell a built-in from a custom
kind: `workOrder`, `workKinds` tuning blocks, `PHOEBE_<KIND>_*` env vars
(hyphens in the name become underscores), quarantine, concurrency slots, the
run deadline, and the prompt-existence check all apply uniformly.

The run deadline wraps your whole `run`, not just the agent spawn. When the
budget expires, the engine races the deadline against `definition.run`,
propagates `RunTimeoutError`, releases the concurrency slot, and counts the
timeout toward quarantine — regardless of where in `run` execution is. Your
`run` receives `ctx.signal`, an `AbortSignal` that fires on expiry; a
cooperative kind passes it to async operations (network calls, `sleep` loops)
or polls `signal.aborted` to stop early. The engine races the deadline
regardless, so an uncooperative `run` still hits the same accounting path — it
just keeps executing as an orphan until it finishes or errors on its own.

A kind is ordinary code in the engine process — nothing sandboxes it, and the
`ctx` surface is an ergonomics contract, not a capability boundary.
Registering one is the same trust decision as editing the config itself:
see [`trust.md` → The config is code](trust.md#the-config-is-code).

Start from [`examples/custom-kind/`](../examples/custom-kind/) — a full-form
kind (a stale-PR nudger) beside the inline prompt-only-producer cheap case.
Copy-from-example is the supported path; there is no scaffold command.

### The definition object

```ts
import type { WorkKindDefinition } from "phoebe-agent";

type Gathered = /* whatever your fetch collects */;
type Unit = { ref: string; github?: { objectType: "issue" | "pr"; id: number }; /* … */ };

export default {
  name: "my-kind",              // must match the workKinds.custom key
  oneShotEligible: false,       // may a unit run under --run-once?
  promptFile: "prompts/my-kind-prompt.md",
  workspace: "worktree",        // or "scratch" / "readonly" — modes below
  model: "…", effort: "…",      // optional agent defaults (see tuning below)
  report: {
    noun: "…(s)",               // idle-report noun
    describe: (unit) => "…",    // one line naming a unit in logs
  },
  async fetch(ctx) { /* gather this cycle's candidates */ },
  select(gathered, ctx) { /* { unit, skipped, total } */ },
  async run(unit, ctx) { /* work the unit; throw = failure */ },
} satisfies WorkKindDefinition<Gathered, Unit>;
```

A module may instead default-export a factory `(config) => definition` — the
shape the built-ins themselves use — to bake resolved-config values in.

**Fetch** gathers everything `select` will need; its return value is opaque to
the engine and handed back to your `select` (and only yours). Per-unit read
failures should be absorbed (warn and drop the candidate); a _thrown_ fetch
kills the whole cycle, and the bootstrapper's restart loop is the recovery.
**Select** must be pure over the gathered data plus the cycle services — the
engine gathers every kind before selecting any, so a select that re-fetches
would see a different world than its neighbours (`select` receives `ctx`, but
must not touch `ctx.github`). **Run** owns every consequence of the unit —
pushes, comments, watermarks; the engine's interest is limited to success
(return) vs. failure (throw), the run deadline, and quarantine accounting.

### The unit and its `ref`

Units are kind-defined payloads with one structural obligation: a `ref` string
— non-empty, single-line, stable across cycles for the same logical unit, and
unique within the kind. Every engine consumer (quarantine, logs, status
snapshots, idle reports) keys `(kind, ref)`; nothing ever parses a ref.
Built-ins use `pr:123` / `issue:88` as convention. The optional `github` field
is the timeout-escalation target: with it set, a unit that repeatedly times out
gets the timeout marker, the `phoebe:quarantined` label and the escalation
comment exactly like a built-in unit; without it, timeouts are counted in
memory only and the engine logs that the unit has no escalation surface.

### The `ctx` surface

Kind code can never import the engine — configs and kind modules load from a
container mount with no reachable `node_modules`, so value imports cannot
resolve. Everything arrives on `ctx` (types via `import type` from
`phoebe-agent`):

- `ctx.kind` — this kind's registered name.
- `ctx.config` — the full resolved config, read-only. A kind is trusted as the
  tenant; depend on what you need, sparingly.
- `ctx.options` — the `options` object from a `{ module, options }` declaration
  (`unknown`; validate it yourself). Inline definitions close over their values
  instead.
- `ctx.env` — the engine's environment, credentials included (`GH_TOKEN`, the
  provider key). A kind is trusted with them. Custom knobs ride the tenant
  `.env`.
- `ctx.github` — the cycle-scoped GitHub client (memoized `openPrs`/`mergeInfo`
  per cycle) plus the always-fresh `currentMergeInfo` for post-run re-checks.
- `ctx.origin` — read-only views of the private clone: `fetch()` and
  `branchHead(branch)` for watermark snapshots.
- `ctx.cycle` — the shared stack facility: `issueBody(n)` (cycle-cached; `null`
  means unreadable — drop that candidate), `registerIssues(issues)` (feed the
  blocker index during fetch), `blockerStates()` (read it during select).
- `ctx.clock` — `now()` / `sleep(ms)`, injected so time is testable.
- `ctx.log(message)` — logs with the uniform `[phoebe][<kind> <ref>]` prefix.

`run` receives the same surface widened with:

- `ctx.workspace` — `{ mode, dir }`: the workspace your definition's
  `workspace` field asked for, prepared and removed by the engine, and the
  default cwd for a bare `ctx.agent.run(...)`. Three modes:
  - `"worktree"` — a git worktree of the default branch, off the tenant's
    private clone, on the engine-named `<branchPrefix>workspace` branch. Repo
    context, and a branch to commit on.
  - `"scratch"` — one empty directory: no clone, no branch, no git state. What
    a kind that only needs somewhere to write files wants — drafts, a generated
    report, a fetch-and-transform pass — without the cost and the branch
    semantics of a checkout. Nothing stops a `"scratch"` kind from reaching git
    through `ctx.agent.prWorkflow` / `issueWorkflow`, which build their own
    branch-specific worktrees; the field governs the workspace the _engine_
    prepares, not what your kind may do.
  - `"readonly"` — the same worktree, _detached_ at the default branch. Repo
    context and no branch: nothing is created or moved in the clone, and a bare
    `git push` fails for want of a refspec. What a kind that reads the repo and
    publishes elsewhere wants — an audit that files issues, a summary posted to
    a channel. Read [The don't-push contract](#the-dont-push-contract) for what
    the mode does and does not promise.

  Every mode is created the first time `dir` is read, so a kind that builds its
  own worktrees (as all five built-ins do) never pays for one, and a kind that
  never reads `ctx.workspace.dir` never gets a directory.

- `ctx.signal` — an `AbortSignal` that fires when the unit's wall-clock budget
  expires. Pass it to async operations (fetch, sleep, agent helpers) or poll
  `signal.aborted` to stop early and let the slot release cleanly. The engine
  races the deadline regardless, so honouring the signal is cooperative rather
  than required.
- `ctx.agent` — the sanctioned agent machinery: `run` (the low-level spawn:
  provider ladder, prompt render, and env allowlist are engine-fixed; you supply
  `promptArgs` and optionally a `promptFile` override), the two skeletons the
  built-ins share — `prWorkflow` (the PR-fix shape) and `issueWorkflow` (the
  issue-producer shape; a prompt-only producer is a kind whose `run` is one
  call to it) — and `cleanMerge` (the no-agent catch-up merge). Both merge
  helpers take the branch to catch up _with_: `cleanMerge`'s third argument and
  `prWorkflow`'s `baseBranch`, each defaulting to `defaultBranch`. Pass the
  PR's own base. Each helper passes `ctx.signal` to the agent subprocess
  automatically.

### The don't-push contract

`"readonly"` is a shape, not a guard. Your kind gets `ctx.env` with the GitHub
token in it, because a kind is trusted as the tenant. An engine that then tried
to stop a determined kind from pushing would be theatre. So the mode covers
accident instead, and it covers it by leaving nothing around to push. The
worktree is detached, no branch is created or moved in the clone, and `git push`
with no refspec fails on the spot.

The engine makes one check, at the unit boundary. A readonly tree left dirty or
carrying commits is about to be deleted, so the engine warns as it deletes it:

```
[phoebe] my-kind: the readonly workspace was modified (2 changed file(s), 0 commit(s))
and is being discarded with the unit. A kind that means to publish should build its own
worktree through ctx.agent.
```

That reports work being lost. It is not a refusal, and the unit still succeeds.
If your kind means to publish, declare `"scratch"` or `"worktree"` and go
through `ctx.agent.prWorkflow` / `issueWorkflow`, which build their own
branch-specific worktrees and own the push.

### Reporting

`report.noun` names your units in the idle report; skip reasons returned from
`select` are free strings rendered verbatim as
`"<count> <noun> skipped (<reason>)"`. When your kind had units and selected
none, the engine renders `"<total> <noun> but none workable this cycle."` —
supply `report.idle` to override that line. `report.describe(unit)` is the
one-line name used in logs and `--dry-run` output.

### Names, prompts, and tuning

- **Names** are lowercase `[a-z][a-z0-9-]*`, at most 32 characters. The five
  built-in names and `custom` are reserved; colliding with a built-in is a boot
  error (overriding built-ins is not supported).
- **`promptFile` resolves against the runtime root**, exactly like the
  built-ins' prompts, and joins the boot-time existence check when the kind is
  scheduled. Note the wart: _module_ paths in `workKinds.custom` resolve
  against the config file's directory, prompt paths against the runtime root —
  in a `configDir` deployment those differ.
- **`model` / `effort` defaults** on the definition sit at the repo-defaults
  rung of the resolution ladder: per-kind env → the kind's `workKinds` block →
  global env → definition defaults → repo defaults. Like a providerless block,
  definition defaults stay silent when an env flip moves the run off the
  default provider.
- **Editing a kind module requires a restart**: the reconcile watch fingerprints
  the config file only, so it does not see kind-module edits.

### The edges are edges

Three capabilities are still deliberately absent, each a named extension point
with a designed attachment — not an oversight. The design record is
[`docs/research/slack-responder-sketch.md`](research/slack-responder-sketch.md):
kind-declared credentials (`requiredEnv` punching kind-scoped holes in the
agent env allowlist), non-GitHub work sources (already possible by construction
— your fetch may call anything reachable; ctx owes it no HTTP convenience), and
a kind-extended agent tool surface (kind-declared MCP servers).

A fourth has landed, in both halves. `"scratch"` is the sketch's
plain-directory mode, shipped under a name that admits there is still a
directory. `"readonly"` is the worktree half, and the don't-push contract turned
out to be a detached checkout plus a warning rather than a promise or a guard.
See [The don't-push contract](#the-dont-push-contract).
