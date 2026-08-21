# Cycle record seam: design record

Design record, 2026-08-21. Context: `engine-runtime-seam.md` deferred the `WorkSource`
reshape as a non-goal because it would have made a behaviour-risk change indistinguishable
from a code move, with no test to hold it still. The tickets on that chain have since
landed, and `src/main.test.ts` now covers selection across all five work kinds. The reason
for deferral has expired. This record supersedes the "No `WorkSource` reshape" non-goal in
`engine-runtime-seam.md` and establishes the design the follow-up tickets work to.

## Background

`fetchCycleWorkData` (`main.ts:1471`) gathers one cycle's work data and returns
`CycleWorkData`. One cycle's data passes through five representations before selection reads
it:

| Representation              | Where                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `WorkKindFetch` variants    | returned by `KINDS[kind].fetch(cycle)` inside the loop                              |
| Local accumulator variables | `issues`, `conflictingPrs`, `issueBodies`, … inside `fetchCycleWorkData`            |
| `CycleWorkData`             | the merged result returned to the loop                                              |
| Inline object literal       | the second argument to `selectFirstWorkUnit(workOrder, { issues: data.issues, … })` |
| `WorkSelectionData`         | what the selectors in `orchestrator.ts` actually read                               |

The middle three are all the same data in different containers. Two of them exist only to
thread the value from `fetchCycleWorkData` to `selectFirstWorkUnit`.

**The motivating defect: #290.** `issueBodies` is one of those representations. `conflicts`
set it with a direct assignment (`issueBodies = fetched.issueBodies`); `checks` and
`reviews` merged into it. So any `workOrder` that runs `conflicts` after `checks` or
`reviews` silently discarded the bodies gathered before it. The loss was silent because
`selectChecksCandidates` coerces a missing body to `""`, and an empty body parses as no
blockers. A PR whose body says it is stacked reads as not stacked, and gets worked.

The defect was latent for as long as the shipped default order happened to run `conflicts`
first. `validateWorkOrder` accepts every permutation of the five kinds. Nothing stated why
the order mattered.

## What we are buying

**A module, not a function.** `fetchCycleWorkData` is a function closed over the engine's
github client, git paths, work-kind definitions, and environment. It has no name a caller
can inject, no interface a test can substitute, and no visible boundary between what it
assembles and what it returns. The gather logic belongs to a module with a declared
collaborator set. Issue bodies belong to that module, not to the caller's merge loop.

**The ordering constraint made structurally impossible.** When the work source owns the
issue-body cache, there is no per-kind `issueBodies` return value left to merge in the
wrong order. The defect cannot recur.

## Decisions

### Issue bodies are a cycle-scoped read-through cache

**Decision: `issueBodies` is no longer a `WorkKindFetch` field.**

Each of the three PR-based kinds currently fetches the issue bodies it needs and returns
them as a map in its `WorkKindFetch` variant. `fetchCycleWorkData` then merges the three
maps, and the merge is where the ordering constraint lives.

Under this design the work source maintains one `Map<number, string>` for the cycle and
reads an issue body exactly once, caching the result. Any kind that needs a body asks the
cache; the cache fetches on first access. Nothing is returned per kind and nothing is merged
after the fact. The `CycleRecord` carries one map, already complete.

### The record carries its walk order

**Decision: `CycleRecord` carries `kindsGathered`.**

`fetchCycleWorkData` today receives the kinds to gather but the resulting `CycleWorkData`
does not record which kinds were actually fetched. The caller re-derives this from `runOnce`
and passes it as the `oneShotOnly` option to `selectFirstWorkUnit`. When the record carries
the kinds it was gathered for, the one-shot rule is derived once — from the record itself —
instead of twice from a flag the engine loop threads separately.

### The work source takes an origin hub, not a git runner and two paths

**Decision: `WorkSource` takes an `originHub` collaborator.**

`fetchConflictWorkData` calls `fetchOrigin()` (a `git fetch origin` against the engine's
private clone) and reads the resulting `origin/<defaultBranchRef>` head SHA. These are two
operations on one thing: the origin hub, which CONTEXT.md already defines and which already
exists unnamed as a pair of locals (`repoDir` and `defaultBranchRef`). Naming the
collaborator once in the work source's constructor makes the dependency visible and makes the
work source substitutable in tests without touching git paths directly.

### Five representations become three, not two

**Decision: keep `WorkKindFetch`; add `CycleRecord`; `WorkSelectionData` stays.**

A reader might expect the reshape to produce two representations — one per kind, one for
the cycle — but run-time and selection-time genuinely want different things.

`WorkSelectionData` (`orchestrator.ts:816`) carries `phoebeBase` (an env-derived string the
work source does not own) and is shaped for what the selectors consume. It is not the same
shape as what the gather produces. Collapsing the two would push env-reading into
`orchestrator.ts` or push selector concerns into the work source. Neither is right.

