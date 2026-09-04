# Feature branches

**Who this is for:** anyone with a group of tickets that only makes sense landed
together, and anyone looking at a `phoebe/feature-*` branch wondering who put it
there. It answers when to reach for one, what Phoebe does once you have, and
which parts stay yours.

## When a feature branch is the right answer

Phoebe has two ordinary answers to "where does this ticket's branch start?", and
both of them end at the default branch, one ticket at a time. An unblocked ticket
branches off `main` and its PR targets `main`. A ticket declaring `Blocked by #N`
whose blocker has an open PR stacks on the blocker's branch, which orders the
merges but does not hold either one back.

That is the wrong shape for one case. A group of tickets can be individually
finished and collectively half-done: a rename applied to three call sites out of
five, a migration whose backfill lands next week, an API nobody calls yet. Each
ticket passes its own review. `main` is still broken, or at best confusing, until
the last of them arrives.

A feature branch is for exactly that group. Members branch off
`<branchPrefix>feature-<M>` rather than the default branch, their PRs target it,
and one integration PR lands the whole set on the default branch in a single
merge. The unit that has to land atomically is the feature, so the feature is
what gets a branch.

Two cases that look similar and are not:

- **Tickets that merely relate to each other.** A wayfinder map is not a feature.
  Siblings that each stand up alone on the default branch should go there one at
  a time, where review stays small and nothing has time to go stale.
