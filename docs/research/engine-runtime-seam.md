# Engine runtime seam: design record

Design record, 2026-08-18. Context: `src/main.ts` is the most-changed module in the repo
(15 of the last 60 commits) and the only one of its size with no test at all. This record
fixes the seam that makes the engine's cycle testable, and the chain of tickets that gets
there.

## Background

`src/main.ts` is 2402 lines, 77 top-level functions, one export (`runEngine`). It is not a
wiring module: it is the `gh` client, the git caller, the quarantine write path, the
un-stick sweep, the credential arm resolver, the work-kind registry, the idle reporter, and
the loop. Every other module under `src/` was carved out of it as a pure fragment — those
fragments have interfaces; the composition does not.

Two consequences.

**Nothing tests the cycle.** There is no `src/main.test.ts`. `src/orchestrator.ts` has a
1.8:1 test-to-source ratio; `main.ts` has 0:1. The suite documents `main.ts` behaviour in
prose and asserts it elsewhere — `src/quarantine.test.ts:98` reads "main.ts coerces a null
GitHub author to `""` … so such a comment must count toward the reset." The coercion is at
`main.ts:456`; the comparison it feeds is at `main.ts:2369`. Nothing exercises both.

**Nothing can.** Module-level constants bind the world at import time:

| Line    | Binding                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------- |
| 143     | `STARTUP_GH_TOKEN = process.env["GH_TOKEN"]` — the credential arm is frozen for the process's life |
| 165     | `RUN_TIMEOUT_MS = resolveRunTimeoutMs(process.env, config.runTimeoutMs)`                           |
| 169     | `CREDENTIAL_BUDGET_MS = RUN_TIMEOUT_MS + 10 * 60 * 1000`                                           |
| 181–186 | `PR_BASE`, `defaultBranchRef`, `inContainer`, `repoDir`, `worktreesDir`                            |
| 210     | `workOrder = validateWorkOrder(config.workOrder)`                                                  |

`src/cli.ts:569` records the constraint this creates: "Import after the config is installed
— main.ts's module-level constants read `config` at import time via the Proxy in
resolved-config.ts." A test would have to set env and call `setResolvedConfig` before a
dynamic `import()`, and could still never vary either within one file.

`runLoop` (`main.ts:2129`) already takes seven injected dependencies and is still not
callable from a test, because its body reaches `resolveArm()`, `config`, `KINDS`,
`fetchCycleWorkData` and `sweepQuarantine` as module state. The dependency-injection
ceremony is paid; the leverage is not collected.

## What we are buying

**A testable cycle.** Locality of GitHub knowledge is the means, not the end. Extracting a
GitHub client and stopping there would add a 26th module to a codebase whose problem is
that the composition is unverified.

## Decisions

### The seam is domain-shaped, not transport-shaped

**Decision: one `GitHubClient` module whose methods are named for what the loop wants.**

Three shapes were considered.

- **Thin transport** — `{ json<T>(args), api<T>(endpoint), run(args) }`. Three methods, a
  small diff, and a shallow interface: callers still construct `gh` argv, and every test
  fixture becomes a canned JSON string keyed by argv.
- **Domain-shaped** — ~20 methods (`listReadyIssues()`, `mergeInfo(pr)`,
  `fetchReviewThreads(pr)`, `postUnitComment(...)`). Argv, JSON shapes, error enrichment,
  pagination and retry all become implementation. A test double is an object literal
  holding only the methods that test touches.
- **Loop-shaped** — `WorkSource.fetchCycle(kinds)` plus a unit journal, ~6 methods. The
  deepest interface, but it absorbs `fetchCycleWorkData`, `CycleCache` and the four
  representations of one cycle's data, which is a reshape of the engine's own composition
  rather than a move.

Domain-shaped wins because it is the deepest interface reachable as a strict port. The
loop-shaped version is not foreclosed — it is built on top of this one later by moving
`fetchCycleWorkData` behind the same seam — but doing it now would make a behaviour-risk
change indistinguishable from a code move in review.

### The client is synchronous

