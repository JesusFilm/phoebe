---
"phoebe-agent": minor
---

Bound a work kind's `run` under the whole-unit deadline (#359): the run budget now races against the entire `definition.run`, not just the agent spawn. A custom kind that hangs outside `ctx.agent.*` — an unbounded fetch, a poll loop, a `while (true)` — now triggers `RunTimeoutError`, releases its concurrency slot, and reaches the quarantine accounting path exactly like a built-in timeout. `WorkKindRunCtx` gains `signal: AbortSignal`, which fires when the budget expires; cooperative kinds pass it to async operations or poll `signal.aborted` to stop early. Each `ctx.agent.*` helper automatically passes the signal to the agent subprocess, so the child process is killed on expiry wherever in `run` the call sits.
