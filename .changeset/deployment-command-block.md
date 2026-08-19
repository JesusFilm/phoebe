---
"phoebe-agent": minor
---

New bootstrapper-only config block `deployment` (#260, #261) for deployments
that do not run under Phoebe's Compose driver — Podman, a systemd unit, a
remote host, anything with its own start/stop incantation:

```ts
deployment: {
  startCommand: "podman compose -f container/compose.yml up -d",
  stopCommand: "podman compose -f container/compose.yml down",
  stopNowCommand: "podman compose -f container/compose.yml down -t 1", // optional
}
```

When the block is present, `phoebe start` runs `startCommand` and `phoebe stop`
runs `stopCommand` (`--now` runs `stopNowCommand`, falling back to
`stopCommand`) via `/bin/sh` with inherited stdio, and skips the docker-on-PATH
check, Compose discovery, settle wait, and killed-mid-run detection that belong
to the Compose path. `--build` warns and is a no-op. `startCommand` and
`stopCommand` must be declared together; a half-declared block or a blank
`stopNowCommand` is a config error. Like `engine` / `workspace` / `configDir`,
`resolveConfig` drops the block — the engine never sees it.

**Nothing changes when the block is absent** — `phoebe start` / `phoebe stop`
drive `container/compose.yml` exactly as in 0.6.0.
