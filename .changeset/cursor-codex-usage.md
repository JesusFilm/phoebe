---
"phoebe-agent": minor
---

Unit records now hold the usage Cursor and Codex runs report, in the same fields as Claude. A Cursor run records its input, output, cache and reasoning tokens, its model calls as turns, and its duration. It takes them from the total on the `result` line, or from the per-call `usage` lines when the total is missing. A Codex run records the tokens from `turn.completed`, with cached tokens taken out of `inputTokens` so that the field means uncached input for every provider. Neither CLI reports a cost, so `costUsd` and `costBasis` stay `null`. When a run's budget kills it, a Cursor run keeps the per-call usage written before the kill, marked `usageComplete: false`. A killed Codex run has no usage left to keep, so its usage is `null`. Tool calls are counted for both providers, capped at 32 names like Claude's.