**Decision: keep `execFileSync` behind the interface.**

Every `gh` call today is synchronous. An async client is the more honest interface for a
subprocess and would admit a `fetch`-based implementation, but it touches ~40 call sites
and their transitive callers, turning a port into a rewrite. The loop works one unit at a
time and gains nothing from concurrency. This is not a one-way door: going async later is
mechanical once a test proves the cycle still works.

One method is the exception, and it is not a hole in this decision: `mergeInfo` returns a
promise because the `UNKNOWN` retry it absorbs sleeps between attempts, exactly as
`getMergeInfoCached` (`main.ts:774`) does today. Its callers — `fetchConflictingPrs`,
`failingChecksCandidate`, `fetchReviewsWorkData` — are already `async` for that reason.
Making it synchronous would mean blocking the loop through the sleep, which is a behaviour
change, not a port.

### `gh` is the transport, and the second adapter is the test double

**Decision: no REST adapter is planned.**

`gh` carries auth resolution, pagination and retry we would otherwise reimplement, and the
consumer image installs it deliberately. This makes the seam a **mock-category** seam: it
has one production adapter, and it earns its keep on the test double alone. That is a
deliberate exception to "one adapter means a hypothetical seam" — recorded here so a future
architecture review does not re-litigate it, and it obliges us to design the double for
ergonomics rather than fidelity (see below).

### The client is scoped per cycle

**Decision: `github.forCycle()` returns a scoped client; `CycleCache` is deleted.**

`CycleCache` (`main.ts:189`) memoizes `listOpenPhoebePrs` and `viewPrMergeInfo` for one
poll, and is hand-threaded through 12+ sites — every `WorkKind.fetch(cache)`,
`fetchConflictingPrs(cache)`, `conflictingPrCandidate(pr, cache)`. `getMergeInfoCached`
(`:774`) additionally holds the `mergeable === "UNKNOWN"` retry loop, which is a GitHub
quirk — merge state is computed server-side and is briefly unknown — and therefore client
knowledge, not loop knowledge.

The threading was never the problem. The problem is that `cache` and the `gh` functions are
two halves of one thing, so a caller has to know both. Making the threaded value _be_ the
client keeps the memo's lifetime unforgettable: there is no `beginCycle()` to omit, because
the scope is the object's lifetime. The 12 sites keep a parameter; it is now
`CycleGitHubClient` rather than `CycleCache`.

### The engine is constructed, not imported

**Decision: `createEngine({ config, env, github, git, clock })` returns `{ runLoop }`.**

Every module-level constant above becomes a local inside the factory, and `config` is
passed in rather than read from the `resolved-config.ts` Proxy. `runLoop`'s seven
parameters collapse into the closure — a factory holding five collaborators while
`runLoop` also takes seven arguments is the worst of both, because a caller would have to
learn which mechanism carries what. `runLoop()` takes no arguments.

`src/cli.ts` builds the engine after `setResolvedConfig` as it does today; the dynamic
`import()` and the comment at `cli.ts:569` are deleted. `resolved-config.ts` stays for the
modules not yet converted.

Collapsing `runLoop`'s parameters is not the same as making them disappear. Seven values
reach it today, and `runEngine` (`main.ts:2043–2127`) derives them from argv, env and the
IPC channel: `runOnce` and `dryRun` from argv, `pollIntervalMs` from
`PHOEBE_POLL_INTERVAL_MS`, and `drain`, `slotClient`, `credentialClient` and
`emitUnitEvent` from four constructors. They become the factory's inputs, not process
state the factory reads for itself — `createEngine` takes the four collaborators
alongside `github`/`git`/`clock`, and the two flags plus the interval come from an
explicit run-options argument. Ticket B fixes the exact split; what it may not do is have
the factory reach `process.argv` or `process.env` internally, because a cycle test must be
able to say "run once, dry, with this drain signal" without touching either.

### The client has an internal seam for its own tests

**Decision: a private injectable executor, not exported.**

