---
"phoebe-agent": minor
---

A local install shows the same tabs as a remote deployment, with nothing listening. The companion's main process watches the install's container through `docker compose events` and, while it is up, execs `phoebe status --json` every 15 seconds. What it emits is the relay's own `report` event, so the overview, pipelines, doctor, secrets and config tabs render either arm without asking which one they have.

`phoebe-agent/contracts` gains `LocalReportEvent`, `InstallDirectoryFacts` and `StoredReport` — the report triple with the relay's fingerprint left off, which is what lets one narrowing function serve both arms. The desktop bridge grows `installs.reports` and `installs.refresh` beside them.

A stopped install shows config, read from the file, and a pointer to the install tab; the other four say they need a running container, and the last report the window is still holding is not drawn. A refresh on a stopped install answers with the directory's facts and no report.
