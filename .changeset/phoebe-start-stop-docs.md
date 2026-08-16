---
"phoebe-agent": patch
---

Teach `phoebe start` / `phoebe stop` at the three sites where the long compose
incantations lived.

- `phoebe upgrade --cli` now tells operators to run `phoebe start --build` instead
  of the raw `docker compose --env-file ../.env build && docker compose --env-file
../.env up -d` pair.
- `docs/upgrading.md` leads with `phoebe start [--build]` / `phoebe stop` for
  image rebuilds, the one-time chown step, and the multi-tenant clean-break
  upgrade. Raw compose is kept as a documented fallback with the `--env-file`
  explanation intact.
- The `container/compose.yml` template header teaches `phoebe start`,
  `phoebe stop`, and `phoebe start --build` as the primary lifecycle commands.
