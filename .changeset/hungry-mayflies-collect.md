---
"phoebe-agent": minor
---

Add the `phoebe-agent/contracts` subpath export: the pure-TypeScript types shared
by anything reading a deployment from outside the engine. A guard test walks
everything the subpath imports and fails on a Node built-in or a value import of
engine code, so the contracts stay loadable in a browser bundle. `StopOutcome` is
the first type to move there, re-exported from `src/stop.ts` unchanged.
