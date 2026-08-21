---
"phoebe-agent": patch
---

Extracts all cycle-gather logic from `src/main.ts` into `src/cycle-work-source.ts`
(`WorkSource` / `CycleRecord`) and wires `workSource.gatherCycle(fetchKinds)` into
`createEngine`'s run loop. The only behaviour change: issue bodies are now fetched through
a single cycle-scoped read-through cache (`Map<number, string>` local to each `gatherCycle`
call) instead of per-kind maps merged after the fact — fixing the duplicate-fetch bug (#290)
so the same body is never requested twice in one cycle regardless of how many kinds reference
the same PR.
