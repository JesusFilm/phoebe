---
"phoebe-agent": minor
---

GitHub App mode: a deployment can now authenticate to GitHub as an installed
GitHub App instead of carrying a fine-grained PAT per tenant (#155). Set
`GH_APP_ID` and `GH_APP_PRIVATE_KEY` (base64-encoded PEM) in the
deployment `.env` and leave a tenant's `GH_TOKEN` blank; the supervisor mints a
short-lived installation token for that tenant's repo — narrowed to that one
repository and the five onboarding permissions — and hands it to the engine
child. Tokens are refreshed before expiry and re-delivered at the next
work-unit boundary; a mint failure puts that tenant on hold without touching
its siblings. The App's private key never reaches any child env. See
`docs/github-app-mode.md` for registration, cost, and the per-tenant rate-limit
budget.

Every tenant resolves to one of two **credential arms** — `pat` (its own
`GH_TOKEN`) or `app` — and mixed fleets are supported. The arm is now visible
across the CLI: `phoebe boot` logs a per-arm tally, `phoebe list` shows an
`arm:` column (also in `--json`), `phoebe doctor` checks each tenant by its arm
(an App-arm tenant with no `GH_TOKEN` is healthy, not broken; the arm is only
determinable inside the container, so an unverifiable check reports `unknown`
and never fails `--check`), and `scripts/verify-tenant-token.mjs` verifies App
installations by their granted permissions.

Along the way, solo deployments gain what fleets already had: the engine child
runs on an IPC channel with a slot broker, so `PHOEBE_MAX_CONCURRENT_AGENTS`
now has its documented meaning in solo (default cap 1 — no behaviour change
unless you raise it), and the engine leases its credential over that channel at
the top of each poll instead of reading a fixed env var.

**Nothing changes for existing PAT deployments.** A tenant with a `GH_TOKEN`
never mints; the PAT arm remains the recommended solo default and is not
deprecated. App mode is new in this release and has not yet been run in
Phoebe's own dogfood deployment — treat it accordingly. Existing deployments that want the App arm need the two new
variables in the deployment `.env` — see `docs/github-app-mode.md` §7 for the
migration and `docs/configuration.md` for the variable reference.
