---
"phoebe-agent": minor
---

The console's History tab has a **Run observer** button when a tenant on the deployment declares the observer kind, one per tenant when several do. It opens a small confirm with the lookback filled in as `14d`, and confirming starts a run: on a local install the companion runs `phoebe observe` in the container, through a new `installs.observe` call on the desktop bridge, and on a remote the console calls `POST /api/observe`. The deployment's reason for a refusal shows under the button. While a run is in flight the button is disabled, and its tooltip gives the start time. When the run settles the tab reads its page again, and the drawer links each `#N` in a unit's summary to that issue or PR. A deployment from before manual observer runs says it is too old to run the observer.
