---
"phoebe-agent": minor
---

A local install shows its deployment's tabs, with nothing listening. The companion's main process watches the install's container through `docker compose events` and, while it is up, execs `phoebe status --json` every 15 seconds. What it emits is a `report` event, which the overview, pipelines, doctor, secrets and config tabs render.

`phoebe-agent/contracts` gains `LocalReportEvent`, `InstallDirectoryFacts` and `StoredReport`. The desktop bridge grows `installs.reports` and `installs.refresh` beside them.

A stopped install shows config, read from the file, and a pointer to the install tab; the other four say they need a running container, and the last report the window is still holding is not drawn. A refresh on a stopped install answers with the directory's facts and no report.
