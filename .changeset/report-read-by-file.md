---
"phoebe-agent": patch
---

The companion's tabs no longer sit on "Reading this install's report…" for a running container that cannot answer. The read loop now reads the deployment report file inside the container through `sh` rather than execing `phoebe status --json`, which prints the same bytes but needs `phoebe` on the container's PATH; a container that runs the engine from a mounted checkout, as this repo's own `.phoebe/` does, has none. And when a read does fail, the tabs say why: a container whose phoebe-agent predates the report is named as such, with the upgrade as the remedy.
