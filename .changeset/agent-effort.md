---
"phoebe-agent": minor
---

Reasoning effort is now configurable per provider. `defaultEfforts` sits beside
`defaultModels` in `phoebe.config.ts` and is merged the same key-by-key way, so
`defaultEfforts: { claude: "low" }` sets a level without restating the rest;
`PHOEBE_EFFORT` overrides the active provider's entry for one run.

Only the `claude` provider maps it today — to `--effort`, one of `low`,
`medium`, `high`, `xhigh`, `max`. `cursor` and `codex` have no equivalent knob
and ignore it.

**Nothing changes for existing deployments.** The default is empty rather than a
level, so a provider with no entry is invoked with no effort flag at all and
keeps its CLI's own default — the behaviour before this change.