The test double sits at the client's interface, so nothing would otherwise verify argv
construction, the `-R <repoSlug>` suffix, `--json` field lists, or GraphQL cursor handling.
An internal seam — private to the implementation, used only by `github-client.test.ts` —
covers those. It is not part of the interface and carries no obligation to cover every
method; the three error-prone spots are pagination, the `-R` suffix, and the `--json` field
lists, which silently yield `undefined` fields when misspelled.

## The interface

`src/github-client.ts`. Signatures are indicative — the ticket fixes exact types against
the existing branded types (`PrNumber`, `Sha`, `BranchRef`) and the row shapes already
declared in `main.ts`.

```ts
type GitHubClient = {
  // Issues
  listReadyIssues(): Issue[];
  listResearchIssues(): Issue[];
  issueBody(issueNumber: number): string;
  blockerPrState(blockerIssueNumber: number): BlockerPrState;

  // Pull requests
  listOpenPhoebePrs(): OpenPhoebePr[];
  currentMergeInfo(prNumber: PrNumber): PrMergeInfo; // uncached; for the post-agent re-check
  prCommentBodies(prNumber: PrNumber): string[];
  commitCheckItems(headSha: Sha): WorkflowRunItem[];
  reviewThreads(prNumber: PrNumber): ReviewThread[]; // paginates internally
  reviewSummaryComments(prNumber: PrNumber): GhComment[];
  findIssuePr(issueNumber: number): PrNumber | null;
  createPr(opts: { head: BranchRef; base: string; title: string; body: string }): void;

  // Quarantine + timeouts
  listQuarantinedIssues(): QuarantinedUnit[];
  listQuarantinedPrs(): QuarantinedUnit[];
  issueTimeoutInputs(issueNumber: number): UnitTimeoutInputs;
  prTimeoutInputs(prNumber: PrNumber): UnitTimeoutInputs;

  // Writes
  postPrComment(prNumber: PrNumber, body: string): void;
  postUnitComment(unit: UnitRef, body: string): void;
  addQuarantineLabel(unit: UnitRef): void;
  removeQuarantineLabel(unit: UnitRef): void;

  // Identity
  resolveLogin(envLogin: string | undefined): string;
  issueAuthorLogin(issueNumber: number): string | null;
  lookupUser(login: string): GitHubUser;

  // Cycle scope
  forCycle(): CycleGitHubClient;
};

// Adds the per-poll memo; everything else is inherited. The two uncached reads it
// replaces are omitted, and so is `forCycle` — a cycle caller can neither reach past
// this memo nor open a second one inside it.
type CycleGitHubClient = Omit<
  GitHubClient,
  "listOpenPhoebePrs" | "currentMergeInfo" | "forCycle"
> & {
  openPrs(): OpenPhoebePr[]; // memoized listOpenPhoebePrs
  mergeInfo(prNumber: PrNumber): Promise<PrMergeInfo>; // memoized, UNKNOWN-retry
};
```

`resolveLogin` takes the env value rather than reading `process.env` inside the client:
`gh api user` 403s under an installation token, so `PHOEBE_GH_LOGIN` must win when set
(`main.ts:799–806`), and the factory already holds `env`.

The client owns `repoSlug` from the config it is built with, so no method takes it.
`rethrowAsGhError` and `tryFetchRateLimitReset` (`main.ts:233–256`) move inside.
`src/gh-error.ts` is untouched: it is pure classification with 191 lines of passing tests
and is usable by anything else that shells out to `gh`.

## The test double

`stubGitHub(overrides)` fills every un-stubbed method with a thrower naming the method.

A test declares exactly the surface it depends on, and an unexpected call fails loudly
instead of quietly returning `[]` — which is precisely the failure mode that let
`logIdleCycle` (`main.ts:1921`) drift from the real selection path without anything
noticing. It is a stub, not an in-memory implementation of GitHub: it holds no state, so
it never needs tests of its own and cannot become a second thing to keep correct.

## Acceptance criterion

After ticket A:

```text
grep -n "execFileSync\|execSync" src/main.ts
```