- **Tickets that are sequential.** B needs A's code, but A is fine on `main` by
  itself. That is `Blocked by #A` and a stacked PR, described in
  [`work-kinds.md`](work-kinds.md#issues-start-new-work).

The cost is real and worth saying plainly. Nothing on a feature branch is visible
on `main` until a human merges the integration PR, so the feedback the default
branch gives you (CI against everyone else's work, other people reading the diff)
arrives late and all at once. And the branch needs keeping current with `main`
for as long as it is open. Phoebe does that part by default, and three settings
turn it off, both [below](#keeping-the-branch-current). The rest is the price of
landing the group in one piece.

## Arming it: `phoebe:feature` on the parent

Put `featureLabel` (default `phoebe:feature`) on the **parent** issue, meaning the
map or epic the group hangs from. That is the entire opt-in.

The label is a deliberate human act, the same as `readyLabel`. Phoebe never
applies it, never creates it in a repo that does not have it, and never infers a
feature from an issue graph on its own. Every wayfinder map has sub-issues, so if
the parent relationship alone made a feature, every map you have ever charted
would retroactively become one. "This is a map" and "this map lands on one
branch" stay two separate decisions, and only you make the second.

The parent is not a member of its own feature, and it needs no `readyLabel`:
the label says where its children's work goes, not that there is work here.
Members carry `readyLabel` or `researchLabel` exactly as they would have anyway.
Field defaults and the `PHOEBE_FEATURE_LABEL` override live in
[`configuration.md`](configuration.md#labels).

## Who counts as a member

Membership is inherited from the issue graph. Starting at the ticket, Phoebe
climbs parent links until it finds an ancestor wearing `featureLabel`, and that
ancestor's branch is where the ticket's work goes.

- **GitHub's native sub-issue relationship is the primary link**, which is what
  `/to-tickets` already writes when it splits a spec. Nothing about your planning
  pipeline has to change.
- **`Part of #M` in the body is the hand-authoring fallback**, matched by
  [`partOfPattern`](configuration.md#issue-graph-patterns--review-summary), for
  someone typing an issue into the browser with no sub-issue link to hand. Both
  are consulted at every hop, native link first.
- **The walk finds the nearest opted-in ancestor**, not the immediate parent, and
  gives up after five hops. Stopping at the parent would land a grandchild on
  `main` while its siblings land on the feature branch, which is the silent split
  this whole arm exists to prevent.
- **A parent in another repository reads as no parent.** Phoebe works one repo and
  could neither branch from nor open a PR against the other one.
- **A failed read leaves the ticket unaffiliated for that cycle**, so it is an
  ordinary ticket bound for the default branch rather than one routed on a guess.

Research children are members like everything else: a `researchLabel` ticket
under an opted-in parent bases on the feature branch, same as its siblings. The
consequence was accepted rather than missed. When such a ticket answers its
question by committing a document, that document's PR targets the feature branch,
so abandoning the feature strands the document on a branch nobody will merge.
What survives is the part that matters: wayfinder's protocol puts the resolution
comment on the ticket and a pointer in the map's _Decisions so far_, and both are
issue-level. The decision lives; the long-form write-up is what you lose.
Routing research children back to the default branch would have reintroduced the
split.

## What Phoebe creates, and what it never touches

Labelling the parent changes nothing on its own. Everything below happens the
first time Phoebe picks up a member:

1. **The branch.** `<branchPrefix>feature-<M>` (so `phoebe/feature-341` for a
   feature parented on issue 341), cut from `origin/<defaultBranch>`. Creating it
   is idempotent, so a branch that already exists is simply used. The name comes
   from the parent's issue number, which means it cannot drift or collide, and it
   sits inside `branchPrefix` so a `prScope: "phoebe"` tenant admits both the
   integration PR and the member PRs. The branch starts on one empty commit,
   because GitHub will not open a pull request between two refs at the same
   commit; a squash merge of the integration PR erases it.
2. **The draft integration PR**, from that branch to the default branch, titled
   with the parent issue's title and bodied `Part of #M`. It costs nothing to open
   early, it is the object a human watches the feature through, and it gives the
   janitors something to act on.
3. **The member's own branch and PR**, as usual, except that
   `<branchPrefix>issue-<n>` is cut from the feature branch and its PR targets the
   feature branch.

Three things Phoebe will not do to the integration PR: undraft it, merge it,
close it. It also never deletes a feature branch. Draft state is the standing
signal that the feature is still being assembled, and every way out of that state
is a human's to choose.

## What you own

- **Merging each member PR into the feature branch.** Phoebe merges nothing,
  here or anywhere. Auto-merging green members was considered while this arm was
  designed, and rejected: it would have left one review to do instead of a dozen,
  but it would have cost the rule that Phoebe never merges, and that rule is
  worth more than the saved clicks.
- **Marking the integration PR ready for review** when the last member has
  landed. That is how you say the feature is done.
- **Merging the integration PR** into the default branch. The feature exists on
  `main` at that moment and not before.
- **Deleting the branch afterwards**, if you want it gone.

## How the member issues actually close

Each member PR carries `Closes #<n>` in its body, like every PR Phoebe opens.
GitHub honours a closing keyword only on a PR bound for the **default** branch,
so on a member PR that line fires on nothing and the issue stays open when the PR
merges into the feature branch.

That is the honest outcome, not a gap to work around. Closing a member issue
whose work has reached only the feature branch is a claim that the work is done,
and the bill for that claim arrives the day the feature is abandoned with a dozen
issues closed against nothing.

So the closing keywords go on the one PR that does reach the default branch. A
sweep each cycle keeps a block in the integration PR body up to date, one line
per member PR that has merged into the feature branch:

```markdown
<!-- phoebe:closes:start -->

Phoebe adds a line here as each member PR merges into this branch. Edit around the block, not inside it.

Closes #401
Closes #402

<!-- phoebe:closes:end -->
```

Merging the integration PR then closes the set in one go, through GitHub's own
mechanism, at the moment the work reaches the default branch. Three rules govern
what appears in the block:

- **Merged members only.** A member PR that was opened and then closed unmerged
  put no work on the branch, so it earns no line.
- **The line comes from the head branch, not the body.** `<branchPrefix>issue-<n>`
  names issue `n`, and Phoebe derives that branch from the ticket it was handed,
  so it cannot name an issue whose work is elsewhere. The cost is that your own
  PR onto the feature branch earns no line, and neither does a stacked member
  whose PR merged into its blocker's branch — the sweep lists by base, so it
  never sees that one, even though the blocker's merge carried the work across.
  Write those `Closes` yourself, outside the markers, where the sweep leaves them
  alone.
- **Append only, inside the markers.** Everything outside them is copied through
  untouched and existing lines are never removed, so a cycle that reads a short
  list cannot silently drop a line, and editing around the block is safe. A line
  you wrote outside also counts as said: Phoebe adds no second line for an issue
  the body already closes, so the record never claims one issue twice.

The sweep that maintains the block runs every cycle and is not part of janitor
scope, so `draftPrs`, `prScope` and `prOptOutLabel` do not reach it. Whatever
else you switch off, the `Closes` lines keep accruing.

## What the janitors do with a feature

Member PRs are in scope. The cycle's PR listing is made once per base: the
default branch, plus the branch of every live feature. So a red member PR gets
`checks`, a conflicting one gets `conflicts`, and review feedback on one gets
`reviews`, exactly as if it were bound for `main`. This is a deliberate departure
from how Phoebe treats natively stacked PRs, which it leaves alone because GitHub
maintains them. Nothing maintains a member PR, and a red member PR never merges,
so leaving them alone would stall the feature without saying a word. The scope
rules in full are in
[`work-kinds.md`](work-kinds.md#which-prs-the-janitors-scan).

The integration PR is treated differently in two places. `reviews` never selects
it, because review activity there is a human reviewing the whole feature and
Phoebe answering it would be Phoebe reviewing the human's review of Phoebe.
`conflicts` selects it on a different test, described next.

### Keeping the branch current

A feature branch is long-lived by construction, because its members are not
landing on the default branch one at a time. So the default branch moves under
it. A branch that has merely fallen behind conflicts with nothing yet, meaning no
mergeability read would ever nominate it, and left alone it drifts until the PR
you finally sit down to review is a conflict pile.

So by default `conflicts` selects a feature's integration PR whenever the default
branch carries commits its branch does not, then works it down the path it
already had: the agent-free merge first, the `conflict` prompt when that dirties.
The selection and execution detail is in
[`work-kinds.md`](work-kinds.md#the-feature-branch-catch-up); the knob,
`featureBranchCatchUp`, is in
[`configuration.md`](configuration.md#feature-branch-catch-up).

Setting that knob to `false` retires the catch-up for the whole tenant. Two other
settings turn it off without mentioning it:

- **`prOptOutLabel` on the integration PR** takes the whole feature out of
  janitor scope, members included. That is the per-feature lever, and it is why
  the catch-up knob itself is global.
- **`draftPrs: "skip-all"`** hides every draft from the janitors, and the
  integration PR is a draft. A tenant on that setting gets no catch-up whatever
  `featureBranchCatchUp` says, and no `checks` or `conflicts` on the integration
  PR either. Member PRs are not drafts, so they stay in scope, and the `Closes`
  sweep is unaffected. If you run `skip-all` and want feature branches, catching
  the branch up with `main` is yours.

## Blockers, inside and across the boundary

`Blocked by #N` keeps working inside a feature. Two members of the same feature
stack the ordinary way, except that the floor of the stack is the feature branch
rather than the default one.

Across the feature's boundary neither side can stack on the other, because the
two branches are bound for different places, so the dependent waits. A member
blocked by an outsider waits for that PR to merge into the default branch, after
which the catch-up carries the work onto the feature branch and the member
proceeds. An outsider blocked by a member waits for the whole feature, since a
member's work reaches the default branch only when the integration PR does. Both
cases are named in the idle log. The full rules are in
[`work-kinds.md`](work-kinds.md#issues-start-new-work).

## Retiring and cancelling

A feature is live until its integration PR is terminal. Merged is the happy
ending. **Closed is the cancel lever**: close the draft integration PR and the
feature stops existing as far as routing is concerned. Closing the parent issue
retires it too, as a fallback for a feature abandoned without anyone touching the
PR.

Retiring changes nothing about the artifacts. The branch stays (Phoebe never
deletes one), and member PRs already open still target it. Retarget or close
those yourself. Cancelling is reversible for the same reason: reopen the
integration PR and the feature is live again, on the branch it always had.

What it changes is where the next member goes. A member still open and still
carrying a label Phoebe selects on becomes an ordinary ticket bound for the
default branch the next time Phoebe reaches it, and so does a member that arrives
late, after the feature has already merged. Phoebe has no basis for refusing to
work a labelled ticket: the feature branch was a routing decision, never a
permission.

So if cancelling the feature also means abandoning its tickets, close them or
strip every label that selects them — `readyLabel` on the implementation
children and `researchLabel` on the research ones. Miss the research children and
Phoebe will work them onto `main` one at a time, which is exactly the outcome
cancelling was meant to prevent.

## Related reading

- [`preparing-work.md`](preparing-work.md), what a ticket needs before any of
  this applies, and the planning pipeline that produces one.
- [`work-kinds.md`](work-kinds.md), base resolution, janitor scope, and the
  catch-up in mechanical detail.
- [`operating.md`](operating.md), `featureLabel` among the other levers a human
  drives Phoebe with.
- [`configuration.md`](configuration.md#labels), the field defaults and their
  environment overrides.
