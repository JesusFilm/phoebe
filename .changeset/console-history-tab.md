---
"phoebe-agent": minor
---

The console has a History tab on every deployment page, local and remote. It lists unit records newest first, with filters for pipeline, work kind, outcome and model. Each filter sends a new history query rather than narrowing the page already loaded, and **Show more** loads the next page. Clicking a row opens a drawer with the unit's outcome, age and cost, its provider, model, effort, duration and tokens, a link to its issue or PR on GitHub, and its agent runs, with `partial` on a run whose usage is incomplete. API spend shows in dollars. A subscription estimate shows in dollars with a muted "est.". A unit with no reported cost shows a muted dash. Each has a tooltip saying which it is. A deployment too old to serve history says so instead of showing an empty table. On a local install the companion runs `phoebe history --json` in the container, through a new `installs.history` call on the desktop bridge. A remote is read through `GET /api/history`.