The three that remain:

| Representation      | What it is                                                                  |
| ------------------- | --------------------------------------------------------------------------- |
| `WorkKindFetch`     | what a single kind's fetch step returns, internal to the work source        |
| `CycleRecord`       | what the work source returns: flat, with `kindsGathered`, one `issueBodies` |
| `WorkSelectionData` | what the selectors read: adds `phoebeBase`, different invariants            |

The local accumulator variables and the inline object literal in the loop disappear.

### The failure contract

**Decision: state the two existing behaviors and let the interface repeat them.**

Today, a single unreadable pull request inside a kind's fetch is warned and skipped — the
gather continues and the PR is absent from the result. A whole work kind failing to fetch
throws; the error propagates through the cycle, kills the engine, and the bootstrapper's
restart loop is the recovery path. Both behaviors are deliberate. Neither is written down.

The work source preserves both unchanged: per-PR errors are absorbed internally and logged,
whole-kind errors propagate to the caller. The interface states this in its method comment
so a future reader cannot mistake the propagating throw for an oversight.

## The interface

`src/cycle-work-source.ts`. Signatures are indicative.

```ts
type CycleRecord = {
  /** The kinds that were gathered, in gather order. */
  kindsGathered: readonly WorkKindName[];
  issues: readonly Issue[];
  researchIssues: readonly Issue[];
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  conflictingPrs: readonly ConflictingPrCandidate[];
  failingCheckPrs: readonly ChecksCandidate[];
  reviewActivityPrs: readonly ReviewsCandidate[];
  /**
   * One cycle-scoped map, populated as a side effect of the gather.
   * Never merged; nothing left to get wrong.
   */
  issueBodies: ReadonlyMap<number, string>;
  phoebeLogin?: string;
  currentMainHead?: Sha;
};

type WorkSource = {
  /**
   * Gather one cycle's work data across the given kinds in order.
   *
   * A single unreadable pull request is warned and dropped from that kind's
   * results; the gather continues. A whole kind failing to fetch throws — the
   * bootstrapper's restart loop is the recovery path.
   */
  gatherCycle(kinds: readonly WorkKindName[]): Promise<CycleRecord>;
};
```

The `WorkSource` constructor takes `originHub`, `github` (`GitHubClient`), and the work-kind
definitions the engine already holds. Selection is not its concern.

## Non-goals

Recorded so the follow-up tickets stay narrow, and so a future review knows these were
considered rather than missed:

- **No lazy gather.** Every kind in the walk order is still fetched even though selection
  stops at the first kind with a workable unit. Making gather lazy is a behaviour change
  with its own test.
- **No work source owning selection.** The single selection walk (`selectFirstWorkUnit` in
  `orchestrator.ts`) landed recently and is well covered; absorbing it into the work source
  now would re-litigate fresh work.
- **No per-kind sub-records.** The record stays flat. A kind-keyed structure would need
  the same merge logic under a different name.
- **No partial-gather recovery.** Deciding what a half-gathered cycle should do — which
  unit to select, whether to surface the error — is its own ticket.
- **Not the resolved-config Proxy**, and **not splitting the selectors by work kind.** Both
  are real, both came out of the same architecture walk, and neither belongs in this chain.

## Verification

`src/main.test.ts` already covers selection across all five work kinds. Ticket A adds
`src/cycle-work-source.test.ts` covering the issue-body cache (one read per number per
cycle, no read across cycles) and the failure contract (per-PR warn-and-continue; whole-kind
propagate). `vp check` / `vp test` are the gate.

## Follow-up tickets

**Ticket A — `src/cycle-work-source.ts`.** Extract `fetchCycleWorkData` and its helpers
(`fetchConflictWorkData`, `fetchChecksWorkData`, `fetchReviewsWorkData`, `harvestIssueBodies`)
into a new module behind the `WorkSource` interface above. Replace per-kind `issueBodies`
fields with one cycle-scoped read-through cache on the work source instance. Return
`CycleRecord` with `kindsGathered`. The constructor takes `originHub`, `github`, and
`KINDS`. Add `cycle-work-source.test.ts` covering the cache invariant and the failure
contract. `CycleWorkData` is deleted. Done when `vp check` / `vp test` pass and no
`issueBodies` merge logic remains in `main.ts`.

**Ticket B — wire into `createEngine`.** Replace the `fetchCycleWorkData(fetchKinds)` call
in the loop with `workSource.gatherCycle(fetchKinds)`. Derive `oneShotOnly` from
`record.kindsGathered` rather than the `runOnce` flag. Adjust the `selectFirstWorkUnit` call
to build `WorkSelectionData` from `CycleRecord`. No behaviour change — the gate is the
existing `src/main.test.ts` suite passing unchanged.
