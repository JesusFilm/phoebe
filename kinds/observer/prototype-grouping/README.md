# PROTOTYPE: observer grouping prompt

**Throwaway.** This folder answers the questions in #980 (the observer's grouping
prompt, minimum evidence, calibration, and how prior proposals are shown) and is
meant to be deleted, not merged. Nothing in the engine imports it, and it changes
no shipped file. It sits under `kinds/`, so a publish from this branch would ship
it; don't publish from this branch.

## Run it

    node kinds/observer/prototype-grouping/run.ts

That builds `fixture/units.jsonl` if it is missing, runs the observer's real
flagging over it, runs each prompt variant once with the `claude` CLI, and writes
`report/index.html`. Open the report from disk; it needs no server. A
compact summary also goes to stdout.

Five runs are defined in `run.ts` (`RUN_SPECS`): `A`, `B`, `C` and `D-sonnet` on
`claude-sonnet-5-5`, the model an observer with no kind block gets
(`defaultModels.claude` in src/config-schema.ts), and `D-opus` on `claude-opus-5-5` at
`low`, which this repo's own `.phoebe/phoebe.config.ts` would give it. Each costs
cents and takes under a few minutes. The GitHub reads are cached in `cache/`, so a
re-run only pays for the agent.

| Flag | Default | What it does |
| --- | --- | --- |
| `--units <path>` | `fixture/units.jsonl` | A real `units.jsonl` dump: one `UnitRecord` (src/contracts/unit-record.ts) per line |
| `--pipeline <name>` | each record's `pipeline` | Use one pipeline name for every record, for a dump from a single `state/<pipeline>/` |
| `--days <n>` / `--lookback <30d>` | `30` | The window, for both the fixture and the lookback |
| `--now <iso>` | when the fixture was built (now, for `--units`) | Where the lookback ends, for replaying an old dump |
| `--runs D-sonnet,D-opus` | every reported run | Which runs call the agent now; the others load their saved results |
| `--report A,B,C` | all five | Which runs the report covers |
| `--flag-only` | | Stop after flagging and write `report/runs/flagged.json` |
| `--reuse` | | Rescore the saved runs in `report/runs/` without calling the agent (after editing `calibration.json`) |
| `--rebuild` | | Rebuild the fixture first |
| `--phoebe-identity "Name <email>"` | read off a Phoebe PR commit | Phoebe's git identity for `outside-commits` |

`PROTO_REFRESH=1` ignores the cache.

To build the fixture on its own: `node kinds/observer/prototype-grouping/build-fixture.ts --days 30`.

## What runs, and what is the real code

- `unitsSince`, `gatherPrOutcomes` (with a real `createGitHubClient`), `flagUnits`,
  `parseFindings` and `decideFinding` are imported from the shipped modules.
  Revert commits come from `git log origin/main`.
- `flagged.json` and `proposals.json` are written exactly as `writeFlagged` and
  `writeProposals` in index.ts write them (the code is copied, because index.ts
  keeps them inside the factory).
- The prompt is rendered with `renderPrompt` and the same placeholders `run()` fills,
  plus the config defaults (`DEFAULT_BRANCH`).
- The agent runs in a detached `git worktree` of `origin/main` at
  `/tmp/observer-proto-checkout`, which is removed afterwards. Permission mode is `dontAsk` and the tools are
  Read, Grep and Glob, `gh issue view`, `gh pr view`, `gh pr diff`, `git log`,
  `git show`, and Write and Edit only under the variant's scratch dir. Any other
  call is denied, and the report lists the denials.
- One deviation: the shipped `gh` executor keeps `execFileSync`'s 1 MiB
  `maxBuffer`, and `branchWorkflowRuns` on a Renovate branch with 89 Actions runs
  returns more than that. A real observer run on this repo dies with `ENOBUFS`.
  The prototype passes the same call with a bigger buffer through the client's
  `internal.exec` seam.

## The fixture, and how faithful it is

There is no access to a real `state/<pipeline>/units.jsonl`, so `build-fixture.ts`
reconstructs one from this repo's GitHub history:

