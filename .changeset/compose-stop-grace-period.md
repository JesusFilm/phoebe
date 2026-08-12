---
"phoebe-agent": patch
---

The scaffolded `container/compose.yml` now sets `stop_grace_period: 1h` so
`docker compose stop` gives the engine its full drain window (finish the work
unit in flight, start no new one) instead of Compose's 10-second default, which
was SIGKILLing mid-run. The value matches the fleet supervisor's
`DEFAULT_DRAIN_TIMEOUT_MS`.

**Existing deployments are not updated automatically** — `phoebe init` skips
files you already have. Add this under the `phoebe` service in your
consumer-owned `container/compose.yml`, then recreate:

```yaml
stop_grace_period: 1h
```

```bash
docker compose --env-file ../.env up -d --force-recreate
```
