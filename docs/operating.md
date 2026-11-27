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

Every lever here is a label on GitHub or a command at a shell. If you have
neither, [`console.md`](console.md) is the other way in: a desktop companion
that reads the same deployment report this page renders, and drives local
installs through the same host verbs.

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
hand. Each of those automatic re-arms counts as an unproductive run against the
issue, and `maxUnproductiveRuns` of them in a row (default 3) quarantines it, so
a claim that keeps dying before any PR exists ends up in front of a human instead
of looping — same label, same ways out as [a unit that
hangs](#running-many-repos-in-one-container).

**Label ownership.** `readyLabel` is yours to apply and remove; `processingLabel`
is Phoebe's. To pause a queued issue, remove `readyLabel`. Applying
`processingLabel` by hand is not a pause — the sweep will treat it as a stale
claim and remove it.

When an agent identifies a blocker, it records `Blocked by #N` in the issue body
and exits. The `blockedByPattern` section below describes how the engine reads
that and what happens next.

### `phoebe:blocked` means "waiting on you"

Sometimes a run stops because a person has to do something first. A research
Question may need a decision, or the agent can't reach a source, or the issue
leaves out context only you have. The agent says so in a comment and ends that
comment with a `<!-- phoebe-blocked -->` line. On the next sweep the engine sees
the line and swaps `processingLabel` for `phoebe:blocked`. It then posts a short
comment of its own and leaves the ticket out of selection. That run does not
count toward `maxUnproductiveRuns`.

Do what the agent's comment asks, then **remove `phoebe:blocked`**. The ticket
goes straight back in the queue. Nothing else clears the label, including a
reply on the issue, because only you know when the answer is complete. The
engine only reads the marker in Phoebe's own comments, so pasting the line into
a comment does not block a ticket.

The agent leaves the line out when a retry could get through without anyone
acting, such as a flaky test or a service that is down. Those runs are re-armed
and counted as usual.

The agent also uses the line when the work is already on the default branch,
which happens when someone fixes a ticket by hand and the PR never says
`Fixes #N`. Its comment names the commit or PR that did the work and what it
checked. Close the issue if you agree. If you don't, say what is still missing
and remove `phoebe:blocked`.

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
branch and closes the member issues. Between the two merges the member issue
wears `mergedLabel` (`merged-to-feature`) in place of `processingLabel` — done,
not in flight, and never picked up again; the whole arc is in
[`feature-branches.md`](feature-branches.md#what-a-member-issue-looks-like-once-it-lands).

The label is yours, like `readyLabel`. Phoebe never applies it and never treats a
parent issue as a feature without it.

**To cancel a feature, close its draft integration PR.** Phoebe stops routing
anything onto the branch. It does not delete the branch, and it does not touch
member PRs that are already open. Any member still carrying a label Phoebe
selects on becomes an ordinary ticket bound for the default branch the next time
it comes up, so close the members you are abandoning or strip their labels —
`readyLabel` on the implementation children, `researchLabel` on the research
ones. Then run `phoebe doctor`: its `stray-members` check names every member the
retired feature left labelled, including the one you missed.

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
- `prScope: ["phoebe/", "renovate/"]`. Phoebe maintains the branch prefixes
  you name and nothing else, its own included only if you list it. Each janitor
  can carry its own list
  ([`configuration.md`](configuration.md#the-array-form-and-per-kind-scope)) —
  how a dependency bot's red PRs get fixed up without widening anything else.

Cross-repository PRs from forks are **always** excluded.

## Watermark comments

Phoebe keeps no memory between cycles; it records janitor progress as hidden
HTML-comment markers on the PR. You normally never see them, but they explain
"why isn't Phoebe re-fixing this?":

| Marker                   | Meaning                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phoebe-conflict-fail`   | A conflict fix already failed against this exact PR-head + base-head pair; Phoebe waits for either side to move before retrying.                                                                           |
| `phoebe-checks-fail`     | A CI fix already failed at this PR head; Phoebe waits for a new push before retrying.                                                                                                                      |
| `phoebe-reviews-handled` | Review feedback up to a timestamp was handled; Phoebe only re-runs on newer review activity.                                                                                                               |
| `phoebe-sentry`          | In an issue body, not a comment: this issue was filed from that Sentry group. Closing it as **not planned** silences the group for good; closing as **completed** lets a later sighting file a regression. |

**To force a retry**, move the thing the watermark is keyed on: push a commit
(new PR head), merge/advance the base branch, or post fresh review activity.
Because the marker lives in a PR comment, you can also delete it. But the parser
takes the **newest** matching marker, so deleting a failure comment only
resets state when it removes that newest one; an older matching marker still
underneath it will keep applying. When a janitor gives up it posts a **visible**
failure comment too, so a human knows to step in.

## Running modes

| Invocation             | Behaviour                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------- |
| no flags (the default) | Persistent poll loop; all kinds; idles `PHOEBE_POLL_INTERVAL_MS` (300000).         |
| `--run-once`           | One `issues` or `research` unit then exit. Janitor kinds are persistent-mode only. |
| `--dry-run --run-once` | Print the unit that _would_ be picked (host-safe, nothing executes).               |
| `--pipeline <name>`    | Run one declared [pipeline](pipelines.md) instead of `work`.                       |

Flags go after the compose service name (`docker compose run --rm phoebe
--run-once`); `phoebe boot` forwards them to the engine it launches. No flags is
the deployed shape, and `docker compose up -d` runs the persistent loop.

`--dry-run` is the safe way to preview selection on your host without booting
the container. See [`upgrading.md`](upgrading.md) for start/stop/upgrade
commands and [`work-kinds.md`](work-kinds.md) for the full selection rules.
A tenant running more than one pipeline is [`pipelines.md`](pipelines.md); there is no
per-pipeline stop verb, because hot `disabled: true` is the stop.

## Reading unit history: `phoebe history`

Every pipeline records each unit it settles in `state/<pipeline>/units.jsonl`
([`pipelines.md`](pipelines.md)). `phoebe history` lists those records, newest
first:

```sh
phoebe history
phoebe history --outcome failed --since 2026-11-01
phoebe history --tenant acme/widget --pipeline work --kind issues --json
```

The filters are `--tenant <owner/repo>`, `--pipeline <name>`, `--cell <id>`
(the deployment report's `<tenantId>#<pipeline>`), `--kind`, `--outcome`
(`completed`, `unproductive`, `failed`, `timed-out` or `abandoned`),
`--provider`, `--model` and `--since <date>`. An `unproductive` unit is one whose
run ended without throwing but left its issue claimed with no PR; Phoebe
re-arms the issue and counts the run toward quarantine. A unit whose run
quarantined it reads `(quarantined)` after its outcome. They combine with AND. A page holds 50 units by default;
`--limit` raises that to at most 200, and a larger number is cut to 200. When
more units match, the footer prints the `--before <cursor>` that fetches the
next page.

The table shows each unit's age, pipeline, kind and number, outcome, model,
duration, cost and tokens in/out. Cost reads `$0.42` for API spend,
`$0.42 est.` for the list-price figure Claude reports under a subscription, and
`—` when the provider reported none. A `+` after the tokens means a run ended
before it reported its final usage, so the numbers are a lower bound. The footer
totals everything that matched, with API spend and estimates kept apart, and
says how far back each pipeline's history reaches. Older units have rotated
out.

`--json` prints one `HistoryPage` object (`records`, `summary`, `nextBefore`,
`retained`), the same object `GET /api/history` returns
([`remote.md`](remote.md)). Inside the container the verb reads the files
directly, so it works while the bootstrapper is down. On the host it runs
itself in the container with the same flags.

## Starting an observer run: `phoebe observe`

The [`observer`](work-kinds.md) kind runs on its `every` schedule, or never
when `every` is unset. `phoebe observe` starts a run now:

```sh
phoebe observe
phoebe observe --tenant acme/widget --lookback 30d
```

`--tenant <owner/repo>` is needed only when more than one tenant declares the
observer. `--lookback <period>` sets how far back this run reads, and the
configured `lookback` stays as it is for later runs.

The verb drops an ask under `state/observe/`, and the bootstrapper answers it
within a second or two. When it accepts, it passes the ask to the observer's
pipeline, whose next pass starts the run without waiting out the poll interval.
The verb prints the tenant and returns. The run itself takes minutes, and its
record appears in `phoebe history --kind observer` when it settles.

The bootstrapper refuses, and nothing is queued, in these cases:

- the fleet is stopped, by `POST /api/fleet/stop` or from a console;
- no tenant declares the observer, or the tenant named with `--tenant` does not;
- more than one tenant declares it and `--tenant` is missing;
- an observer run is already in flight for that tenant. The refusal gives the
  time it started;
- that tenant's observer pipeline is restarting.

The verb then exits 1 with the reason. On the host it runs itself in the
container with the same flags. `POST /api/observe` reaches the same handler
from a paired device ([`remote.md`](remote.md)).

## Picking issues to benchmark: `phoebe bench select`

`phoebe bench select` builds a suite of fixtures for the offline replay
benchmark. Each fixture is an issue Phoebe already solved. The verb prints the
suite as JSON on stdout. Save it in the deployment directory so a later run can
replay the same suite:

```sh
phoebe bench select --issues 812,840 > bench/suite.json
phoebe bench select --since 2026-10-01 --limit 30 > bench/suite.json
```

`--issues` names the issues. Without it, the verb walks merged PRs on
`<branchPrefix>issue-<n>` branches, newest merge first, and stops once
`--limit` fixtures qualify. The default limit is 20. `--since` keeps only PRs
merged on or after that date. In a workspace, `--tenant <owner/repo>` picks the
tenant. `--no-baseline` pins fixtures without running their baselines. See
[Baselines and unstable fixtures](#baselines-and-unstable-fixtures).

An issue qualifies when exactly one PR came from its branch, that PR merged into
the default branch, and every commit on it has the same git author. The verb
skips the rest and gives a reason for each one. It prints the reasons on stderr
and lists them under `skipped` in the suite. These are skipped:

- Issues whose PR merged into a feature branch.
- Stacked PRs. A PR counts as stacked if it merged into another issue's branch,
  says `Stacked on PR #N`, carries the `⛓️ Blocked by` comment, or had its base
  changed after it opened.
- PRs with commits from more than one git author. The reason names both authors.
- Issues blocked mid-way. These issues were labelled `phoebe:blocked` at some
  point, or a run left a `phoebe-blocked` comment on them.
- Research tickets, and PRs that close more than one issue.

Each fixture pins three things:

- The issue's title and body, and the comments posted before the PR opened.
- The PR's number, head commit, and merge commit.
- `baseSha`, the merge-base of the PR head and the merge commit's first parent.
  The verb computes it in the tenant's hub clone, so checking out `baseSha` gives
  the tree the PR started from, or the default branch it last merged in.

Before it pins an issue that qualifies, the verb runs the issue's baseline:
the merged PR's head goes through `installCommand`, `checkCommand` and
`testCommand` with no agent. If a gate fails, the verb skips the issue with a
reason such as `its merged PR no longer passes: test exited 1`. A fixture that
passes records the time in `baselinePassedAt`. With `--no-baseline` no gate
runs, and the fixtures have no `baselinePassedAt`.

On the host the verb starts a one-off container from the deployment's image
with `docker compose run --rm`. The long-lived container does not need to be
running, and the run takes none of its slots. The verb reads GitHub with the
tenant's token and never writes to it. Its only writes are local: it clones the
hub if the tenant has none yet, and fetches a PR head the hub clone lacks.

## Replaying a suite offline: `phoebe bench run`

`phoebe bench run <suite>` replays every fixture in a suite with every
contender. Each replay is a trial. Without a bench config there is one
contender, `tenant`, which uses the tenant's own `issues` settings: provider,
model, effort and prompt file.

```sh
phoebe bench run bench/suite.json
phoebe bench run bench/suite.json --bench-config bench/bench.json --concurrency 2
```

A bench config is a JSON file in the deployment directory that names the
contenders:

```json
{
  "contenders": [
    { "name": "current" },
    { "name": "opus-high", "model": "claude-opus-5-5", "effort": "high" },
    { "name": "new-prompt", "promptFile": "bench/issue-candidate.md" }
  ],
  "repeat": 3,
  "judge": { "provider": "claude", "model": "claude-opus-5-5" }
}
```

- A contender sets any of `provider`, `model`, `effort` and `promptFile`.
  Whatever it leaves out comes from the tenant's `issues` settings, resolved
  the way the tenant's own `issues` units resolve them. If you change
  `provider`, set `model` too unless that provider's default is what you want.
  `"effort": null` passes no effort flag at all.
- `promptFile` is a path relative to the deployment directory, so you can try a
  prompt before installing it.
- `repeat` (default 1) replays each fixture and contender pair that many
  times, to show how much the results vary.
- `--concurrency` (default 1) sets how many trials run at once. Bench takes
  none of the fleet's slots, but it does share the provider's rate limits with
  the live fleet.
- Every trial uses the tenant's `issues` run budget.
- `judge` is optional and needs both `provider` and `model`. See
  [The judge](#the-judge).

Before the first trial, bench checks that every contender's prompt file exists
and that its provider key (the variable `providerEnv` names) is set, and that
the judge's provider key is set too. A trial
has its own HOME, so a provider's on-disk login is not available to it.

"Offline" means cut off from GitHub: no git remote, no GitHub credential, and
the `gh` shim. It does not mean cut off from the network. Trials keep outbound
network, because the provider API and the package registry need it. Bench sets
no egress allowlist, so an unauthenticated request to github.com is not
blocked. Here is what a trial gets:

- The agent works in a fresh repository that holds history up to `baseSha` and
  nothing later, so the merged PR is not in it. The repository has no remote.
- The agent and the prompt's `!` commands get a HOME of their own with no git
  credential helper, and no `GH_TOKEN` or `GH_APP_*`. Provider keys pass
  through as they do in production.
- The `gh` on their PATH is a shim. `gh issue view` returns the issue from the
  suite. Writes such as `gh pr create` and `gh issue comment` get a plausible
  success and are recorded as "would have". Other reads answer as an empty
  repository would, or fail with a message saying the trial is offline.

Bench runs the gates itself, in this order: `installCommand`, the agent,
`checkCommand`, `testCommand`. It records each gate's exit code and duration,
and the first failure stops the rest. If the agent made no commits, the trial
is recorded as "no change" and the check and test gates are skipped.

### Baselines and unstable fixtures

A fixture's baseline checks that its merged PR still passes. Bench checks out
the merged PR's head, `pr.headSha`, from the hub clone into a fresh tree. It runs
`installCommand`, `checkCommand` and `testCommand` there with no agent, and
the first failure stops the rest. The gates get the same environment, the same
10-minute ceiling per gate and the same shared package store as a trial's
gates. The baseline tree is a separate repository. The trial's repository
still holds history only up to `baseSha`, so the agent never sees the answer.

`bench select` runs each fixture's baseline before pinning it.
`bench run` runs every fixture's baseline again before the first trial,
`--concurrency` at a time, because a fixture can break after it is pinned. A
certificate expires, a test depends on the date, or a package is unpublished.
Each baseline runs once. A test that fails now and then hits every contender
alike, and `repeat` covers that.

A fixture whose baseline fails in a run is unstable for that run. None of its
trials run, so no agent time is spent on a result nobody can score. Bench does
nothing to rescue it. It uses no fake clock and no registry snapshot. The
report lists the unstable fixtures, and the table ends with a line like this:

```
2 fixture(s) unstable, not scored: #412 (test exited 1), #430 (install exited 1)
```

If bench cannot check out the merged PR's head at all, the fixture is unstable at
`checkout`.

Each run writes to `bench/<runId>/` in the tenant's data directory, beside
`state/`:

- `config.json`: the settings the run used.
- `trials.jsonl`: one line per trial. Each line is a unit record with
  `pipeline: "bench"`, plus the fixture, contender, repeat index, gate results,
  diff stats and "would have" writes.
- `patches/`: one patch for each trial that made commits.
- `report.json`: the run's `BenchReport` (see below), with `interrupted: true`
  if the run was stopped early.

Trials never go into a pipeline's `units.jsonl`, so nothing that reads unit history
mistakes a trial for real work. Bench removes each trial's tree when the trial ends.
Before a new run starts, it deletes all but the 9 most recent run directories,
so 10 remain once the new run is added.

A trial that times out or fails is recorded, and the run moves on to the next
one. Ctrl-C drops the trials in progress, writes `report.json` with
`interrupted: true`, and exits with code 130. On the host, the suite and bench
config files have to be inside the deployment directory, because that is the
directory the one-off container mounts.

### The report

When the run ends, bench prints one row per contender on stdout:

```
contender  trials  no change  check  test  median time  median tokens  API cost  subscription est.
current         6          1    83%   67%       6m 40s           1.9M     $4.12                  —
opus-high       6          0   100%   83%       9m 05s           2.6M     $9.80                  —
```

- **check** and **test** are pass rates over all of the contender's trials. A
  trial with no change, a failure, a timeout, or one stopped by an earlier gate
  counts as not passing.
- An unstable fixture is in no rate, and `planned` counts only the trials of
  stable fixtures.
- **median time** is the whole trial: install, agent and gates.
- **median tokens** adds input, output and cache tokens across the trial's
  agent runs.
- **API cost** totals what the provider reported as billed to an API key.
  **subscription est.** totals the list-price figure Claude reports under a
  subscription, which nobody actually paid. A dash means the provider reported
  no figure of that kind.

`--json` prints the report as JSON instead: a `BenchReport` (`v: 1`, exported
from `phoebe-agent/contracts`). `report.json` holds the same JSON.
`baselines` maps each fixture's issue number to its baseline gates.
`unstable` lists each unstable fixture with its issue, PR, the gate that
failed, that gate's exit code, and the fixture's `baselinePassedAt` from the
suite, so you can see how long ago it last passed.
`phoebe bench report <runId>` prints a saved run's report again, as the table or
with `--json`. The run id is the directory name under `bench/`.

```sh
phoebe bench report 2026-11-25T12-00-00-000Z --json
```

The exit code is 0 when every trial ran, however the trials scored. Failing
gates never change it. When every fixture is unstable, bench prints the report,
says `no stable fixture: nothing to compare`, and exits 1. Otherwise bench
exits non-zero only when it could not do its job: a bad suite or bench config,
a missing prompt file, or a contender or judge whose provider key is unset.

### The judge

Gates tell you whether a trial's patch passes. The judge tells you how it
compares with the PR that actually merged. It is off unless the bench config
has a `judge`.

After each trial that made commits, bench runs the judge once. The judge works
in a scratch directory that holds three files: the issue as the suite pinned
it, the merged PR's diff from the hub clone, and the trial's patch. The merged
diff runs from `baseSha` to the PR's head, the same starting point as the
trial's patch. There is no repository, no remote and no GitHub credential, and
bench deletes the directory afterwards. The judge answers with one verdict and a short rationale:

- `better`: solves the issue and is clearly better than the merged PR.
- `equivalent`: solves the issue about as well, even if the code differs.
- `worse`: addresses the issue but falls short of the merged PR.
- `wrong`: does not solve the issue, or would break something.

The verdict, the rationale and the judge's usage go on the trial's line in
`trials.jsonl` as `judgement`. If the judge fails, times out, or answers off
the scale, the trial is still recorded, with no verdict and an `error` saying
why. The judge runs after the trial's clock stops and its usage is never in
`agentRuns`, so it cannot show up in a contender's time, tokens or cost.

With a judge, the report adds a column per verdict after **test**, and a line
under the table with the judge's runs, tokens and cost. A trial with no change
is never judged. A trial with commits that got no verdict counts as
`unjudged` in the JSON report, and the line under the table says how many.

## Benching a pull request: the `bench` kind

A deployment that declares the [`bench`](work-kinds.md#bench-measure-a-prs-prompt-and-model-against-the-default-branch-opt-in)
kind benches a PR when a person adds the `phoebe:bench` label to it. The kind
replays the deployment's suite with two contenders. `main` has the default
branch's `issues` prompt, provider, model and effort, and `pr` has the PR
head's. It posts the figures side by side in a new comment on the PR, then
removes the label. Add the label again to run another bench. The kind needs a
suite, so run `phoebe bench select > bench/suite.json` first. A PR that
changes neither the `issues` prompt nor those settings gets a comment saying
there is nothing to measure.

The comment is information for the reviewer. Bench sets no check status and
fails nothing, because ten fixtures run once each can differ by a fixture or
two by chance. Bench does not measure changes to `AGENTS.md` or skills yet,
because trials read both from each fixture's tree at `baseSha`. The comment
says so when a PR touches them.

### By hand: a two-contender bench config

Without the kind, you can make the same comparison with `phoebe bench run`.
From the deployment directory, copy PR #123's prompt out of a checkout of the
repository (`~/src/widget` here):

```sh
git -C ~/src/widget fetch origin pull/123/head
git -C ~/src/widget show FETCH_HEAD:prompts/issues-prompt.md > bench/pr-123-issues-prompt.md
```

Then save a bench config as `bench/pr-123.json` that names that prompt beside
the current one:

```json
{
  "contenders": [
    { "name": "main" },
    { "name": "pr", "promptFile": "bench/pr-123-issues-prompt.md" }
  ]
}
```

```sh
phoebe bench run bench/suite.json --bench-config bench/pr-123.json
```

If the PR also changes the `issues` provider, model or effort, set them on the
`pr` contender. `main` takes the tenant's own settings.

### No CI workflow template

Phoebe ships no GitHub Actions template for benching PRs. A CI bench would need
its own copy of the image, a clone of the repository, provider keys billed to
an API account, and the suite. The deployment already has all four. Use the
`bench` kind or the recipe above instead.

## Checking the deployment's health: `phoebe doctor`

`phoebe doctor` (report-only) runs twelve checks and exits 1 when any fails:

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
- **config-pen.** Whether the root `phoebe.config.ts` is mounted read-write, which
  is what `phoebe config set` needs to apply an edit. A deployment that came up
  before that mount existed looks identical until the first edit fails, so the
  check names the volume line to add and the restart that picks it up. In-container
  only, like **supervisor**.
- **remote.** The `remote` block against what is running ([`remote.md`](remote.md)):
  `unknown` with no block. In the container, that the listener answers the
  descriptor, that the sidecar's node is on the tailnet and Serve proxies to the
  socket, that the mint drop exists and is root's, that the sessions file has not
  moved under the bootstrapper, and that the pair budget is not exhausted. From
  the host, that the arm's overlay files exist, that the running services and
  published ports match the arm, and on the host arm the same read-only Serve
  inspection `phoebe start` runs. The line says which vantage point answered.

In workspace mode it also sweeps every tenant, using the same enumeration boot
supervises with, checking each tenant's `GH_TOKEN` is present the way its
engine child reads it, and that its repo answers to that token. Held tenants
surface as failures with their hold reason. `--json` for scripts.

The other five run per tenant:

- **labels.** The five workflow labels — `readyLabel`, `processingLabel`,
  `mergedLabel`, `prOptOutLabel` and `phoebe:quarantined` — exist in the
  tenant's repo. Any that does not is named with the `gh label create` command
  that makes it.
- **stray-members.** Open members of a [feature](feature-branches.md) that has
  ended, still wearing a label Phoebe reads. A feature ends when its integration
  PR merges or closes, or when its parent issue closes; from that moment routing
  stops seeing the members underneath it, so whichever of `readyLabel`,
  `researchLabel`, `processingLabel` or `mergedLabel` a member was wearing stays
  on it and nothing is coming to take it off. Each one is named with its feature
  and one repair: close it when the integration PR merged, and when the feature
  was cancelled either close it or strip the label, which sends it back to the
  default branch as an ordinary ticket. Phoebe changes nothing itself — which
  repair is right depends on what you meant by cancelling. The cost is one
  tracker query per label plus the issue graph above whatever they return, paid
  when you run doctor and never per cycle. **Warn, never fail.**
- **stale-state.** The only check that reads the data volume rather than the
  tracker: state under a tenant's data directory that no pipeline
  owns — a deleted or renamed pipeline's `state/<pipeline>/`, a retired kind's
  scratch or read-only tree, a worktree whose lease names a pipeline that no
  longer exists. Most of it the next boot reclaims by itself ([the stale-state
  sweep](architecture.md#reclaiming-what-a-pipeline-leaves-behind)); what this names
  by path is the tier that sweep refuses to touch — a worktree that is dirty or
  holds commits `origin` has not seen — with a one-line hint for reclaiming it
  by hand. **Warn, never fail**: accumulated dirt is a chore, not a fault.
- **secret-store.** Which keys the tenant's [secret
  store](configuration.md#tenant-secrets-the-store-and-phoebe-secret) holds, and
  which of them the tenant's `.env` also sets. The store outranks the file, so a
  key in both means a `.env` edit that does nothing, which is the one silent
  failure this design would otherwise introduce. Each such key is named, with
  `phoebe secret clear <KEY>` as the repair. A store file that will not parse is
  its own warn, because every delivery path reads it fail-closed and nothing else
  would ever mention it. **Warn, never fail**: shadowing is a state you may have
  meant. Never a value, in any state.
- **provider-key.** Works out which provider each scheduled kind runs on, the
  way the engine does: its block's `provider`, then `defaultProvider`, with an
  env override such as `PHOEBE_AGENT` beating both. For each provider it looks
  up the env var `providerEnv` names and checks that the tenant's `.env` sets it.
  An unset or blank key fails. The agent would start with no key and die on
  `Not logged in` on its first unit, so the engine refuses to boot that pipeline
  too. A Claude login at `~/.claude/.credentials.json` counts as a key; that is
  [Approach B](claude-subscription-auth.md#approach-b-hoist-your-existing-on-disk-login)
  of the subscription setup. Doctor run from the host cannot see that file, so
  there a missing Claude key is a warn. Doctor never tests whether a key works,
  and never prints one.

**You are not the only one who runs it.** The bootstrapper runs doctor itself:
once the fleet comes up, again after a reconcile lands, on request, and every six
hours. What it finds goes into the deployment report, so the last report and its
age are there to read without anyone having remembered to ask. Those runs are
spawned as a child process and carry each tenant's installation token, which is
why `repo`, `labels` and `stray-members` are answered on an App-arm deployment
instead of skipped. One run happens at a time. Asking while one is in flight
joins it; asking mid-reconcile waits for the relaunch, then runs once against the
engine that is actually running.

Every run, yours included, holds itself to five minutes. A check that has not
finished by then reports `?` with "deadline passed", and the rest of the report
still lands. One unreachable tenant costs you that tenant's answers, not the
whole report. The bootstrapper kills its own doctor child thirty seconds past
that as a backstop. When it does, the last report stays where it is with its age,
and the failed attempt is recorded beside it.

`phoebe secret set` runs one too, on the run that succeeds: setting a key is the
moment you want "did it work" answered, and this is the check that answers it.

Typing `phoebe doctor` yourself prints and changes nothing. The report on the
volume is the bootstrapper's, and a manual run carries no leases, so an App-arm
tenant's tracker checks read `unknown` as they always have.

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
org approval does not apply, but the same six permissions must be granted to the
App installation.

The grant that goes missing most often is **Workflows: Read and write**, because
it used to be optional. Without it GitHub rejects any push that changes a file
under `.github/workflows/`, with `refusing to allow a Personal Access Token to
create or update workflow` in the push output. That includes a push that only
merges the base branch in after a workflow change landed there. Add the grant to
the token or the App
([onboarding §2](phoebe-core-onboarding.md#2-operator-github-token-a-fine-grained-pat))
and the next cycle's push goes through.

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

| Invocation                                         | Verifies                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `verify-tenant-token.mjs`                          | The cwd's tenant, its `phoebe.config.ts` and its `.env`.              |
| `verify-tenant-token.mjs ./core`                   | A specific tenant directory (repeatable).                             |
| `verify-tenant-token.mjs --all`                    | Every tenant of the deployment rooted here, one section each.         |
| `verify-tenant-token.mjs --slug o/r --token ghp_…` | A token you have not written to a file yet.                           |
| `--json` / `--check`                               | Machine-readable output / exit 1 on any finding (as `phoebe status`). |

It reports each of the six permissions
[onboarding §2](phoebe-core-onboarding.md#2-operator-github-token-a-fine-grained-pat)
asks for as granted / missing / unknown, distinguishes "no access at all" (the
usual sign of a fine-grained PAT still awaiting org approval) from one missing
checkbox, and warns when the token expires inside 14 days. No probe changes
anything: the four write grants are probed by aiming a `POST`, `PATCH` or
`DELETE` at a resource that cannot exist, so GitHub answers with the permission verdict and
there is nothing to mutate. Trust the Workflows line least. Nobody has yet seen
what GitHub answers that probe for a token without the grant, so a ✓ there
could be wrong until someone has. It is safe against production, but note that it does
issue write-method requests, which matters if you are approving it through
a network policy. It never prints the token, and `--all` does not abort when one
tenant fails.

## Crash reporting

Phoebe can report its **own** faults to a Sentry project — the maintainers',
yours, or both — and does nothing of the kind until you turn it on with the
`reporting` block beside `engine` in your config
([`configuration.md`](configuration.md#crash-reporting-reporting)). `phoebe init`
asks once on a terminal and writes the answer; `phoebe upgrade` asks once more
only if your config has no block at all.

What is reported is Phoebe's install and upgrade faults, and only those:

| Phase            | Events                                                                                                                                                         | Level                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| boot             | the engine clone, fetch or materialize failing; an engine child exiting non-zero inside the healthy window; the crash-loop guard quarantining an engine commit | quarantine `fatal`, the rest `error` |
| `phoebe upgrade` | any failure in fetch, migrate, validate or flip                                                                                                                | `error`                              |
| `phoebe migrate` | a migration's apply or verify throwing                                                                                                                         | `error`                              |
| `phoebe init`    | the scaffold throwing (a refusal such as "config already exists" is not a throw)                                                                               | `error`                              |
| `phoebe doctor`  | the command itself throwing, never its findings                                                                                                                | `error`                              |

**Not reported:** a tenant's `installCommand` failing, the catch-and-continue
sites in the engine cycle, unit timeouts and the quarantine of a unit. Those are
the tenant's repository or GitHub misbehaving, not Phoebe, and they stay in the
container's own log.

What leaves the box, per event: `phase`, `bootstrapVersion`, `engineRef` and
`engineSha` (unknown for the operator commands, which run outside a checkout),
the `node` version, `deploymentArm` (`solo` or `workspace`), `credentialArm`
(`pat` or `app`), the error's class, message and stack, plus the stage the fault
happened at (`launch`, `fast-exit`, `crash-loop`, `migrate`, `flip`) and, for an
exit, the code and the pipeline name; a failed migration names its id. Stacks are Phoebe's own frames; any path under
`/data/repos/<owner>/<repo>` is rewritten to `<tenant>` before sending. The
tenant `repoSlug`, and a unit ref where a fault names one, are sent only under
`includeRef: true`; otherwise the tenant tag reads `redacted`.

Transport is one HTTPS POST to the project's envelope endpoint, with no SDK and
no dependency: one attempt, a three-second timeout, and a failed send logged at
debug level. A report never changes a command's exit code or delays a boot; the
one place Phoebe waits is the bootstrapper's own exit, so a crash-loop report is
not lost to the process ending.

To turn it off, set `maintainers: false` and remove `dsn`, or delete the block.
This repository's own tenant consumes the maintainers' project through the
[`sentry` kind](work-kinds.md#sentry-triage-production-errors-opt-in), which is
how a crash report becomes a front-loaded issue here.

## One-off overrides without editing config

Most scalar fields have a `PHOEBE_*` name that sets them for a single run, such
as `PHOEBE_DEFAULT_PROVIDER=claude`, `PHOEBE_PR_SCOPE=all`, or
`PHOEBE_POLL_INTERVAL_MS=60000`. One rule decides who wins: env beats the config
file at a path, and a more specific path beats what it would inherit. See the
[settings catalogue](configuration.md#settings-phoebe_).

To see which of them is actually in force, run `phoebe config`: every setting
with its value, the thing that supplied it, and whatever it beat. See
[Seeing what applies](configuration.md#seeing-what-applies-phoebe-config).

## Quick reference

| I want to…                                    | Do this                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue an issue for Phoebe                     | Add `readyLabel` (`ready-for-agent`).                                                                                                                                           |
| Pause a queued issue                          | Remove `readyLabel`.                                                                                                                                                            |
| Bump an issue up the queue                    | Word it as a bug/fix, or it waits its turn by age.                                                                                                                              |
| Sequence-dependent issues                     | `Blocked by #N` in the body.                                                                                                                                                    |
| Hand back a ticket Phoebe said needs you      | Do what its comment asks, then remove `phoebe:blocked`.                                                                                                                         |
| Land a group of issues in one merge           | Add `featureLabel` (`phoebe:feature`) to their parent issue.                                                                                                                    |
| Cancel a feature                              | Close its draft integration PR, then close or unlabel the members you are abandoning (`readyLabel` and `researchLabel` alike), then run `phoebe doctor` to catch stray members. |
| Take a PR away from Phoebe                    | Add `prOptOutLabel` (`ready-for-human`), which works for any PR. Under the default `draftPrs`, marking a **non-Phoebe** PR draft also opts it out.                              |
| Hand a PR back                                | Remove the label / mark ready-for-review.                                                                                                                                       |
| Force a janitor to retry                      | Push, advance the base, post new review feedback, or delete the newest failure comment.                                                                                         |
| Let Phoebe maintain all PRs, not just its own | `prScope: "all"`.                                                                                                                                                               |
| Let one janitor fix a bot's PRs               | `prScope: ["phoebe/", "renovate/"]` on that kind's block, leaving the tenant's alone.                                                                                           |
| See what a setting resolves to, and why       | `phoebe config` (add `--json` for a machine).                                                                                                                                   |
| Change one setting without an editor          | `phoebe config set <path> <value>` — one literal, in place, validated first.                                                                                                    |
| See the deployment from another machine       | Add a `remote` block, `phoebe stop`, `phoebe start`, then `phoebe pair` and paste the link into the companion ([`remote.md`](remote.md)).                                       |
| See who is paired, or end a session           | `phoebe sessions`; `phoebe sessions revoke <id>` or `--all`.                                                                                                                    |
| See which units ran, failed, or cost the most | `phoebe history`, with `--outcome failed`, `--since <date>` or `--json`.                                                                                                        |
| Run the observer now, outside its schedule    | `phoebe observe`, with `--tenant <owner/repo>` when several tenants declare it and `--lookback <period>` for this run only.                                                     |
| Pick solved issues to benchmark against       | `phoebe bench select --issues 12,34`, or `--since <date> --limit <n>`, to stdout as JSON.                                                                                       |

## Running many repos in one container

One container can serve several repos as **tenants**. The bootstrapper runs one
engine child per tenant and reconciles the set on every poll, with **no restart**
needed to add or remove one. The layout is **workspace**: child checkouts under a root
that declares `workspace: { depth }` (walk) or `workspace: { tenants: [...] }`
(declare). Full topology + runbook: [`workspace.md`](workspace.md).

Read [`trust.md`](trust.md) first: co-locating repos means co-locating them in
one trust domain.

| Action                            | How                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a repo                        | Place the checkout under the root (`git clone` / `git submodule add`), then `phoebe init --tenant <dir>` (host-side) and, on the declared arm, add the dir to `workspace.tenants` yourself. Phoebe never edits your fleet declaration; `workspace.tenants` is yours. The bootstrapper discovers it next poll. Fill in its `.env`.         |
| Remove a repo                     | Drop the child from `workspace.tenants` and/or delete its config dir (host-side; Phoebe never edits your fleet declaration). Reversible, because the tenant's `/data` is retained and re-adding re-uses it.                                                                                                                               |
| Reclaim a deleted pipeline's disk | Nothing to do: the next boot, and any later pipeline-set change, sweeps the state of pipelines the config no longer declares. A worktree that is dirty or holds unpushed commits is left for you, named by `phoebe doctor`'s `stale-state` check. Run `phoebe sweep-state` (in-container) to do it now.                                   |
| Reclaim a removed repo's disk     | `phoebe purge <owner/repo> --yes` (in-container). Destructive; refuses while a live config still claims the slug.                                                                                                                                                                                                                         |
| Apply deployment migrations       | `phoebe migrate` (host-side, in the deployment dir). Rewrites config content and scaffolds missing artifacts across root and fleet; lists uncommitted paths for you to review and commit per repo. See [`upgrading.md` → phoebe migrate](upgrading.md#phoebe-migrate-reshaping-your-files-for-the-current-ref).                           |
| Check every tenant's GitHub token | `node scripts/verify-tenant-token.mjs --all` (host-side, in the deployment dir). One section per tenant; `--check` exits non-zero when any is short a grant. See [Checking a tenant's GitHub token](#checking-a-tenants-github-token).                                                                                                    |
| See what the deployment is doing  | `phoebe status`, either side of the container wall (see below). It reads the deployment report: the bootstrapper line, the fleet with two lines per pipeline, and doctor in one line. `--json` prints the report file verbatim, `--check` exits 1 when something needs a look. `phoebe list` is a deprecated alias for its fleet section. |

**Reading `phoebe status`.** One verb answers "is it alive, and what is it
doing", either side of the container wall. Inside the container it reads the
deployment report off the data volume; on the host it drives the deployment's
`container/compose.yml` and execs itself in the container, exactly as `phoebe
start` and `phoebe stop` drive Compose — so run it from the deployment directory
and you get the same answer either way:

```
[phoebe] bootstrapper  engine main → a1b2c3d  slots 1/4  report 2m ago
[phoebe] fleet         2 tenant(s), 3 pipeline(s)  updated 2m ago
  children/widget  (acme/widget)
      ✓ config  ✓ env  ✓ data  arm: pat
        work    running 3h
                working 1/2 issues 12
        intake  exited (code 1) 2m ago, 3 restarts, crash-looping
                idle  wedged? no pass for 17m
  children/sprocket
      held — missing repoSlug in phoebe.config.ts
        work  not supervised  (from disk)
              idle
[phoebe] history       24h  31 units, 3 failed, 1 timed out  $8.20 api + $4.10 est.
[phoebe] doctor        0 fail, 1 warn — 4h ago (schedule)
```

Top to bottom is priority order: read down until something looks wrong and stop.
The bootstrapper line names the engine ref and the commit actually running, says
`quarantined (avoiding <sha>)` when the crash-loop guard has put the deployment
on last-known-good, says `reconciling (config|ref)` while a relaunch is under
way, and ends with the age of the report itself. The history line counts the
units every pipeline started in the last 24 hours, names the ones that failed,
timed out or were abandoned, and gives their cost by basis. `api` is what a key
was billed. `est.` is the list price Claude reports under a subscription,
which nobody paid. The line prints the two side by side and never adds them. A
day whose units reported no cost at all reads `tokens only`. The bootstrapper
sums each pipeline's unit history into the report at boot, when a unit
settles, and once an hour. `--json` carries the same summary for each pipeline
and for the fleet, with a 7-day window beside the 24-hour one. History never
trips `--check`. The doctor line is the last run's counts and its age, or
`never run`. `--verbose` adds a history line under each pipeline and inlines
the whole doctor table under the doctor line.

**Two lines per pipeline.** The first is the _process_: what the bootstrapper's
child is doing — running, draining, exited with its code or signal — plus its
restart count and whether those restarts are fast enough to count as a
crash-loop. A cell with no child reads `not supervised`. The second is the
_state_, from that pipeline's own `state/<name>/status.json`:

- `no status` — the pipeline exists; nothing has written a snapshot for it yet.
- `working k/N <units>` — `N` is the pipeline's declared `concurrency`.
- `waiting for slot` — a pass picked a unit and is queued on the fleet cap.
- `idle`.
- `wedged? unit past its budget` — some in-flight unit has outlived its own run
  budget plus one poll interval. Each unit is weighed against its own budget.
- `wedged? no pass for <age>` — the engine has completed no loop pass in three
  poll intervals while not waiting for a slot. This is how a pipeline whose
  process is alive but whose loop has stopped becomes visible at all: an idle
  engine writes no snapshot, so without it the pipeline would read `idle`
  forever.

`wedged?` is a question, not a verdict. An idle pipeline that is still passing is
never wedged however long it has been idle, and pipelines are never weighed
against each other — one that polls every 15 minutes is not sick for being
quieter than the one beside it.

A snapshot outlives the process that wrote it, and a child killed mid-unit never
gets to say the unit ended. So each child in persistent mode, as it starts, drops
whatever its pipeline's snapshot still lists as in flight or waiting for a slot,
and logs every unit it drops with the time that unit had started. Until that next
start the file still names the dead unit, which is why a stopped deployment can
read `wedged? unit past its budget` with nothing running. A `--dry-run` or a
`--run-once` never does this: either may be a second process beside a child whose
unit is alive.

`(stale)` marks a `state/<name>/` directory this tenant's config no longer
declares: a renamed or deleted pipeline whose snapshot outlived it. It is
reported, never acted on, and it does not affect `--check`. A held tenant is one
whose config could not be read, so there is no pipeline set to ask for. `status`
shows the snapshots that are on disk instead, and marks each one `(from disk)`.

**Nothing in the view is computed twice.** Every state and every `wedged?`
verdict comes straight out of the report, where the bootstrapper derived it once.
That is what stops this command and the web console disagreeing about a pipeline.
`--json` prints `state/deployment.json` byte for byte, for the same reason. The
console is the same file rendered in a browser, and what it does with it is
[`console.md`](console.md).

**A missing or old report is stated as a fact, never as a state.** Inside the
container the one live question `status` asks is whether `phoebe boot` is still
the process holding the container open. When it is not, the view opens with
`bootstrapper not running; last report 3h ago` and prints the report beneath it —
the facts are still the last true ones, and how old they are is the news. With no
file at all: `no deployment report: the bootstrapper has not booted on this
volume`. From the host, a container that is not running is reported before any
exec. There is no staleness threshold, because "3h old" is a fact an operator can
act on and "stale" is a guess.

**`--check` for a cron.** Exit 1 when something needs a look: a wedged pipeline,
a crash-looping one, a failing check in the report's doctor section, a held
tenant, a bootstrapper that is not running, or no report at all. Doctor
_warnings_ and stale pipeline directories deliberately do not trip it. It names
the findings on stderr, so the cron mail says which one fired.

**`phoebe list` is deprecated.** It still works. It prints the fleet section
above, the bootstrapper-not-running header included, plus a one-line notice, and
it goes away at the next major. Two things it used to print are gone with it: the
`N of M declared tenant(s)` header and the `undeclared:` footer. Neither has a
home in the deployment report yet, and the report is now the one source every
reader shares. `phoebe pipelines` (the supervisor's machine interface) and
`phoebe doctor` (print-only, credential-free by hand) are unaffected.

**The deployment report.** The bootstrapper keeps one file on the data volume,
`<data>/state/deployment.json`, that says what the whole deployment is doing right
now: who it is, which engine commit it is running, what its crash-loop record and
its reconcile state are, how each supervised child is faring, where the slot cap
stands, one entry per (tenant × pipeline) cell with that pipeline's raw
`status.json` and its derived state, and what the last
[doctor run](#checking-the-deployments-health-phoebe-doctor) found, with the
trigger that started it, when it was taken, whether one is running now, and the
last attempt that produced nothing. It carries a `schema` integer, it is
replaced atomically, and it is rewritten only when something in it moves — a fixed
set of current facts, never a log. Nothing on disk grows with uptime.

`phoebe status` is that file rendered, and `phoebe status --json` is that file.
Reading it by hand, one field needs a warning: each child's `lastPassAt` is **not**
an age to display. It advances every pass and the file is not rewritten for it, so
between writes it is deliberately stale on a perfectly healthy idle pipeline. The
published form of that clock is the `noPassForMs` inside a wedged verdict, stamped
at the moment the verdict was taken.

**Settings ride in the report too.** Its `config` section is every tenant's
effective config, each setting with its value and where that value came from, in
the shape [`phoebe config`](configuration.md#seeing-what-applies-phoebe-config)
prints. The running engine computes it, per tenant, so the report says what the
engine actually believes rather than what the bootstrapper would guess. A tenant
that is held, or whose file will not load, carries its error instead of the
resolution it had before. The section also carries a content hash of the root
`phoebe.config.ts` it was derived from, which is what a remote config edit checks
itself against. Only `--json` shows it. The text view is the fleet.

The section is written to a byte budget, so a workspace with an unusual number of
tenants writes a report that stops growing rather than one that does not. The
tenants left out are counted in `config.omitted` and read with `phoebe config`.

**Stopping one pipeline.** There is no per-pipeline stop verb yet. Setting
`disabled: true` on that pipeline in the tenant's `phoebe.config.ts` is hot at the
pipeline scope — the supervisor picks up the edit without relaunching anything, and
the pipeline lists as `(disabled)` — but nothing acts on it: the supervisor does not
stop the pipeline, and the flag is display-only for now, recording operator intent.
To actually stop work today, use the off-switch that bites: per kind
(`pipelines.<pipeline>.kinds.<kind>.disabled: true`), which takes each of the pipeline's
kinds out of rotation. Stopping the whole tenant is `disabled: true` at the top
level of its config.

**Concurrency across tenants.** One bootstrapper-brokered cap decides how many
work units execute at once across the whole container, so N repos don't thrash
the host. It defaults to the largest `concurrency` any live pipeline declares — 1
unless a pipeline asks for more — and `PHOEBE_MAX_CONCURRENT_AGENTS` replaces that,
even when lower. Pipelines queue for it oldest waiter first, and a pipeline starved of a
slot may hold one over the cap (`PHOEBE_SLOT_FLOOR_BUDGET`, default 1), so the
worst case is the cap plus that budget. Boot prints both numbers and their
derivation on one line. Idle polling stays per-pipeline and parallel. The knobs are
in [`configuration.md`](configuration.md#concurrency-the-pipelines-knob-and-the-fleets-cap).

**Reading the logs.** Every line a pipeline writes opens with
`[<deployment>:<owner>/<repo>:<pipeline>]`. That goes for the engine's lines and
the agent's alike, and the implicit `work` pipeline is tagged like any other. The
deployment segment is the name the bootstrapper's `deploymentName` computes. Until
`relay.name` exists that is the solo tenant's `repoSlug`, or the workspace root's
directory name. So a solo deployment repeats its slug,
`[JesusFilm/phoebe:JesusFilm/phoebe:work]`, and a workspace under `/srv/phoebe`
writes `[phoebe:JesusFilm/phoebe:work]`. An engine run by hand, with no
bootstrapper, names itself by its own slug. The bootstrapper's own lines are still
tagged `[phoebe]`.

An agent's line is the same bracket plus one naming the provider, last:
`[<deployment>:<owner>/<repo>:<pipeline>][<kind> <ref>][claude]`, or
`[claude:stderr]` for what it wrote to stderr. That last bracket is the only thing
that tells an agent line from an engine line.

Match the bracket as a **prefix**, never a fixed string. Collectors written
against the older shapes need a look. One keyed on `[phoebe:` stops matching once
the deployment is called anything else. One keyed on the engine bracket now
catches the agent's lines too. One pinned to the agent's old
`[<owner>/<repo>:<pipeline>:<command>]` bracket stops matching altogether. A
deployment name can hold a colon, so a parser should read the bracket from the
right: the last segment is the pipeline, the `owner/repo` before it is the slug,
and the rest is the deployment. The container writes no log files. Stdout is the
whole story.

**Which unit said it.** Anything produced on behalf of one work unit adds a
bracket naming it after the pipeline's, `[<deployment>:<owner>/<repo>:<pipeline>][<kind> <ref>]`.
That covers a kind's own logging, the git and install output its children
produce, and the agent, whose provider bracket follows the unit's. It is there
whatever the pipeline's `concurrency`, so `[issues issue:88]` greps one unit's
whole story out of a pipeline running several: its clone traffic, its install,
its agent.

**When a unit hangs.** A work unit that exceeds its wall-clock budget
(`PHOEBE_RUN_TIMEOUT_MS`, default 45 min) is aborted so it can't starve the
fleet, and the engine moves on. A unit that hangs **every** time is quarantined
after `PHOEBE_MAX_UNPRODUCTIVE_RUNS` (default 3) consecutive timeouts: Phoebe
applies a `phoebe:quarantined` label and posts one escalation comment asking for
a human. An issue unit can arrive at the same quarantine without ever hanging,
by [accruing unproductive runs](#processinglabel-means-in-flight), and the two
ways out below cover that case too.

There are two ways out, and both give the unit a **fresh** allowance of
`PHOEBE_MAX_UNPRODUCTIVE_RUNS` runs, not a single retry:

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
