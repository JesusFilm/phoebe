---
"phoebe-agent": minor
---

Each pipeline now keeps a unit history in `state/<pipeline>/units.jsonl`. A unit that completes, fails or times out appends one record. The record names the provider, model and effort the unit ran on, its timing, its engine commit, and each agent run's prompt hash. For Claude it also holds the tokens, cost, turns, stop reason, models and tool calls the CLI reported. The cost is marked `subscription-estimate` under a subscription credential and `api` under an API key. A run its budget killed keeps the usage that survived, marked `usageComplete: false`. Past 1 MiB the file is renamed over `units.1.jsonl` and a new one started. A failed write is logged and never fails the unit. Cursor and Codex runs are recorded, but their usage stays `null` for now.