returns only the git caller (`:886`) and the two shell executors (`:895`, `:906`). No `gh`
spawn remains in `main.ts` — including the raw GraphQL page fetch at `:1308` and the
rate-limit probe at `:239`.

There are 25 `gh` call sites to move: 16 `ghJson`, 2 `ghApiJson`, 5 `gh`, plus the two raw
`execFileSync` calls that bypass those wrappers (the GraphQL page fetch at `:1308` and the
rate-limit probe at `:239`). The three `execFileSync` calls _inside_ `ghJson`, `ghApiJson`
and `gh` are not call sites — they move with the wrappers.

## Non-goals

Recorded so the tickets stay narrow and so a future review knows these were considered, not
missed:

- **No async.** Decided above.
- **No `WorkSource` reshape.** `fetchCycleWorkData`, the `WorkKindFetch` union and
  `CycleWorkData` keep their current shape. Collapsing the four representations of one
  cycle's data is separate work, enabled by this one.
- **No git or shell seam yet.** `git-model.ts` already accepts `git: GitRunner = defaultGit`
  on every function; `main.ts:860–866` simply never passes one. Ticket C threads it. The
  toolchain shell (`runShellCommand`, `promptShell`) has no seam and does not get one here.
- **No behaviour fixes.** The `author: null → ""` coercion, `logIdleCycle`'s hardcoded kind
  order, and the `sweepQuarantine`/`sweepDisabledQuarantine` duplication are all real and
  all left alone until ticket D, where each lands with the test that proves it. The port
  is strict.

`docs/architecture.md`'s "Provenance" section records what happened the last time a large
change to this file was described as behaviour-preserving and wasn't. The non-goals above
exist so this record does not need a sequel.

## Verification

There is no test protecting the port — that is the problem being solved. Ticket A is
verified by review plus a smoke check: this repo is its own consumer
(`phoebe.config.ts` at the root), so capture `phoebe --dry-run --run-once` against
`JesusFilm/phoebe` before the change and diff it after. It needs a `GH_TOKEN` with read
access and is only as good as whatever work happens to be live that day — a smoke check,
not proof. Characterisation tests written against the current shape were rejected: ticket C
would throw them away a week later.

## Follow-up tickets

**Ticket A — extract `src/github-client.ts`.** Move the 25 `gh` call sites,
`rethrowAsGhError`, `tryFetchRateLimitReset` and the GraphQL pagination loop behind the
interface above. Delete `CycleCache` in favour of `forCycle()`; the 12 threading sites take
`CycleGitHubClient`. Add the internal executor seam and `github-client.test.ts` covering
argv for pagination, the `-R` suffix and the `--json` field lists — plus the two behaviours
`forCycle()` adds that no argv assertion would catch: one `pr list` per cycle and none
across cycles, and the `UNKNOWN` retry giving up at its budget. The loop's own tests use
`stubGitHub`, so this file is the only thing that exercises the production adapter. `main.ts` builds one
client from `config` for now. Done when the acceptance criterion holds and `vp check` /
`vp test` pass.

**Ticket B — `createEngine` factory.** Move every module-level constant listed in the
Background into the factory; pass `config` explicitly instead of importing the Proxy;
collapse `runLoop`'s seven parameters into the closure so `runLoop()` takes none. Delete
the dynamic `import()` and the constraint comment in `src/cli.ts`. No behaviour change.

**Ticket C — the first cycle test.** Thread `GitRunner` through `main.ts:860–866` so
`currentConflictFailureWatermark` and `currentChecksFailureWatermark` are substitutable.
Then `src/main.test.ts`: selection across all five work kinds against `stubGitHub` plus a
git stub, watermarks included, and `--dry-run` output asserted. This is the ticket the
chain exists for; A and B are prerequisites, not the deliverable.

**Ticket D — the divergences, each with its test.** The `""` author coercion
(`main.ts:456` / `:2369`); `logIdleCycle`'s kind order versus `workOrder`; the three-line
diff between `sweepQuarantine` and `sweepDisabledQuarantine`. One change each.
