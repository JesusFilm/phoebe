---
"phoebe-agent": minor
---

The companion notifies. Local installs raise for `wedged`, `crash-looping` and `doctor-fail`, with main running the pure edge rule from `src/contracts/alerts.ts` over each local read. The first read of an install seeds its state without notifying, so relaunching onto a fleet that was already wedged does not re-fire everything.

Each notification is tagged `<install>:<condition>`, so a clear replaces its raise in place. They are silent, suppressed while the window is focused, and clicking one brings the window forward on that install's page. The dock or taskbar badge counts local installs in a raised condition, subjects rather than edges, and zero clears it. No tray item and no login item.

One preference, "desktop notifications", in the companion's `userData` beside the install list. Default on.

`phoebe-agent/contracts` gains `LocalAlertEvent`, and the desktop bridge grows `installs.alerts`.
