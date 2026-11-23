---
"phoebe-agent": minor
---

The engine now refuses to boot a pipeline whose provider has no key, and `phoebe doctor` reports the same per tenant in a new `provider-key` check. The key is the env var `providerEnv` names for that provider. Before, an unset key reached the agent as nothing, and every unit died on `Not logged in` while boot and doctor both looked healthy. Both checks work out each scheduled kind's provider the way the engine does, so a kind block's `provider` and a `PHOEBE_AGENT` override count. A Claude login at `~/.claude/.credentials.json` stands in for the key. Neither check tests whether a key works, and doctor never prints one.
