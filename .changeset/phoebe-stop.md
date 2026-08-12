---
"phoebe-agent": minor
---

`phoebe stop [--now]` drains and stops the deployment container from the host.
It resolves `container/compose.yml` from the current directory (no upward walk),
passes the deployment `.env` only when present, blocks for up to the fleet
supervisor's 1h drain grace (or 1s with `--now`), streams Compose progress, and
warns loudly when the container was SIGKILLed mid-run. Shared Compose discovery
and an injectable command runner land here for `phoebe start` (#187) to reuse.
