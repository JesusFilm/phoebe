---
"phoebe-agent": minor
---

Selecting a deployment in the console now opens it. Three tabs, and a URL per
tab, so a deployment is something you can send someone.

**Overview** leads with the relay's own connection facts in their own panel —
connected since, last heard, who paired it, how the last socket closed — kept
apart from doctor, which answers none of them. Beside it: the engine ref and the
running SHA, the commit a crash-loop fallback is deliberately running away from,
what a reconcile is relaunching onto and why, and the slot broker's numbers.
Under the panels, every pipeline with its process line and its state line, the
tenants discovery is holding with the errors holding them, and any config edit
that is in a file and not yet in a commit.

**Pipelines** is one row per pipeline, with the units in flight counted against
the budget each was given and the wedged clause named when there is one — a unit
past its budget, or no loop pass in three poll intervals. A tenant that fills no
row is still a row.

**Doctor** is the last report the bootstrapper's run produced: the deployment's
checks and each tenant's, with the trigger, the age, a marker while a run is in
flight, and the last attempt that produced nothing. A deployment that has never
run doctor says so rather than reading as healthy.

A deployment that has never connected says that, instead of three empty tabs.

Doctor's fail count now joins the fleet's reading order too: the rail and the
grid say what the last run found and how long ago, and a failing check sorts a
deployment up beside a wedged pipeline and a crash-looping child.
