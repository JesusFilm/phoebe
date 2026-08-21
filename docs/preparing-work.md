# Preparing work

**Who this is for:** anyone deciding what to hand Phoebe. It answers what an
issue has to contain before Phoebe can work it, and why that matters more here
than it does with an agent you are sitting next to.

## Why the issue carries the weight

Phoebe works away from the keyboard. Nobody is watching when it starts, and
nobody is there to answer it halfway through.

That single fact changes what an issue has to be. While you are watching an
agent, an ambiguous decision surfaces as a question and you answer it in a
sentence. Once you have walked away, the agent picks a default and keeps going,
and every later decision builds on that guess. The failure mode is rarely a
crash. It is a branch full of finished, confident, internally consistent work
resting on a wrong call made in the first ten minutes, which is expensive to spot
and worse to unpick. Matt Pocock's [AI Coding Dictionary](https://www.aihero.dev/ai-coding-dictionary/afk)
makes the same point about AFK sessions generally.

So the leverage is not in the prompt or the model. It is in the issue. Ambiguity
has to die before the `ready-for-agent` label goes on, because after that there
is nobody left to resolve it.

**Front-loading** is the name for that work: creating the issues, maps, and
grilling sessions that turn into `ready-for-agent` or research issues for Phoebe.

## The division of labour

Phoebe is one half of a pair.

|                         | Handles                                                                                                                                                  | Needs a human          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **A planning pipeline** | Every decision that needs a person: what to build, what the words mean, which trade-off wins, what "done" is.                                            | Yes, by design.        |
| **Phoebe**              | Everything downstream that is mechanical: working the ticket, resolving conflicts, fixing red CI, answering review feedback, resolving research tickets. | No. That is the point. |

A planning pipeline that produces unambiguous tickets makes Phoebe effective. A
Phoebe with no such pipeline in front of it will confidently build the wrong
thing, quickly and in parallel.

Phoebe does not care which pipeline you use. It cares what comes out of it.

## What Phoebe needs from any process

Whatever you use, whether that is a skill suite, a refinement meeting, or you and
a text editor on a Sunday, the output has to be an issue that clears this bar:

- **It carries the `readyLabel`** (default `ready-for-agent`). Phoebe only ever
  reads this label; applying it is a deliberate human act. This is the lever, and
  nothing else in the system substitutes for it.
- **It is sized to one unit of work.** Phoebe works one issue start to finish in
  a single cycle, on one branch, in one worktree. An issue that is really five
  issues will come back as one confused pull request.
- **It states the decision, not just the symptom.** "Login is broken" is a report.
  "Reject a session whose token expired mid-request, returning 401 rather than
  500" is a ticket. If a reader could reasonably build two different things from
  the body, so could Phoebe.
- **Its blockers are declared.** `Blocked by #N` in the body is honoured during
  selection: a blocked ticket with no blocker PR is skipped for that cycle.
- **It says where the answer lives** when the work needs context that is not in
  the issue: a file, a prior decision record, a linked ticket.

Nothing above mentions a particular tool. If your process already produces issues
like that, Phoebe will work them today.

## The worked example: the AI Hero skills

The pipeline Phoebe was built alongside is
[Matt Pocock's skills](https://github.com/mattpocock/skills), vendored in this
repository under [`.agents/skills/`](../.agents/skills) and pinned by content hash
in [`skills-lock.json`](../skills-lock.json). It is one way to do the front-loading,
and it is the one this repository uses on itself.

The path from a fuzzy idea to something Phoebe can pick up:

1. **[`/grill-with-docs`](https://www.aihero.dev/skills-grill-with-docs)** interviews
   you about the idea until you and the agent share one understanding of it,
   writing settled vocabulary into `CONTEXT.md` and hard decisions into ADRs as it
   goes. ([`/grill-me`](https://www.aihero.dev/skills-grill-me) is the same
   interview with no repository under it, and
   [`/grilling`](https://www.aihero.dev/skills-grilling) is the primitive both run.)
2. **[`/to-spec`](https://www.aihero.dev/skills-to-spec)** collapses that thread into
   a spec without interviewing you again.
3. **[`/to-tickets`](https://www.aihero.dev/skills-to-tickets)** splits the spec into
   tracer-bullet tickets, each declaring its blocking edges.
4. **Label the tickets `ready-for-agent`.** This is the handoff. Everything before
   it needed you; everything after it does not.

For an effort too large to hold in one session,
[`/wayfinder`](https://www.aihero.dev/skills-wayfinder) charts it as a map of
decision tickets first and resolves them one at a time until the way is clear,
then hands off to `/to-spec`. Phoebe has direct support for this, described below.

Two videos, if you would rather watch than read:

- [mattpocock/skills: A complete AI Coding workflow, end-to-end](https://www.youtube.com/watch?v=M6mYodf0dJM)
  walks the whole path above.
- [LIVE: The /wayfinder Demo](https://www.youtube.com/watch?v=251hsWgoTPM) covers
  the large-effort case.

## Where Phoebe meets wayfinder directly

The [`research` work kind](work-kinds.md#research--resolve-wayfinder-research-tickets)
exists for this pipeline specifically. It picks up open issues labelled
`researchLabel`, which defaults to `wayfinder:research`, and follows wayfinder's
resolution protocol: investigate primary sources, produce a Markdown summary,
post a resolution comment, close the ticket, and append a pointer to the parent
map's decisions.

That is the one place where a default value in
[`configuration.md`](configuration.md#labels) names an external skill. It
is deliberate, and it is not a lock-in: the engine keys off the **label alone**,
never the parent-map relationship. Point `researchLabel` at whatever your tracker
calls a research ticket and the kind works the same way.

Research tickets are worth calling out because they are the part of planning that
is itself AFK-able. Deciding what to build needs you. Reading four sets of
primary-source documentation to answer a question the decision depends on does
not. Phoebe can burn those down in parallel while you keep thinking.

## Related reading

- [`operating.md`](operating.md) — the labels and levers for steering Phoebe once
  work is in flight.
- [`work-kinds.md`](work-kinds.md) — how each kind selects and executes a unit.
- [The AI Hero skills index](https://www.aihero.dev/skills) — the full set,
  including the ones that never touch Phoebe.