- **One `completed` unit per Phoebe-authored PR** in the window: the title starts
  `Phoebe:` and the first commit's git author is `Phoebe`. (Phoebe and the operator
  share the login `mikeallisonJS`, so the login cannot tell them apart.) The ref is
  the issue the PR closes. The kind is `dependencies` (pipeline `dependencies`) when
  that issue carries the dependency labels, `skill-updates` (pipeline `skills`) for a
  `phoebe/skill-updates/*` branch, `research` for `wayfinder:research`, and otherwise
  `issues`. `startedAt` is the PR's creation minus a made-up 8 to 40 minutes. `detail` is
  null, as a built-in kind's completed record would be.
- **Follow-up units** for later pushes by `Phoebe` onto a PR: commits less than 15
  minutes apart are one unit. The kind is read off the commit headlines (`review` →
  `reviews`, `merge main` / `merge blocker` → `conflicts`, `ci`/`test`/`changeset` →
  `checks`). Phoebe pushes onto Renovate PRs are `checks`, the only kind
  Renovate branches are admitted to.
- **Failures from issue and PR traces**:
  - each `<!-- phoebe-unit-timeout: n=N -->` comment in the window is a unit that
    produced no PR. When a comment from the run sits just before it, the record is
    `failed` and the `detail` is that comment. A bare marker 44 minutes to 3 hours
    after the one before is `timed-out` (`2700s budget exceeded`). Any other bare
    marker is `failed`. On a PR the marker comes from the timeout path itself, so
    it is always `timed-out`.
  - a marker under 3 minutes after the previous one, with no comment from the run, is the sweep re-arming a claim
    that never got a real run. #755 and #763 have 138 and 139 of these in two hours,
    and the counter keeps falling from 3 back to 1 without a quarantine. They are
    folded into the record before them, and `detail` says how many.
  - for those two issues, `detail` is the install error that #773 says killed every
    run there. It is marked `[reconstructed from #773]`.
  - "Phoebe quarantined this unit" sets `quarantined: true` on the record it follows.
  - `phoebe-checks-fail` and `phoebe-conflict-fail` comments with no marker after them are
    `failed` checks/conflicts units. The run's own explanation just above is
    prepended to `detail`. A `phoebe-blocked` comment is a `failed` unit too.

Where the fixture departs from what the engine would record:

- The engine records a run that ends normally without a PR as `completed`,
  and the stranded-unit sweep's quarantine never sets `quarantined` on the record
  (only the PR-shaped timeout path does). So in real history most of the failures
  above would carry no record flag at all, and the shipped observer would never see
  them. The fixture flags them because #980 asks what the prompt does with them.
- Tokens, cost, `headSha` and `engineCommit` are null. The models and efforts are
  the ones `.phoebe/phoebe.config.ts` gives each kind.

## Files

- `build-fixture.ts`, `run.ts`, `lib.ts`: the code.
- `variants/A.md`: verbatim copy of `kinds/observer/prompt.md`. `B.md`: stricter
  evidence and grouping. `C.md`: B plus proposals shown with title and first problem
  paragraph, and a fold-first rule. `D.md`: A's structure with the cause named in one
  sentence and cited, weak-evidence notes, one finding per cause, fixed problems left
  out, C's proposals file, and a fold only when the same fix applies. For D, code
  drops any finding under two distinct issues or PRs (`MIN_REFS`).
- `fake-proposals.json`: two invented prior proposals that only variants C and D see
  (#9901 open, #9902 closed `not_planned`), so the fold path runs. `matchesProblems` names the labelled problems each one's cause covers; the scorer reads it to judge a fold, and the agent never sees it. The report marks them fake.
- `calibration.json`: the labelled set of past problems in the window, as agreed.
  A problem with no finding counts as "omitted, fixed" when its diagnosing issue
  closed or its fix PR merged after the last flagged unit that showed it. The ship
  bar is at least 4 of 6 found or omitted as fixed, no noise finding, no wrong fold. `expect: "none"` marks noise no finding should rest on.
- `fixture/`: the generated history. `report/`: the generated report, plus each
  variant's rendered prompt, proposals file, findings and raw CLI output under `runs/`.
- `cache/`: GitHub reads, not committed.
