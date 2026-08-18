---
"phoebe-agent": minor
---

Credit the issue author on Phoebe's commits (#198). On the issue-to-PR path
(`issues` and `research` units) the engine now appends
`Co-authored-by: <login> <id>+<login>@users.noreply.github.com` — the issue's
author — to every commit it pushes for that unit, so the human who filed the
ticket gets contribution-graph credit for the work it produced. The trailer is
applied by the engine after the agent runs and before the push (a message-only
rewrite of the unit's own commits), so operator prompt overrides need no change.

Policy, decided here: it applies to every issue Phoebe works — applying
`readyLabel` is already a maintainer's deliberate act — and never to the janitor
kinds (`conflicts` / `checks` / `reviews`), which have no single requester. Bots
and deleted accounts are never credited. Credit is best-effort: a failed author
lookup, a merge commit in the range, or a failed rewrite leaves the commits
exactly as the agent made them and logs why.

New config field `creditIssueAuthor` (default `true`). Set it to `false` on a
repo where a drive-by reporter's name on agent-written code would read as
misattribution rather than credit. The opt-out is the operator's only — there
is deliberately no per-issue or per-author switch.
