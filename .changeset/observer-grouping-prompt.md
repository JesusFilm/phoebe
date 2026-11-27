---
"phoebe-agent": minor
---

The observer's grouping run has a new prompt. It names each finding's cause in one sentence and cites the units or review comments that show it. It treats bot review threads and a lone slow merge as weak evidence, makes one finding per cause, and reuses an earlier proposal's key only when that proposal's fix would also fix the new units. A problem whose fix merged after the units that showed it is left out. The prompt no longer allows a finding on one unit.

Code now drops any finding whose units ran on fewer than two distinct issues or PRs, and logs each one it drops. A unit on a PR counts as the issue that PR was opened for. `proposals.json` gives each earlier proposal its `title` and `problem`, the first paragraph of what it said keeps going wrong. A comment that adds units to an open proposal opens with the finding's cause.

`findings.json` takes an optional `omitted` list of `{ cause, fixedBy, units }` for the problems the run left out as already fixed. Nothing is filed from it. The run's summary, the `detail` of its unit record, ends with each entry's cause and the ref that fixed it. An `omitted` that is not a list fails the run, and a malformed entry is dropped. `MentioningIssue` and `MentioningPr` now carry `title`.

The observer has no model default of its own. `pipelines.<name>.kinds.observer.{provider, model, effort}` sets the provider, model and effort of its grouping and edit runs, and the tenant's default applies when the block names none. The observer docs now say so.
