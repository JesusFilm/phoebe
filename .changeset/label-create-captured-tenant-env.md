---
"phoebe-agent": patch
---

`createLabel` runs through the captured `gh` executor so a concurrent
create's "already exists" error is recoverable, and `phoebe doctor` reads
each workspace tenant's `PHOEBE_*` overlay from that tenant's `.env` rather
than the doctor process's own environment.
