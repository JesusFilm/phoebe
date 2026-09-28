---
"phoebe-agent": minor
---

The relay's alert rule gains its second sink, and the companion becomes a device. An edge the relay crosses now goes out as an `alert` event on `GET /api/events` as well as to `RELAY_ALERT_WEBHOOK`, carrying the identical body — so a chat channel and a desktop notification can never say different things about the same deployment. The stream sink is not configurable, which is what makes an unset webhook mean "no webhook" rather than "no alerting".

The companion notifies off both arms. Relay deployments raise from the `alert` event; local installs raise for `wedged`, `crash-looping` and `doctor-fail`, with main running the same pure edge rule from `src/contracts/alerts.ts` over each local read rather than a second copy of it. The first read of an install seeds its state without notifying, so relaunching onto a fleet that was already wedged does not re-fire everything.

Each notification is tagged `<deployment or install>:<condition>`, so a clear replaces its raise in place and last night's dark is still on screen this morning saying it recovered. They are silent, suppressed while the window is focused, and clicking one brings the window forward on that install's page. The dock or taskbar badge counts deployments and local installs in a raised condition — subjects, not edges — and zero clears it. No tray item, no login item, and nothing is replayed on reconnect.

One preference, "desktop notifications", in the companion's `userData` beside the install list. Default on.

`phoebe-agent/contracts` gains `RELAY_EVENTS.alert`, `RelayAlertEvent` and `LocalAlertEvent`, and the desktop bridge grows `installs.alerts`.
