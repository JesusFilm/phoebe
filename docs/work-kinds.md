# Work kinds

**Who this is for:** anyone asking why Phoebe picked the unit it picked. It
answers how each of the five kinds selects and executes one unit.

Every cycle Phoebe walks `config.workOrder` and runs **one** unit of the first
kind that has workable work. There are five kinds: three **janitors** that keep
open PRs moving (`conflicts`, `checks`, `reviews`) and two **producers** that
start new work (`issues`, and `research` for wayfinder research tickets). This
file documents how each selects and executes a unit. Field references point at
[`configuration.md`](configuration.md); the runtime plumbing is
`src/orchestrator.ts` and `src/main.ts`.

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

Only PRs whose base is `defaultBranch` are listed.

## `issues`, start new work

The producer. Selection (`selectIssue`):

1. List open issues labelled `readyLabel`, oldest-created first.
2. Sort by **priority** then age then number. Priority is inferred from the
   title + body text: `bug` (bug/broken/crash/regression/fix) → `tracer`
   (tracer/wire/poc) → `polish` (default) → `refactor`.
3. For each candidate in order, resolve a worktree base; take the first issue
   that resolves.

**Base resolution** (`resolveWorktreeBase`) handles blockers:

- `PHOEBE_BASE` set → use it verbatim (escape hatch, no blocker logic).
- No `Blocked by #N` reference → base `origin/main`.
- Blocked, blocker PR **open** → **stack** on `origin/<blocker branch>`; the
  opened PR targets the blocker's branch and is added to the blocker's native
  GitHub stack (created if the blocker has none), so merge ordering and
  post-merge rebase/retarget are GitHub's job. When the Stacks API is
  unavailable (it is a public preview), the PR is retargeted to the default
  branch instead and gets a ⛓️ banner comment warning not to merge before the
  blocker.
- Blocked, blocker PR **merged** → base `origin/main` (blocker work is already
  in the base).
- Blocked, no blocker PR either way, but the blocker **issue is closed as
  completed** → base `origin/main`, unstacked. The work landed outside
  `branchPrefix` (a human's branch, another tool's) and who built it is not
  Phoebe's business. The `gh issue view` that answers this fires only when both
  PR lookups come back empty. Closed as **not planned** does not count, because
  an abandoned blocker leaves the dependent on unbuilt ground.
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
   (`stackPrOnto`). On the fallback path, only a PR Phoebe created this run is
   retargeted and gets the banner comment; a pre-existing PR (an earlier
   cycle's, or one the agent opened against the default branch itself) is left
   as it was.

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
happen inside the prompt. Disable the kind for a repo by omitting `research` from
`workOrder`.

## `conflicts`, reconcile PRs that conflict with the base

Selection (`selectFirstWorkUnit`, via `selectConflictFixCandidates` → oldest
eligible PR number):

1. Scan in-scope open PRs; a PR is a candidate when `mergeable` is
   `CONFLICTING`, or `UNKNOWN` while `mergeStateStatus` is `DIRTY` (GitHub may
   still be computing mergeability, so the engine retries a few times).
2. Skip PRs whose issue is **stacked on an open blocker**, where divergence from
   the base is expected rather than a real conflict.
3. Skip PRs whose latest **failure watermark** matches the current PR head _and_
   base head. A prior fix attempt already failed against this exact pair, so
   retrying would loop until either side moves.

**Execution** (`fixOnePrConflict`):

1. Compute merged-blocker PR numbers for stacked catch-up (bottom-up order).
   This is the fallback path's machinery: a natively stacked PR is rebased and
   retargeted by GitHub when its blocker merges, so it rarely reaches here —
   and when it later falls behind, the blocker-head merges are no-ops or
   content-identical merges.
2. Try a **clean, agent-free merge** first: merge each merged-blocker PR head,
   then `origin/<defaultBranch>`, and push. If it succeeds, done (a stacked
   catch-up posts a retraction comment noting the branch is now independently
   mergeable).
3. If the clean merge conflicts, hand off to the agent with the `conflict`
   prompt (worktree pre-staged with the attempted merge; `BLOCKER_PR_NUMBERS`
   supplied). The agent resolves, verifies, and pushes.
4. If neither the agent nor the merge produced commits and the PR still
   conflicts, post a failure comment carrying a fresh watermark
   (`prHead` + `mainHead`) and leave the branch untouched for a human.

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

1. If the PR is `BEHIND` the base, try a clean catch-up merge first (including
   merged-blocker PRs); if that conflicts, defer to the `conflicts` kind next
   cycle.
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

</content>
