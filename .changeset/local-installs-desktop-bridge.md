---
"phoebe-agent": minor
---

The companion drives local installs: the desktop bridge carries the install list, the Docker check and the verb runs, and the console grows a "This machine" group and an install tab.

`phoebe-agent/contracts` gains the types both sides read — `LocalInstall`, `VerbRun`, `VerbRunRequest`, `CompanionEnvironment`, `MAX_RUN_LINES` and `CANCELLABLE_VERBS` — beside the `DesktopBridge` interface they hang off. Nothing in the package's own CLI behaviour changes.

Two engine-side changes come with it, both so the host verbs survive being bundled into another process: `resolvePackageResource` moves out of `src/init.ts` into `src/package-resource.ts`, and migration m001 reads its shipped prompt when it applies rather than when its module loads.
