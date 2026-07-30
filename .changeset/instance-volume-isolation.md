---
"phoebe-agent": patch
---

Stop two Phoebe instances on one host from sharing each other's clone. The
scaffolded compose file lives in a directory named `container`, so Compose
derived the same project name — and therefore the same "private" `/data/repo`,
`/data/state`, … volumes — for every repo on the machine. `ensureClone` then
adopted whatever clone was already there, so an instance could silently run its
git work against the wrong repo while its `gh` calls used its own `repoSlug`.

- The scaffold compose file now sets an explicit, overridable project name
  (`name: ${COMPOSE_PROJECT_NAME:-phoebe}`); `.env.example` documents setting
  `COMPOSE_PROJECT_NAME` uniquely per repo when sharing a host.
- `ensureClone` now verifies an existing clone's `origin` matches the configured
  `repoUrl` and fails loudly on a mismatch instead of adopting a foreign clone.
