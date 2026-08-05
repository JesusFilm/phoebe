---
"phoebe-agent": patch
---

Fix two container-boot blockers surfaced by dogfooding: the Corepack download
prompt hanging boot, and the agent child's `0711` permissions preventing it from
running.
