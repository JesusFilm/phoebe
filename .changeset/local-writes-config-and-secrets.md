---
"phoebe-agent": minor
---

Edits and secrets on a local install run against this machine, never through a relay, even when the install is also paired. `config set` and `secret set` join the host verbs as verb runs, so the companion starts one, watches its lines, and reads a typed outcome at the exit like any other.

`config set` carries the fingerprint the window was shown. An edit composed against a config a terminal has since changed is refused `stale` with the exact manual edit to make — the same receipt, and the same refusal rendering, as the arm that arrives over a relay. `runConfigSet` in `src/config-set.ts` is the verb behind both, with no argv and no stdout in it; the edit ledger is now optional, because the ledger answers a redelivered edit and a write on this machine has no delivery to repeat.

`secret set` takes `{ tenant, key, value }` as an in-memory run argument. The value is held for the run, is in no file the companion writes, and is echoed in no `run:line`. Two writers take it, chosen by what is there to write to: a running install's value goes through the container into the tenant secret store, and a stopped or freshly initialised one's goes into the deployment `.env` beside the config — which is where the first `GH_TOKEN` is typed. The outcome says which, because the two are not the same place.

`phoebe-agent/contracts` gains `SecretSetOutcome` and `SecretWriter`, and `HostVerb` gains the two write verbs with their outcomes. No envelope is built on this arm and both forms in the console say so: sealing a value so it can cross a server is work done to reach somewhere the companion is already standing.
