---
"phoebe-agent": minor
---

A pipeline no longer boots when the var `providerEnv` names for its provider is unset or blank. `phoebe doctor` reports the same thing per tenant, as a new `provider-key` check. Before, the agent got no key, and every unit died on `Not logged in` while boot and doctor both looked healthy. The provider is worked out per scheduled kind, so a kind block's `provider` and a `PHOEBE_AGENT` override both count. A Claude login at `~/.claude/.credentials.json` stands in for the key. Only presence is checked. Nothing tests whether the key works, and the value is never printed.
