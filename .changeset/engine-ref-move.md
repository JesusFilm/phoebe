---
"phoebe-agent": patch
---

Moving the engine ref from the companion froze the window. `upgrade` runs the incoming checkout's migrations by spawning `process.execPath` on its CLI, and inside the companion that binary is Electron, which opened the engine's TypeScript as an app while the window waited on it. The companion now fetches the checkout and runs its `phoebe migrate` as a streamed child of the run, as Node, with its lines in the cli tab and a cancel that reaches it. For the engine, `runUpgrade`'s `runMigrations` seam may now return a promise.
