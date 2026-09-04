---
"phoebe-agent": minor
---

Per-pipeline credentials: `requiredEnv`, `agentEnv`, and the subtractive pipeline scrub (#425). A work kind can now declare the env keys its code reads. `requiredEnv` names them; `agentEnv`, empty unless set, is the subset the kind's agent children also see — the one kind-scoped hole in the otherwise fixed agent allowlist. Values still live in the tenant's one `.env`; there is no per-pipeline secret file and no new config field.

Declaring a key scopes it. The `pipelines` enumerator now returns an `env` per pipeline — the union of `requiredEnv` over the kinds that pipeline schedules — and the supervisor builds each child's env subtractively: a pipeline loses every key a sibling pipeline declared and it did not. An intake pipeline's Slack token no longer reaches the work pipeline's child. Keys nobody declares flow to every pipeline exactly as before, and a tenant that declares nothing gets a byte-for-byte unchanged child env. Solo applies the same subtraction to the env its child inherits.

Declared keys are stripped from `installCommand`'s env and from prompt `!` expansions unconditionally, which closes a pre-existing leak of every `.env` value into the target repo's install hooks.

Every declared key of a pipeline's scheduled kinds is boot-checked for presence and non-blankness. A missing one fails that pipeline's child at startup naming the kind and the key, in the same posture as the prompt-file check; sibling pipelines boot. A kind switched on later against a key nobody set stays off with a logged error rather than taking the pipeline down. `phoebe doctor` reports the same shortfall as a tenant finding.

Reserved keys cannot be declared: `GH_TOKEN`, `PHOEBE_GH_LOGIN`, the four git identity variables, anything under `PHOEBE_*` or `GH_APP_*`, and any value of `providerEnv`. So is an `agentEnv` key the kind's `requiredEnv` does not list.

The `.env` reconcile digest is now computed per pipeline over the keys that pipeline would actually hold, so rotating a declared key relaunches only the pipelines that can see it; rotating an undeclared key still relaunches every pipeline of the tenant. The GitHub credential is untouched — leased per pipeline, cached per tenant, minted with the full grant.
