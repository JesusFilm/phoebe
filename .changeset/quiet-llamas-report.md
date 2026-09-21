---
"phoebe-agent": minor
---

`phoebe status` answers "is it alive, and what is it doing" in one verb, from one
source. It reads the deployment report (`state/deployment.json`) and renders it
top to bottom in priority order. First the bootstrapper line, carrying the engine
ref, the commit actually running, a quarantine or reconcile in progress, the slot
cap and the report's age. Then the relay line, when there is a relay. Then the
fleet, two lines per pipeline: what the supervised process is doing, and what the
pipeline itself is doing. Then doctor in one line. Run it on the host and it
drives the deployment's Compose file and execs itself inside the container, the
way `start` and `stop` already do, passing flags and exit code through.

`--verbose` inlines doctor's table. `--json` prints the report file byte for
byte. `--check` exits 1 when something needs a look: a wedged pipeline, a
crash-looping one, a failing doctor check, a held tenant, no bootstrapper, or no
report. Nothing in the view is computed twice. Every state and verdict is the one
the bootstrapper already derived, which is what stops the CLI and a console
disagreeing about a pipeline.

A missing or old report is stated as a fact. With `phoebe boot` not running, the
view opens with "bootstrapper not running; last report N ago" and prints the
report beneath it. With no file at all it says that instead. There is no
staleness threshold and no invented state.

`phoebe list` is now a deprecated alias for that fleet section, with a one-line
notice, and goes away at the next major. Two things it used to print go with it:
the `N of M declared tenant(s)` header and the `undeclared:` footer. Neither has
a home in the deployment report yet. `phoebe pipelines`, `phoebe doctor` and
`phoebe purge` are unchanged.
